import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type {
  ClaimedStore,
  EnrichmentMetrics,
  JobProcessingSummary,
} from '../domain/enrichment.js';
import type { EnrichmentErrorCode } from '../errors/enrichment-error.js';

export interface AttemptFailure {
  code: EnrichmentErrorCode;
  message: string;
}

export type FailureResult =
  | { disposition: 'retry_wait'; nextAttemptAt: Date }
  | { disposition: 'failed' }
  | { disposition: 'stale' };

export interface RetryWakeup {
  nextRetryAt: Date;
  delayMs: number;
}

export interface EnrichmentRepository {
  findActiveJobId(): Promise<string | null>;
  startJob(jobId: string): Promise<boolean>;
  claimNextStore(jobId: string, leaseDurationMs: number): Promise<ClaimedStore | null>;
  completeStore(claim: ClaimedStore, metrics: EnrichmentMetrics): Promise<boolean>;
  recordAttemptFailure(
    claim: ClaimedStore,
    failure: AttemptFailure,
    retryDelayMs: number | null,
  ): Promise<FailureResult>;
  getNextRetryWakeup(jobId: string): Promise<RetryWakeup | null>;
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

export function createEnrichmentRepository(pool: Pool): EnrichmentRepository {
  return {
    async findActiveJobId() {
      const result = await pool.query<{ jobId: string }>(
        `SELECT id AS "jobId" FROM jobs
         WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT 1`,
      );
      return result.rows[0]?.jobId ?? null;
    },

    async startJob(jobId) {
      return withTransaction(pool, async (client) => {
        const locked = await client.query<{ status: string }>(
          'SELECT status FROM jobs WHERE id = $1 FOR UPDATE',
          [jobId],
        );
        const status = locked.rows[0]?.status;
        if (status === 'running') return true;
        if (status !== 'queued') return false;
        await client.query(
          `UPDATE jobs SET status = 'running', started_at = clock_timestamp()
           WHERE id = $1`,
          [jobId],
        );
        return true;
      });
    },

    async claimNextStore(jobId, leaseDurationMs) {
      return withTransaction(pool, async (client) => {
        const job = await client.query<{ status: string }>(
          'SELECT status FROM jobs WHERE id = $1 FOR UPDATE',
          [jobId],
        );
        if (job.rows[0]?.status !== 'running') return null;
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
             status = 'processing',
             attempt_count = attempt_count + 1,
             lease_token = gen_random_uuid(),
             lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
             next_attempt_at = NULL,
             last_error_code = NULL,
             last_error_message = NULL,
             updated_at = clock_timestamp()
           WHERE job_id = $1 AND store_id = $2
           RETURNING job_id AS "jobId", store_id AS "storeId", store_name AS "storeName",
             address, city, state, country, attempt_count AS "attemptCount",
             max_attempts AS "maxAttempts",
             lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt"`,
          [jobId, storeId, leaseDurationMs],
        );
        return claimed.rows[0] ?? null;
      });
    },

    async completeStore(claim, metrics) {
      return withTransaction(pool, async (client) => {
        const job = await client.query<{ status: string }>(
          'SELECT status FROM jobs WHERE id = $1 FOR UPDATE',
          [claim.jobId],
        );
        if (job.rows[0]?.status !== 'running') return false;
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
        return true;
      });
    },

    async recordAttemptFailure(claim, failure, retryDelayMs) {
      return withTransaction(pool, async (client) => {
        const job = await client.query<{ status: string }>(
          'SELECT status FROM jobs WHERE id = $1 FOR UPDATE',
          [claim.jobId],
        );
        if (job.rows[0]?.status !== 'running') return { disposition: 'stale' };
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
          return { disposition: 'retry_wait', nextAttemptAt: scheduled.rows[0]!.nextAttemptAt };
        }
        await client.query(
          `UPDATE job_stores SET status = 'failed', lease_token = NULL,
             lease_expires_at = NULL, next_attempt_at = NULL,
             last_error_code = $4, last_error_message = $5,
             updated_at = clock_timestamp()
           WHERE job_id = $1 AND store_id = $2 AND lease_token = $3`,
          [claim.jobId, claim.storeId, claim.leaseToken, failure.code, failure.message],
        );
        return { disposition: 'failed' };
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

    async finishJobIfDone(jobId) {
      return withTransaction(pool, async (client) => {
        const job = await client.query<{ status: string }>(
          'SELECT status FROM jobs WHERE id = $1 FOR UPDATE',
          [jobId],
        );
        if (job.rows[0]?.status !== 'running') return null;
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
        const counts = result.rows[0];
        if (!counts || counts.pending + counts.processing + counts.retryWait > 0) return null;
        const status =
          counts.failed === 0
            ? 'completed'
            : counts.succeeded > 0
              ? 'completed_with_errors'
              : 'failed';
        await client.query(
          `UPDATE jobs SET status = $2, finished_at = clock_timestamp(),
             failure_code = CASE WHEN $2 = 'failed' THEN 'NO_SUCCESSFUL_ENRICHMENTS' ELSE NULL END,
             failure_reason = CASE WHEN $2 = 'failed' THEN 'No stores were enriched successfully.' ELSE NULL END
           WHERE id = $1`,
          [jobId, status],
        );
        return {
          jobId,
          status,
          succeeded: counts.succeeded,
          failed: counts.failed,
          skipped: counts.skipped,
        };
      });
    },
  };
}
