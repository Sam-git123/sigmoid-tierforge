import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createEnrichmentClient, type EnrichmentClient } from '../src/clients/enrichment-client.js';
import type { StoreInput } from '../src/domain/jobs.js';
import { EnrichmentAttemptError } from '../src/errors/enrichment-error.js';
import { createLogger } from '../src/logging/logger.js';
import { createEnrichmentRepository } from '../src/repositories/enrichment-repository.js';
import { createHealthRepository } from '../src/repositories/health-repository.js';
import { createJobRepository } from '../src/repositories/job-repository.js';
import { createJobService } from '../src/services/job-service.js';
import { createCoordinator } from '../src/workers/coordinator.js';
import { createTestDatabase } from './helpers/test-database.js';

const connectionString = process.env.TEST_DATABASE_URL;
const logger = createLogger('silent');
const store = (storeId: string): StoreInput => ({
  store_id: storeId,
  store_name: `Store ${storeId}`,
  address: '1 Main Street',
  city: 'City',
  state: 'State',
  country: 'Country',
});

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for background processing');
}

describe.skipIf(!connectionString)('enrichment engine with PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    if (!connectionString) throw new Error('TEST_DATABASE_URL required');
    database = await createTestDatabase(connectionString);
  });
  beforeEach(async () => database.reset());
  afterAll(async () => database?.close());

  async function createRunningJob(storeIds: string[]) {
    const job = await createJobRepository(database.pool).createJobWithStores(
      storeIds.map(store),
      4,
    );
    const repository = createEnrichmentRepository(database.pool);
    expect(await repository.startJob(job.jobId)).toBe(true);
    return { job, repository };
  }

  it('claims pending work with a lease and increments the attempt atomically', async () => {
    const { job, repository } = await createRunningJob(['S1']);
    const claimed = await repository.claimNextStore(job.jobId, 20_000);
    expect(claimed).toMatchObject({
      jobId: job.jobId,
      storeId: 'S1',
      attemptCount: 1,
      maxAttempts: 4,
    });
    expect(claimed?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed!.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await repository.claimNextStore(job.jobId, 20_000)).toBeNull();
    const persisted = (
      await database.pool.query(
        'SELECT status, attempt_count, lease_token FROM job_stores WHERE job_id = $1',
        [job.jobId],
      )
    ).rows[0];
    expect(persisted).toMatchObject({ status: 'processing', attempt_count: 1 });
    expect(persisted.lease_token).toBe(claimed?.leaseToken);
  });

  it('prevents two concurrent workers from owning the same store', async () => {
    const { job, repository } = await createRunningJob(['S1']);
    const claims = await Promise.all([
      repository.claimNextStore(job.jobId, 20_000),
      repository.claimNextStore(job.jobId, 20_000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });

  it('persists metrics and success together while rejecting stale or duplicate completion', async () => {
    const { job, repository } = await createRunningJob(['S1']);
    const claimed = await repository.claimNextStore(job.jobId, 20_000);
    if (!claimed) throw new Error('Expected a claim');
    const metrics = {
      estimatedMonthlyFootfall: 18234,
      estimatedMonthlyRevenue: 142033.5,
      storeSizeSqft: 6210,
    };
    expect(await repository.completeStore({ ...claimed, leaseToken: randomUUID() }, metrics)).toBe(
      false,
    );
    expect(await repository.completeStore(claimed, metrics)).toBe(true);
    expect(await repository.completeStore(claimed, metrics)).toBe(false);
    const result = await database.pool.query(
      `SELECT s.status, s.lease_token, e.estimated_monthly_footfall,
         e.estimated_monthly_revenue, e.store_size_sqft
       FROM job_stores s JOIN store_enrichments e USING (job_id, store_id)
       WHERE s.job_id = $1 AND s.store_id = 'S1'`,
      [job.jobId],
    );
    expect(result.rows).toEqual([
      {
        status: 'succeeded',
        lease_token: null,
        estimated_monthly_footfall: '18234.00',
        estimated_monthly_revenue: '142033.50',
        store_size_sqft: '6210.00',
      },
    ]);
    expect(
      (await database.pool.query('SELECT count(*)::int AS count FROM store_enrichments')).rows[0]
        .count,
    ).toBe(1);
  });

  it('rejects completion after lease expiry without writing metrics', async () => {
    const { job, repository } = await createRunningJob(['S1']);
    const claimed = await repository.claimNextStore(job.jobId, 20_000);
    if (!claimed) throw new Error('Expected a claim');
    await database.pool.query(
      `UPDATE job_stores SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE job_id = $1 AND store_id = 'S1'`,
      [job.jobId],
    );
    expect(
      await repository.completeStore(claimed, {
        estimatedMonthlyFootfall: 1,
        estimatedMonthlyRevenue: 2,
        storeSizeSqft: 3,
      }),
    ).toBe(false);
    expect(
      (await database.pool.query('SELECT count(*)::int AS count FROM store_enrichments')).rows[0]
        .count,
    ).toBe(0);
  });

  it('persists retry timing and claims retry_wait only after it is due', async () => {
    const { job, repository } = await createRunningJob(['S1']);
    const first = await repository.claimNextStore(job.jobId, 20_000);
    if (!first) throw new Error('Expected a claim');
    const before = Date.now();
    const scheduled = await repository.recordAttemptFailure(
      first,
      { code: 'PROVIDER_ERROR', message: 'Enrichment API returned HTTP 500.' },
      500,
    );
    expect(scheduled.disposition).toBe('retry_wait');
    if (scheduled.disposition !== 'retry_wait') throw new Error('Expected retry scheduling');
    expect(scheduled.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 450);
    expect(await repository.getNextRetryWakeup(job.jobId)).toMatchObject({
      nextRetryAt: scheduled.nextAttemptAt,
    });
    expect(await repository.claimNextStore(job.jobId, 20_000)).toBeNull();
    const waiting = (
      await database.pool.query(
        `SELECT status, attempt_count, next_attempt_at, lease_token, last_error_code
         FROM job_stores WHERE job_id = $1`,
        [job.jobId],
      )
    ).rows[0];
    expect(waiting).toMatchObject({
      status: 'retry_wait',
      attempt_count: 1,
      lease_token: null,
      last_error_code: 'PROVIDER_ERROR',
    });
    await database.pool.query(
      `UPDATE job_stores SET next_attempt_at = clock_timestamp() - interval '1 millisecond'
       WHERE job_id = $1`,
      [job.jobId],
    );
    const second = await repository.claimNextStore(job.jobId, 20_000);
    expect(second).toMatchObject({ storeId: 'S1', attemptCount: 2, maxAttempts: 4 });
    expect(second?.leaseToken).not.toBe(first.leaseToken);
  });

  it('rejects stale success and stale failure after a retry has succeeded', async () => {
    const { job, repository } = await createRunningJob(['S1']);
    const first = await repository.claimNextStore(job.jobId, 20_000);
    if (!first) throw new Error('Expected the first claim');
    await repository.recordAttemptFailure(
      first,
      { code: 'TIMEOUT', message: 'Enrichment request timed out.' },
      0,
    );
    const second = await repository.claimNextStore(job.jobId, 20_000);
    if (!second) throw new Error('Expected the retry claim');
    const acceptedMetrics = {
      estimatedMonthlyFootfall: 20,
      estimatedMonthlyRevenue: 200,
      storeSizeSqft: 2000,
    };
    expect(await repository.completeStore(second, acceptedMetrics)).toBe(true);
    expect(
      await repository.completeStore(first, {
        estimatedMonthlyFootfall: 10,
        estimatedMonthlyRevenue: 100,
        storeSizeSqft: 1000,
      }),
    ).toBe(false);
    await expect(
      repository.recordAttemptFailure(
        first,
        { code: 'NETWORK_ERROR', message: 'Late network failure.' },
        1000,
      ),
    ).resolves.toEqual({ disposition: 'stale' });
    const persisted = (
      await database.pool.query(
        `SELECT s.status, s.attempt_count, e.estimated_monthly_footfall
         FROM job_stores s JOIN store_enrichments e USING (job_id, store_id)
         WHERE s.job_id = $1`,
        [job.jobId],
      )
    ).rows[0];
    expect(persisted).toEqual({
      status: 'succeeded',
      attempt_count: 2,
      estimated_monthly_footfall: '20.00',
    });
  });

  it('admits only one of two simultaneous completion attempts', async () => {
    const { job, repository } = await createRunningJob(['S1']);
    const claimed = await repository.claimNextStore(job.jobId, 20_000);
    if (!claimed) throw new Error('Expected a claim');
    const results = await Promise.all([
      repository.completeStore(claimed, {
        estimatedMonthlyFootfall: 1,
        estimatedMonthlyRevenue: 2,
        storeSizeSqft: 3,
      }),
      repository.completeStore(claimed, {
        estimatedMonthlyFootfall: 4,
        estimatedMonthlyRevenue: 5,
        storeSizeSqft: 6,
      }),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(
      (await database.pool.query('SELECT count(*)::int AS count FROM store_enrichments')).rows[0]
        .count,
    ).toBe(1);
  });

  it('runs a persisted 500 retry through the coordinator and then succeeds', async () => {
    const job = await createJobRepository(database.pool).createJobWithStores([store('S1')], 3);
    const client: EnrichmentClient = {
      enrich: vi
        .fn()
        .mockRejectedValueOnce(
          new EnrichmentAttemptError({
            code: 'PROVIDER_ERROR',
            message: 'Enrichment API returned HTTP 500.',
            retryable: true,
            status: 500,
          }),
        )
        .mockResolvedValueOnce({
          estimatedMonthlyFootfall: 10,
          estimatedMonthlyRevenue: 20,
          storeSizeSqft: 30,
        }),
    };
    const coordinator = createCoordinator({
      repository: createEnrichmentRepository(database.pool),
      client,
      rateLimiter: { waitForSlot: vi.fn().mockResolvedValue(undefined), deferFor: vi.fn() },
      logger,
      concurrency: 2,
      leaseDurationMs: 20_000,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      random: () => 1,
    });
    try {
      await coordinator.start();
      await waitUntil(async () => {
        const result = await database.pool.query('SELECT status FROM jobs WHERE id = $1', [
          job.jobId,
        ]);
        return result.rows[0]?.status === 'completed';
      });
      expect(client.enrich).toHaveBeenCalledTimes(2);
      expect(
        (
          await database.pool.query(
            'SELECT status, attempt_count, last_error_code FROM job_stores WHERE job_id = $1',
            [job.jobId],
          )
        ).rows[0],
      ).toEqual({ status: 'succeeded', attempt_count: 2, last_error_code: null });
    } finally {
      await coordinator.stop();
    }
  });

  it('stops at the configured attempt limit with a meaningful exhausted reason', async () => {
    const job = await createJobRepository(database.pool).createJobWithStores([store('S1')], 2);
    const client: EnrichmentClient = {
      enrich: vi.fn().mockRejectedValue(
        new EnrichmentAttemptError({
          code: 'PROVIDER_ERROR',
          message: 'Enrichment API returned HTTP 500.',
          retryable: true,
          status: 500,
        }),
      ),
    };
    const coordinator = createCoordinator({
      repository: createEnrichmentRepository(database.pool),
      client,
      rateLimiter: { waitForSlot: vi.fn().mockResolvedValue(undefined), deferFor: vi.fn() },
      logger,
      concurrency: 1,
      leaseDurationMs: 20_000,
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 20,
      random: () => 1,
    });
    try {
      await coordinator.start();
      await waitUntil(async () => {
        const result = await database.pool.query('SELECT status FROM jobs WHERE id = $1', [
          job.jobId,
        ]);
        return result.rows[0]?.status === 'failed';
      });
      expect(client.enrich).toHaveBeenCalledTimes(2);
      expect(
        (
          await database.pool.query(
            `SELECT status, attempt_count, last_error_code, last_error_message
             FROM job_stores WHERE job_id = $1`,
            [job.jobId],
          )
        ).rows[0],
      ).toEqual({
        status: 'failed',
        attempt_count: 2,
        last_error_code: 'RETRY_EXHAUSTED',
        last_error_message:
          'Retry attempts exhausted after 2 attempts. Last error: PROVIDER_ERROR - Enrichment API returned HTTP 500.',
      });
    } finally {
      await coordinator.stop();
    }
  });

  it('ignores a transport response that resolves after timeout and retry success', async () => {
    const job = await createJobRepository(database.pool).createJobWithStores([store('S1')], 3);
    let resolveLate!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveLate = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            store_id: 'S1',
            estimated_monthly_footfall: 20,
            estimated_monthly_revenue: 200,
            store_size_sqft: 2000,
          }),
          { status: 200 },
        ),
      );
    const coordinator = createCoordinator({
      repository: createEnrichmentRepository(database.pool),
      client: createEnrichmentClient({
        baseUrl: 'http://127.0.0.1:8000',
        timeoutMs: 10,
        fetch: fetcher,
      }),
      rateLimiter: { waitForSlot: vi.fn().mockResolvedValue(undefined), deferFor: vi.fn() },
      logger,
      concurrency: 1,
      leaseDurationMs: 20_000,
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 20,
      random: () => 1,
    });
    try {
      await coordinator.start();
      await waitUntil(async () => {
        const result = await database.pool.query('SELECT status FROM jobs WHERE id = $1', [
          job.jobId,
        ]);
        return result.rows[0]?.status === 'completed';
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      resolveLate(
        new Response(
          JSON.stringify({
            store_id: 'S1',
            estimated_monthly_footfall: 999,
            estimated_monthly_revenue: 999,
            store_size_sqft: 999,
          }),
          { status: 200 },
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        (
          await database.pool.query(
            `SELECT s.status, s.attempt_count, e.estimated_monthly_footfall,
               e.estimated_monthly_revenue, e.store_size_sqft
             FROM job_stores s JOIN store_enrichments e USING (job_id, store_id)
             WHERE s.job_id = $1`,
            [job.jobId],
          )
        ).rows,
      ).toEqual([
        {
          status: 'succeeded',
          attempt_count: 2,
          estimated_monthly_footfall: '20.00',
          estimated_monthly_revenue: '200.00',
          store_size_sqft: '2000.00',
        },
      ]);
    } finally {
      await coordinator.stop();
    }
  });

  it('finalizes a mixed result as completed with errors', async () => {
    const { job, repository } = await createRunningJob(['S1', 'S2']);
    const first = await repository.claimNextStore(job.jobId, 20_000);
    const second = await repository.claimNextStore(job.jobId, 20_000);
    if (!first || !second) throw new Error('Expected two claims');
    expect(
      await repository.completeStore(first, {
        estimatedMonthlyFootfall: 1,
        estimatedMonthlyRevenue: 2,
        storeSizeSqft: 3,
      }),
    ).toBe(true);
    expect(
      await repository.recordAttemptFailure(
        second,
        {
          code: 'PERMANENT_ERROR',
          message: 'Enrichment API returned HTTP 400.',
        },
        null,
      ),
    ).toEqual({ disposition: 'failed' });
    await expect(repository.finishJobIfDone(job.jobId)).resolves.toEqual({
      jobId: job.jobId,
      status: 'completed_with_errors',
      succeeded: 1,
      failed: 1,
      skipped: 0,
    });
    const persisted = (
      await database.pool.query(
        'SELECT status, finished_at, failure_code, failure_reason FROM jobs WHERE id = $1',
        [job.jobId],
      )
    ).rows[0];
    expect(persisted.status).toBe('completed_with_errors');
    expect(persisted.finished_at).toBeInstanceOf(Date);
    expect(persisted.failure_code).toBeNull();
    expect(persisted.failure_reason).toBeNull();
  });

  it('returns the upload response before a controlled enrichment call completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: EnrichmentClient = {
      enrich: vi.fn(async () => {
        await gate;
        return {
          estimatedMonthlyFootfall: 10,
          estimatedMonthlyRevenue: 20,
          storeSizeSqft: 30,
        };
      }),
    };
    const coordinator = createCoordinator({
      repository: createEnrichmentRepository(database.pool),
      client,
      rateLimiter: { waitForSlot: vi.fn().mockResolvedValue(undefined), deferFor: vi.fn() },
      logger,
      concurrency: 2,
      leaseDurationMs: 20_000,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      random: () => 1,
    });
    const app = createApp({
      logger,
      ...createHealthRepository(database.pool),
      jobService: createJobService(
        createJobRepository(database.pool),
        { maxBytes: 10_000, maxRows: 100, maxAttempts: 4 },
        coordinator,
      ),
      csvMaxBytes: 10_000,
    });

    try {
      const response = await request(app)
        .post('/api/jobs')
        .attach(
          'file',
          Buffer.from(
            'store_id,store_name,address,city,state,country\nS1,Store,Address,City,State,Country',
          ),
          { filename: 'stores.csv', contentType: 'text/csv' },
        );
      expect(response.status).toBe(202);
      expect(response.body.status).toBe('queued');
      await waitUntil(async () => vi.mocked(client.enrich).mock.calls.length === 1);
      expect(
        (await database.pool.query('SELECT status FROM jobs WHERE id = $1', [response.body.jobId]))
          .rows[0].status,
      ).toBe('running');
      expect(
        (await database.pool.query('SELECT count(*)::int AS count FROM store_enrichments')).rows[0]
          .count,
      ).toBe(0);

      release();
      await waitUntil(async () => {
        const result = await database.pool.query('SELECT status FROM jobs WHERE id = $1', [
          response.body.jobId,
        ]);
        return result.rows[0]?.status === 'completed';
      });
      expect((await database.pool.query('SELECT status FROM job_stores')).rows[0].status).toBe(
        'succeeded',
      );
    } finally {
      release();
      await coordinator.stop();
    }
  });

  it('reclaims an expired lease and makes it claimable with a new token', async () => {
    const { job, repository } = await createRunningJob(['S1']);
    const first = await repository.claimNextStore(job.jobId, 20_000);
    if (!first) throw new Error('Expected a claim');
    await database.pool.query(
      `UPDATE job_stores SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE job_id = $1 AND store_id = 'S1'`,
      [job.jobId],
    );
    await expect(repository.reclaimExpiredLease(job.jobId, () => 0, 30)).resolves.toMatchObject({
      disposition: 'retry_wait',
      storeId: 'S1',
    });
    const second = await repository.claimNextStore(job.jobId, 20_000);
    expect(second).toMatchObject({ storeId: 'S1', attemptCount: 2 });
    expect(second?.leaseToken).not.toBe(first.leaseToken);
  });

  it('marks an expired final attempt failed and rejects its late completion', async () => {
    const job = await createJobRepository(database.pool).createJobWithStores([store('S1')], 1);
    const repository = createEnrichmentRepository(database.pool);
    await repository.startJob(job.jobId);
    const claim = await repository.claimNextStore(job.jobId, 20_000);
    if (!claim) throw new Error('Expected a claim');
    await database.pool.query(
      `UPDATE job_stores SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE job_id = $1`,
      [job.jobId],
    );
    const [recovered, accepted] = await Promise.all([
      repository.reclaimExpiredLease(job.jobId, () => 0, 30),
      repository.completeStore(claim, {
        estimatedMonthlyFootfall: 1,
        estimatedMonthlyRevenue: 2,
        storeSizeSqft: 3,
      }),
    ]);
    expect(recovered).toMatchObject({ disposition: 'failed', storeId: 'S1' });
    expect(accepted).toBe(false);
    await expect(repository.finishJobIfDone(job.jobId)).resolves.toMatchObject({
      status: 'failed',
      succeeded: 0,
      failed: 1,
    });
    expect(
      (
        await database.pool.query('SELECT last_error_code FROM job_stores WHERE job_id = $1', [
          job.jobId,
        ])
      ).rows[0].last_error_code,
    ).toBe('RETRY_EXHAUSTED');
  });

  it('recovers work left processing by a silent worker through the coordinator watchdog', async () => {
    const job = await createJobRepository(database.pool).createJobWithStores([store('S1')], 3);
    const repository = createEnrichmentRepository(database.pool);
    await repository.startJob(job.jobId);
    const abandoned = await repository.claimNextStore(job.jobId, 20_000);
    if (!abandoned) throw new Error('Expected a claim');
    await database.pool.query(
      `UPDATE job_stores SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE job_id = $1`,
      [job.jobId],
    );
    const client: EnrichmentClient = {
      enrich: vi.fn().mockResolvedValue({
        estimatedMonthlyFootfall: 10,
        estimatedMonthlyRevenue: 20,
        storeSizeSqft: 30,
      }),
    };
    const coordinator = createCoordinator({
      repository,
      client,
      rateLimiter: { waitForSlot: vi.fn().mockResolvedValue(undefined), deferFor: vi.fn() },
      logger,
      concurrency: 1,
      leaseDurationMs: 20_000,
      leaseReaperIntervalMs: 5,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
      systemicFailureStreak: 30,
      random: () => 0,
    });
    try {
      await coordinator.start();
      await waitUntil(async () => {
        const result = await database.pool.query('SELECT status FROM jobs WHERE id = $1', [
          job.jobId,
        ]);
        return result.rows[0]?.status === 'completed';
      });
      expect(client.enrich).toHaveBeenCalledTimes(1);
      expect(
        (
          await database.pool.query(
            'SELECT status, attempt_count FROM job_stores WHERE job_id = $1',
            [job.jobId],
          )
        ).rows[0],
      ).toEqual({ status: 'succeeded', attempt_count: 2 });
    } finally {
      await coordinator.stop();
    }
  });

  it('fails a systemically broken job, preserves prior success, and fences late responses', async () => {
    const job = await createJobRepository(database.pool).createJobWithStores(
      [store('S1'), store('S2'), store('S3')],
      5,
    );
    const repository = createEnrichmentRepository(database.pool);
    await repository.startJob(job.jobId);
    const first = await repository.claimNextStore(job.jobId, 20_000);
    if (!first) throw new Error('Expected first claim');
    expect(
      await repository.completeStore(first, {
        estimatedMonthlyFootfall: 10,
        estimatedMonthlyRevenue: 20,
        storeSizeSqft: 30,
      }),
    ).toBe(true);
    const second = await repository.claimNextStore(job.jobId, 20_000);
    const third = await repository.claimNextStore(job.jobId, 20_000);
    if (!second || !third) throw new Error('Expected remaining claims');
    await repository.recordAttemptFailure(
      second,
      { code: 'PROVIDER_ERROR', message: 'HTTP 500', systemicImpact: 'increment' },
      1000,
      2,
    );
    await expect(
      repository.recordAttemptFailure(
        third,
        { code: 'NETWORK_ERROR', message: 'Connection reset', systemicImpact: 'increment' },
        1000,
        2,
      ),
    ).resolves.toEqual({ disposition: 'job_failed' });
    expect(
      await repository.completeStore(third, {
        estimatedMonthlyFootfall: 999,
        estimatedMonthlyRevenue: 999,
        storeSizeSqft: 999,
      }),
    ).toBe(false);
    const progress = await createJobRepository(database.pool).getJobProgress(job.jobId);
    expect(progress).toMatchObject({
      status: 'failed',
      failureCode: 'SYSTEMIC_PROVIDER_FAILURE',
      completedStores: 3,
      unfinishedStores: 0,
      progressPercentage: 100,
      counts: { succeeded: 1, failed: 0, skipped: 2 },
    });
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::integer AS count FROM store_enrichments WHERE job_id = $1',
          [job.jobId],
        )
      ).rows[0].count,
    ).toBe(1);
    await expect(
      createJobRepository(database.pool).createJobWithStores([store('NEXT')], 5),
    ).resolves.toMatchObject({ status: 'queued' });
  });

  it('does not duplicate completion writes during coordinator shutdown', async () => {
    const job = await createJobRepository(database.pool).createJobWithStores([store('S1')], 3);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: EnrichmentClient = {
      enrich: vi.fn(async () => {
        await gate;
        return {
          estimatedMonthlyFootfall: 10,
          estimatedMonthlyRevenue: 20,
          storeSizeSqft: 30,
        };
      }),
    };
    const coordinator = createCoordinator({
      repository: createEnrichmentRepository(database.pool),
      client,
      rateLimiter: { waitForSlot: vi.fn().mockResolvedValue(undefined), deferFor: vi.fn() },
      logger,
      concurrency: 1,
      leaseDurationMs: 20_000,
      leaseReaperIntervalMs: 10,
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 20,
      systemicFailureStreak: 30,
    });
    await coordinator.start();
    await waitUntil(async () => vi.mocked(client.enrich).mock.calls.length === 1);
    const stopping = coordinator.stop();
    release();
    await stopping;
    await coordinator.stop();
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::integer AS count FROM store_enrichments WHERE job_id = $1',
          [job.jobId],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (await database.pool.query('SELECT status FROM jobs WHERE id = $1', [job.jobId])).rows[0]
        .status,
    ).toBe('completed');
  });
});
