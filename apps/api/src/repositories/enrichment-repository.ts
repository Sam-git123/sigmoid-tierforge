import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type {
  ClaimedStore,
  EnrichmentMetrics,
  JobProcessingSummary,
} from '../domain/enrichment.js';
import type { EnrichmentErrorCode } from '../errors/enrichment-error.js';

export type SystemicFailureImpact = 'none' | 'increment' | 'immediate';

export interface AttemptFailure {
  code: EnrichmentErrorCode;
  message: string;
  systemicImpact?: SystemicFailureImpact;
}

export type FailureResult =
  | { disposition: 'retry_wait'; nextAttemptAt: Date }
  | { disposition: 'failed' }
  | { disposition: 'job_failed' }
  | { disposition: 'stale' };

export interface RetryWakeup {
  nextRetryAt: Date;
  delayMs: number;
}

export type LeaseRecoveryResult =
  | { disposition: 'retry_wait'; storeId: string; nextAttemptAt: Date }
  | { disposition: 'failed'; storeId: string }
  | { disposition: 'job_failed'; storeId: string };

export interface EnrichmentRepository {
  findActiveJobId(): Promise<string | null>;
  findActiveJobIds(): Promise<string[]>;
  startJob(jobId: string): Promise<boolean>;
  claimNextStore(jobId: string, leaseDurationMs: number): Promise<ClaimedStore | null>;
  claimNextStoreAcrossJobs(
    leaseDurationMs: number,
    maxProcessing: number,
  ): Promise<ClaimedStore | null>;
  isClaimCurrent(claim: ClaimedStore): Promise<boolean>;
  completeStore(claim: ClaimedStore, metrics: EnrichmentMetrics): Promise<boolean>;
  recordAttemptFailure(
    claim: ClaimedStore,
    failure: AttemptFailure,
    retryDelayMs: number | null,
    systemicFailureStreak?: number,
  ): Promise<FailureResult>;
  reclaimExpiredLease(
    jobId: string,
    retryDelayForAttempt: (attemptNumber: number) => number,
    systemicFailureStreak: number,
  ): Promise<LeaseRecoveryResult | null>;
  getNextRetryWakeup(jobId: string): Promise<RetryWakeup | null>;
  getNextRetryWakeupAcrossJobs(): Promise<RetryWakeup | null>;
  finishJobIfDone(jobId: string): Promise<JobProcessingSummary | null>;
}

