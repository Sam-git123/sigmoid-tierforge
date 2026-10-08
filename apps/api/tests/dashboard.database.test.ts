import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { StoreInput } from '../src/domain/jobs.js';
import { createLogger } from '../src/logging/logger.js';
import { createDashboardRepository } from '../src/repositories/dashboard-repository.js';
import { createHealthRepository } from '../src/repositories/health-repository.js';
import { createJobRepository } from '../src/repositories/job-repository.js';
import { createScoringRepository } from '../src/repositories/scoring-repository.js';
import { createDashboardService } from '../src/services/dashboard-service.js';
import { createJobService } from '../src/services/job-service.js';
import { createScoringService } from '../src/services/scoring.service.js';
import { createTestDatabase } from './helpers/test-database.js';

const connectionString = process.env.TEST_DATABASE_URL;
const logger = createLogger('silent');
const configuration = {
  footfallBar: 15000,
  revenueBar: 150000,
  sizeBar: 8000,
  footfallWeight: 50,
  revenueWeight: 30,
  sizeWeight: 20,
  largeThreshold: 70,
  mediumThreshold: 40,
};

function store(storeId: string): StoreInput {
  return {
    store_id: storeId,
    store_name: `Store ${storeId}`,
    address: `${storeId} Main Street`,
    city: 'City',
    state: 'State',
    country: 'Country',
  };
}

