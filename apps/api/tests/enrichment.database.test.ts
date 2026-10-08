import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { EnrichmentClient } from '../src/clients/enrichment-client.js';
import type { StoreInput } from '../src/domain/jobs.js';
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
    expect(claimed).toMatchObject({ jobId: job.jobId, storeId: 'S1', attemptCount: 1 });
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
      await repository.failStore(second, {
        code: 'ENRICHMENT_HTTP_ERROR',
        message: 'Enrichment API returned HTTP 500.',
      }),
    ).toBe(true);
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
      rateLimiter: { waitForSlot: vi.fn().mockResolvedValue(undefined) },
      logger,
      concurrency: 2,
      leaseDurationMs: 20_000,
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
});