interface CountRow {
  pending: number;
  processing: number;
  retryWait: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

interface LockedJob {
  status: string;
  providerFailureStreak: number;
}

const systemicFailureCode = 'SYSTEMIC_PROVIDER_FAILURE';
const systemicFailureReason =
  'Enrichment stopped after the configured consecutive provider-failure threshold was reached.';
const abortedStoreReason = 'Skipped because the enrichment provider was systemically failing.';

async function lockJob(client: PoolClient, jobId: string): Promise<LockedJob | null> {
  const result = await client.query<LockedJob>(
    `SELECT status, provider_failure_streak AS "providerFailureStreak"
     FROM jobs WHERE id = $1 FOR UPDATE`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

async function abortSystemically(client: PoolClient, jobId: string): Promise<void> {
  await client.query(
    `UPDATE job_stores SET status = 'skipped', next_attempt_at = NULL,
       lease_token = NULL, lease_expires_at = NULL,
       last_error_code = 'JOB_ABORTED_SYSTEMIC_FAILURE',
       last_error_message = $2, updated_at = clock_timestamp()
     WHERE job_id = $1 AND status IN ('pending', 'processing', 'retry_wait')`,
    [jobId, abortedStoreReason],
  );
  await client.query(
    `UPDATE jobs SET status = 'failed', finished_at = clock_timestamp(),
       failure_code = $2, failure_reason = $3
     WHERE id = $1 AND status = 'running'`,
    [jobId, systemicFailureCode, systemicFailureReason],
  );
}

async function applySystemicImpact(
  client: PoolClient,
  jobId: string,
  impact: SystemicFailureImpact,
  threshold: number,
): Promise<boolean> {
  if (impact === 'none') return false;
  if (impact === 'immediate') {
    await abortSystemically(client, jobId);
    return true;
  }
  const updated = await client.query<{ streak: number }>(
    `UPDATE jobs SET provider_failure_streak = provider_failure_streak + 1
     WHERE id = $1 AND status = 'running'
     RETURNING provider_failure_streak AS streak`,
    [jobId],
  );
  if ((updated.rows[0]?.streak ?? 0) < threshold) return false;
  await abortSystemically(client, jobId);
  return true;
}

async function countStores(client: PoolClient, jobId: string): Promise<CountRow> {
  const result = await client.query<CountRow>(
    `SELECT
       (count(*) FILTER (WHERE status = 'pending'))::integer AS pending,
       (count(*) FILTER (WHERE status = 'processing'))::integer AS processing,
       (count(*) FILTER (WHERE status = 'retry_wait'))::integer AS "retryWait",
       (count(*) FILTER (WHERE status = 'succeeded'))::integer AS succeeded,
       (count(*) FILTER (WHERE status = 'failed'))::integer AS failed,
       (count(*) FILTER (WHERE status = 'skipped'))::integer AS skipped
     FROM job_stores WHERE job_id = $1`,
    [jobId],
  );
  return result.rows[0]!;
}

function summary(jobId: string, status: JobProcessingSummary['status'], counts: CountRow) {
  return {
    jobId,
    status,
    succeeded: counts.succeeded,
    failed: counts.failed,
    skipped: counts.skipped,
  };
}

export function createEnrichmentRepository(pool: Pool): EnrichmentRepository {
  return {
    async findActiveJobId() {
      const result = await pool.query<{ jobId: string }>(
        `SELECT id AS "jobId" FROM jobs
         WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT 1`,
      );
      return result.rows[0]?.jobId ?? null;
    },

    async findActiveJobIds() {
      const result = await pool.query<{ jobId: string }>(
        `SELECT id AS "jobId" FROM jobs
         WHERE status IN ('queued', 'running') ORDER BY created_at, id`,
      );
      return result.rows.map((row) => row.jobId);
    },

    async startJob(jobId) {
      return withTransaction(pool, async (client) => {
        const locked = await lockJob(client, jobId);
        if (locked?.status === 'running') return true;
        if (locked?.status !== 'queued') return false;
        await client.query(
          `UPDATE jobs SET status = 'running', started_at = clock_timestamp()
           WHERE id = $1 AND status = 'queued'`,
          [jobId],
        );
        return true;
      });
    },

    async claimNextStore(jobId, leaseDurationMs) {
      return withTransaction(pool, async (client) => {
        const job = await lockJob(client, jobId);
        if (job?.status !== 'running') return null;
        const selected = await client.query<{ storeId: string }>(
          `SELECT store_id AS "storeId" FROM job_stores
           WHERE job_id = $1 AND attempt_count < max_attempts
             AND (status = 'pending'
               OR (status = 'retry_wait' AND next_attempt_at <= clock_timestamp()))
           ORDER BY COALESCE(next_attempt_at, created_at), store_id
           FOR UPDATE SKIP LOCKED LIMIT 1`,
          [jobId],
        );
        const storeId = selected.rows[0]?.storeId;
        if (!storeId) return null;
        const claimed = await client.query<ClaimedStore>(
          `UPDATE job_stores SET
             status = 'processing', attempt_count = attempt_count + 1,
             lease_token = gen_random_uuid(),
             lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
             next_attempt_at = NULL, last_error_code = NULL, last_error_message = NULL,
             updated_at = clock_timestamp()
           WHERE job_id = $1 AND store_id = $2
           RETURNING job_id AS "jobId", store_id AS "storeId", store_name AS "storeName",
             address, city, state, country, attempt_count AS "attemptCount",
             max_attempts AS "maxAttempts", lease_token AS "leaseToken",
             lease_expires_at AS "leaseExpiresAt"`,
          [jobId, storeId, leaseDurationMs],
        );
        return claimed.rows[0] ?? null;
      });
    },

    async claimNextStoreAcrossJobs(leaseDurationMs, maxProcessing) {
      return withTransaction(pool, async (client) => {
        // Serialize only the short global scheduling decision. This makes the
        // configured concurrency a database-wide limit across API processes.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('tierforge:global-claim'))");
        const processing = await client.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM job_stores
           WHERE status = 'processing' AND lease_expires_at > clock_timestamp()`,
        );
        if ((processing.rows[0]?.count ?? 0) >= maxProcessing) return null;

        const selectedJob = await client.query<{ jobId: string; status: string }>(
          `SELECT j.id AS "jobId", j.status
           FROM jobs j
           WHERE j.status IN ('queued', 'running')
             AND EXISTS (
               SELECT 1 FROM job_stores s
               WHERE s.job_id = j.id AND s.attempt_count < s.max_attempts
                 AND (s.status = 'pending'
                   OR (s.status = 'retry_wait' AND s.next_attempt_at <= clock_timestamp()))
             )
           ORDER BY j.scheduler_last_claimed_at NULLS FIRST, j.created_at, j.id
           FOR UPDATE OF j SKIP LOCKED
           LIMIT 1`,
        );
        const job = selectedJob.rows[0];
        if (!job) return null;
        if (job.status === 'queued') {
          await client.query(
            `UPDATE jobs SET status = 'running', started_at = clock_timestamp()
             WHERE id = $1 AND status = 'queued'`,
            [job.jobId],
          );
        }
        const selectedStore = await client.query<{ storeId: string }>(
          `SELECT store_id AS "storeId" FROM job_stores
           WHERE job_id = $1 AND attempt_count < max_attempts
             AND (status = 'pending'
               OR (status = 'retry_wait' AND next_attempt_at <= clock_timestamp()))
           ORDER BY COALESCE(next_attempt_at, created_at), store_id
           FOR UPDATE SKIP LOCKED LIMIT 1`,
          [job.jobId],
        );
        const storeId = selectedStore.rows[0]?.storeId;
        if (!storeId) return null;
        const claimed = await client.query<ClaimedStore>(
          `UPDATE job_stores SET
             status = 'processing', attempt_count = attempt_count + 1,
             lease_token = gen_random_uuid(),
             lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
             next_attempt_at = NULL, last_error_code = NULL, last_error_message = NULL,
             updated_at = clock_timestamp()
           WHERE job_id = $1 AND store_id = $2
           RETURNING job_id AS "jobId", store_id AS "storeId", store_name AS "storeName",
             address, city, state, country, attempt_count AS "attemptCount",
             max_attempts AS "maxAttempts", lease_token AS "leaseToken",
             lease_expires_at AS "leaseExpiresAt"`,
          [job.jobId, storeId, leaseDurationMs],
        );
        await client.query(
          `UPDATE jobs SET scheduler_last_claimed_at = clock_timestamp() WHERE id = $1`,
          [job.jobId],
        );
        return claimed.rows[0] ?? null;
      });
    },

    async isClaimCurrent(claim) {
      const result = await pool.query(
        `SELECT 1 FROM jobs j JOIN job_stores s ON s.job_id = j.id
         WHERE j.id = $1 AND j.status = 'running'
           AND s.store_id = $2 AND s.status = 'processing'
           AND s.lease_token = $3 AND s.lease_expires_at > clock_timestamp()`,
        [claim.jobId, claim.storeId, claim.leaseToken],
      );
      return result.rowCount === 1;
    },

    async completeStore(claim, metrics) {
      return withTransaction(pool, async (client) => {
        const job = await lockJob(client, claim.jobId);
        if (job?.status !== 'running') return false;
        const owned = await client.query(
          `SELECT 1 FROM job_stores
           WHERE job_id = $1 AND store_id = $2 AND status = 'processing'
             AND lease_token = $3 AND lease_expires_at > clock_timestamp()
           FOR UPDATE`,
          [claim.jobId, claim.storeId, claim.leaseToken],
        );
        if (owned.rowCount !== 1) return false;
        await client.query(
          `INSERT INTO store_enrichments
             (job_id, store_id, estimated_monthly_footfall, estimated_monthly_revenue, store_size_sqft)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            claim.jobId,
            claim.storeId,
            metrics.estimatedMonthlyFootfall,
            metrics.estimatedMonthlyRevenue,
            metrics.storeSizeSqft,
          ],
        );
        await client.query(
          `UPDATE job_stores SET status = 'succeeded', lease_token = NULL,
             lease_expires_at = NULL, updated_at = clock_timestamp()
           WHERE job_id = $1 AND store_id = $2`,
          [claim.jobId, claim.storeId],
        );
        await client.query(
          `UPDATE jobs SET provider_failure_streak = 0
           WHERE id = $1 AND status = 'running'`,
          [claim.jobId],
        );
        return true;
      });
    },

    async recordAttemptFailure(claim, failure, retryDelayMs, systemicFailureStreak = 30) {
      return withTransaction(pool, async (client) => {
        const job = await lockJob(client, claim.jobId);
        if (job?.status !== 'running') return { disposition: 'stale' };
        const owned = await client.query<{ attemptCount: number; maxAttempts: number }>(
          `SELECT attempt_count AS "attemptCount", max_attempts AS "maxAttempts"
           FROM job_stores
           WHERE job_id = $1 AND store_id = $2 AND status = 'processing'
             AND lease_token = $3 AND lease_expires_at > clock_timestamp()
           FOR UPDATE`,
          [claim.jobId, claim.storeId, claim.leaseToken],
        );
        const current = owned.rows[0];
        if (!current) return { disposition: 'stale' };
        let result: FailureResult;
        if (retryDelayMs !== null && current.attemptCount < current.maxAttempts) {
          const scheduled = await client.query<{ nextAttemptAt: Date }>(
            `UPDATE job_stores SET status = 'retry_wait', lease_token = NULL,
               lease_expires_at = NULL,
               next_attempt_at = clock_timestamp() + ($4 * interval '1 millisecond'),
               last_error_code = $5, last_error_message = $6,
               updated_at = clock_timestamp()
             WHERE job_id = $1 AND store_id = $2 AND lease_token = $3
             RETURNING next_attempt_at AS "nextAttemptAt"`,
            [
              claim.jobId,
              claim.storeId,
              claim.leaseToken,
              retryDelayMs,
              failure.code,
              failure.message,
            ],
          );
          result = {
            disposition: 'retry_wait',
            nextAttemptAt: scheduled.rows[0]!.nextAttemptAt,
          };
        } else {
          await client.query(
            `UPDATE job_stores SET status = 'failed', lease_token = NULL,
               lease_expires_at = NULL, next_attempt_at = NULL,
               last_error_code = $4, last_error_message = $5,
               updated_at = clock_timestamp()
             WHERE job_id = $1 AND store_id = $2 AND lease_token = $3`,
            [claim.jobId, claim.storeId, claim.leaseToken, failure.code, failure.message],
          );
          result = { disposition: 'failed' };
        }
        if (
          await applySystemicImpact(
            client,
            claim.jobId,
            failure.systemicImpact ?? 'none',
            systemicFailureStreak,
          )
        ) {
          return { disposition: 'job_failed' };
        }
        return result;
      });
    },

    async reclaimExpiredLease(jobId, retryDelayForAttempt, systemicFailureStreak) {
      return withTransaction(pool, async (client) => {
        const job = await lockJob(client, jobId);
        if (job?.status !== 'running') return null;
        const expired = await client.query<{
          storeId: string;
          attemptCount: number;
          maxAttempts: number;
          leaseToken: string;
        }>(
          `SELECT store_id AS "storeId", attempt_count AS "attemptCount",
             max_attempts AS "maxAttempts", lease_token AS "leaseToken"
           FROM job_stores
           WHERE job_id = $1 AND status = 'processing'
             AND lease_expires_at <= clock_timestamp()
           ORDER BY lease_expires_at, store_id
           FOR UPDATE SKIP LOCKED LIMIT 1`,
          [jobId],
        );
        const row = expired.rows[0];
        if (!row) return null;
        let result: LeaseRecoveryResult;
        if (row.attemptCount < row.maxAttempts) {
          const retryDelayMs = retryDelayForAttempt(row.attemptCount);
          const scheduled = await client.query<{ nextAttemptAt: Date }>(
            `UPDATE job_stores SET status = 'retry_wait', lease_token = NULL,
               lease_expires_at = NULL,
               next_attempt_at = clock_timestamp() + ($4 * interval '1 millisecond'),
               last_error_code = 'LEASE_EXPIRED',
               last_error_message = 'Worker lease expired before the attempt completed.',
               updated_at = clock_timestamp()
             WHERE job_id = $1 AND store_id = $2 AND status = 'processing'
               AND lease_token = $3 AND lease_expires_at <= clock_timestamp()
             RETURNING next_attempt_at AS "nextAttemptAt"`,
            [jobId, row.storeId, row.leaseToken, retryDelayMs],
          );
          if (!scheduled.rows[0]) return null;
          result = {
            disposition: 'retry_wait',
            storeId: row.storeId,
            nextAttemptAt: scheduled.rows[0].nextAttemptAt,
          };
        } else {
          const failed = await client.query(
            `UPDATE job_stores SET status = 'failed', lease_token = NULL,
               lease_expires_at = NULL, next_attempt_at = NULL,
               last_error_code = 'RETRY_EXHAUSTED',
               last_error_message = $4, updated_at = clock_timestamp()
             WHERE job_id = $1 AND store_id = $2 AND status = 'processing'
               AND lease_token = $3 AND lease_expires_at <= clock_timestamp()`,
            [
              jobId,
              row.storeId,
              row.leaseToken,
              `Lease expired on final attempt ${row.attemptCount} of ${row.maxAttempts}.`,
            ],
          );
          if (failed.rowCount !== 1) return null;
          result = { disposition: 'failed', storeId: row.storeId };
        }
        if (await applySystemicImpact(client, jobId, 'increment', systemicFailureStreak)) {
          return { disposition: 'job_failed', storeId: row.storeId };
        }
        return result;
      });
    },

    async getNextRetryWakeup(jobId) {
      const result = await pool.query<{ nextRetryAt: Date | null; delayMs: number | null }>(
        `SELECT min(next_attempt_at) AS "nextRetryAt",
           greatest(0, extract(epoch FROM (min(next_attempt_at) - clock_timestamp())) * 1000)
             ::double precision AS "delayMs"
         FROM job_stores WHERE job_id = $1 AND status = 'retry_wait'`,
        [jobId],
      );
      const row = result.rows[0];
      if (!row?.nextRetryAt || row.delayMs === null) return null;
      return { nextRetryAt: row.nextRetryAt, delayMs: row.delayMs };
    },

    async getNextRetryWakeupAcrossJobs() {
      const result = await pool.query<{ nextRetryAt: Date | null; delayMs: number | null }>(
        `SELECT min(s.next_attempt_at) AS "nextRetryAt",
           greatest(0, extract(epoch FROM (min(s.next_attempt_at) - clock_timestamp())) * 1000)
             ::double precision AS "delayMs"
         FROM job_stores s JOIN jobs j ON j.id = s.job_id
         WHERE j.status = 'running' AND s.status = 'retry_wait'`,
      );
      const row = result.rows[0];
      if (!row?.nextRetryAt || row.delayMs === null) return null;
      return { nextRetryAt: row.nextRetryAt, delayMs: row.delayMs };
    },

    async finishJobIfDone(jobId) {
      return withTransaction(pool, async (client) => {
        const job = await lockJob(client, jobId);
        if (!job) return null;
        const counts = await countStores(client, jobId);
        if (['completed', 'completed_with_errors', 'failed'].includes(job.status)) {
          return summary(jobId, job.status as JobProcessingSummary['status'], counts);
        }
        if (job.status !== 'running') return null;
        if (counts.pending + counts.processing + counts.retryWait > 0) return null;
        const status: JobProcessingSummary['status'] =
          counts.failed === 0 && counts.skipped === 0
            ? 'completed'
            : counts.succeeded > 0
              ? 'completed_with_errors'
              : 'failed';
        await client.query(
          `UPDATE jobs SET status = $2, finished_at = clock_timestamp(),
             failure_code = CASE WHEN $2 = 'failed' THEN 'NO_SUCCESSFUL_ENRICHMENTS' ELSE NULL END,
             failure_reason = CASE WHEN $2 = 'failed' THEN 'No stores were enriched successfully.' ELSE NULL END
           WHERE id = $1 AND status = 'running'`,
          [jobId, status],
        );
        return summary(jobId, status, counts);
      });
    },
  };
}