describe.skipIf(!connectionString)('Phase 7 read APIs with PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    if (!connectionString) throw new Error('TEST_DATABASE_URL required');
    database = await createTestDatabase(connectionString);
  });
  beforeEach(async () => database.reset());
  afterAll(async () => database?.close());

  function app() {
    return createApp({
      logger,
      ...createHealthRepository(database.pool),
      jobService: createJobService(createJobRepository(database.pool), {
        maxBytes: 10_000,
        maxRows: 100,
        maxAttempts: 5,
      }),
      scoringService: createScoringService(createScoringRepository(database.pool)),
      dashboardService: createDashboardService(createDashboardRepository(database.pool)),
      csvMaxBytes: 10_000,
    });
  }

  async function seedPartiallyFailedJob() {
    const job = await createJobRepository(database.pool).createJobWithStores(
      ['A', 'B', 'C', 'F', 'X'].map(store),
      5,
    );
    await database.pool.query(
      `UPDATE job_stores SET
         status = CASE
           WHEN store_id IN ('A', 'B', 'C') THEN 'succeeded'
           WHEN store_id = 'F' THEN 'failed'
           ELSE 'skipped'
         END,
         attempt_count = CASE WHEN store_id = 'F' THEN 5 WHEN store_id = 'X' THEN 2 ELSE 1 END,
         last_error_code = CASE WHEN store_id = 'F' THEN 'MAX_ATTEMPTS' WHEN store_id = 'X' THEN 'SKIPPED_BY_JOB' END,
         last_error_message = CASE WHEN store_id = 'F' THEN 'Provider remained unavailable.' WHEN store_id = 'X' THEN 'Job stopped before retry.' END
       WHERE job_id = $1`,
      [job.jobId],
    );
    await database.pool.query(
      `INSERT INTO store_enrichments
         (job_id, store_id, estimated_monthly_footfall, estimated_monthly_revenue, store_size_sqft)
       VALUES
         ($1, 'A', 40000, 400000, 18000),
         ($1, 'B', 20000, 100000, 5000),
         ($1, 'C', 2000, 20000, 9000)`,
      [job.jobId],
    );
    await database.pool.query(
      `UPDATE jobs SET status = 'completed_with_errors', started_at = created_at,
         finished_at = clock_timestamp(), failure_code = 'PARTIAL_FAILURES',
         failure_reason = 'Two stores did not succeed.'
       WHERE id = $1`,
      [job.jobId],
    );
    return job;
  }

  it('returns empty filtered pages and consistent not-found and validation errors', async () => {
    const job = await createJobRepository(database.pool).createJobWithStores([store('ONLY')], 5);

    const stores = await request(app()).get(`/api/jobs/${job.jobId}/stores?tier=Large`);
    expect(stores.status).toBe(200);
    expect(stores.body).toEqual({
      records: [],
      page: 1,
      pageSize: 50,
      totalRecords: 0,
      totalPages: 0,
    });
    const failures = await request(app()).get(`/api/jobs/${job.jobId}/failures`);
    expect(failures.body).toMatchObject({ records: [], totalRecords: 0, totalPages: 0 });

    const missingId = '00000000-0000-4000-8000-000000000000';
    for (const path of ['stores', 'failures', 'dashboard']) {
      const missing = await request(app()).get(`/api/jobs/${missingId}/${path}`);
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('JOB_NOT_FOUND');
    }
    for (const suffix of ['tier=Unknown', 'page=0', 'pageSize=101']) {
      const invalid = await request(app()).get(`/api/jobs/${job.jobId}/stores?${suffix}`);
      expect(invalid.status).toBe(422);
      expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await request(app()).get('/api/jobs/not-a-uuid/dashboard')).status).toBe(422);
  });

  it('paginates stores stably and preserves null values for unscored and unenriched stores', async () => {
    const job = await seedPartiallyFailedJob();

    const first = await request(app()).get(`/api/jobs/${job.jobId}/stores?page=1&pageSize=2`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ page: 1, pageSize: 2, totalRecords: 5, totalPages: 3 });
    expect(first.body.records.map((record: { storeId: string }) => record.storeId)).toEqual([
      'A',
      'B',
    ]);
    expect(first.body.records[0]).toMatchObject({
      estimatedMonthlyFootfall: '40000.00',
      estimatedMonthlyRevenue: '400000.00',
      storeSizeSqft: '18000.00',
      score: null,
      tier: null,
    });

    const last = await request(app()).get(`/api/jobs/${job.jobId}/stores?page=3&pageSize=2`);
    expect(last.body.records.map((record: { storeId: string }) => record.storeId)).toEqual(['X']);
    expect(last.body.records[0]).toMatchObject({
      status: 'skipped',
      estimatedMonthlyFootfall: null,
      estimatedMonthlyRevenue: null,
      storeSizeSqft: null,
      score: null,
      tier: null,
      lastErrorCode: 'SKIPPED_BY_JOB',
    });
    const beyond = await request(app()).get(`/api/jobs/${job.jobId}/stores?page=4&pageSize=2`);
    expect(beyond.body).toMatchObject({ records: [], totalRecords: 5, totalPages: 3 });
  });

  it('uses current scoring revision for tier filters and dashboard counts without duplicate rows', async () => {
    const job = await seedPartiallyFailedJob();
    await request(app()).post(`/api/jobs/${job.jobId}/scoring`).send(configuration).expect(201);

    for (const [tier, storeId] of [
      ['Large', 'A'],
      ['Medium', 'B'],
      ['Small', 'C'],
    ]) {
      const filtered = await request(app()).get(`/api/jobs/${job.jobId}/stores?tier=${tier}`);
      expect(filtered.body.totalRecords).toBe(1);
      expect(filtered.body.records.map((record: { storeId: string }) => record.storeId)).toEqual([
        storeId,
      ]);
    }

    const initial = await request(app()).get(`/api/jobs/${job.jobId}/dashboard`);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({
      successfullyEnrichedStores: 3,
      failedStores: 1,
      skippedStores: 1,
      scoredStores: 3,
      tierCounts: { large: 1, medium: 1, small: 1 },
      currentScoringRevision: 1,
      currentScoringConfiguration: { footfallBar: '15000.00' },
      job: {
        status: 'completed_with_errors',
        counts: { pending: 0, processing: 0, retryWait: 0, succeeded: 3, failed: 1, skipped: 1 },
        failureReason: 'Two stores did not succeed.',
      },
    });

    await request(app())
      .post(`/api/jobs/${job.jobId}/scoring`)
      .send({ ...configuration, footfallBar: 30000, revenueBar: 300000, sizeBar: 16000 })
      .expect(201);
    const allStores = await request(app()).get(`/api/jobs/${job.jobId}/stores?pageSize=100`);
    expect(allStores.body.totalRecords).toBe(5);
    expect(
      new Set(allStores.body.records.map((record: { storeId: string }) => record.storeId)).size,
    ).toBe(5);
    const small = await request(app()).get(`/api/jobs/${job.jobId}/stores?tier=Small`);
    expect(small.body.totalRecords).toBe(2);
    expect(small.body.records.map((record: { storeId: string }) => record.storeId)).toEqual([
      'B',
      'C',
    ]);
    const rescored = await request(app()).get(`/api/jobs/${job.jobId}/dashboard`);
    expect(rescored.body).toMatchObject({
      scoredStores: 3,
      tierCounts: { large: 1, medium: 0, small: 2 },
      currentScoringRevision: 2,
    });
  });

  it('returns progress and paginated failed and skipped stores with their final reasons', async () => {
    const job = await seedPartiallyFailedJob();

    const details = await request(app()).get(`/api/jobs/${job.jobId}`);
    expect(details.status).toBe(200);
    expect(details.body).toMatchObject({
      jobId: job.jobId,
      totalStores: 5,
      counts: { pending: 0, processing: 0, retryWait: 0, succeeded: 3, failed: 1, skipped: 1 },
      failureCode: 'PARTIAL_FAILURES',
      failureReason: 'Two stores did not succeed.',
    });

    const first = await request(app()).get(`/api/jobs/${job.jobId}/failures?page=1&pageSize=1`);
    expect(first.body).toMatchObject({ page: 1, pageSize: 1, totalRecords: 2, totalPages: 2 });
    expect(first.body.records[0]).toEqual({
      storeId: 'F',
      storeName: 'Store F',
      attemptCount: 5,
      lastErrorCode: 'MAX_ATTEMPTS',
      lastErrorMessage: 'Provider remained unavailable.',
      finalStatus: 'failed',
    });
    const second = await request(app()).get(`/api/jobs/${job.jobId}/failures?page=2&pageSize=1`);
    expect(second.body.records[0]).toMatchObject({
      storeId: 'X',
      finalStatus: 'skipped',
      lastErrorCode: 'SKIPPED_BY_JOB',
      lastErrorMessage: 'Job stopped before retry.',
    });
  });
});
