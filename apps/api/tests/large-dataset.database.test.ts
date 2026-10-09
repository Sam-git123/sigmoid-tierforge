import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
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

describe.skipIf(!connectionString)('5,000-store database workflow', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    if (!connectionString) throw new Error('TEST_DATABASE_URL required');
    database = await createTestDatabase(connectionString);
  });
  afterAll(async () => database?.close());

  function app() {
    return createApp({
      logger,
      ...createHealthRepository(database.pool),
      jobService: createJobService(createJobRepository(database.pool), {
        maxBytes: 10 * 1024 * 1024,
        maxRows: 10_000,
        maxAttempts: 5,
      }),
      scoringService: createScoringService(createScoringRepository(database.pool)),
      dashboardService: createDashboardService(createDashboardRepository(database.pool)),
      csvMaxBytes: 10 * 1024 * 1024,
    });
  }

  it('ingests, scores, summarizes, filters, and paginates the supplied 5,000-row sample', async () => {
    const sample = fileURLToPath(new URL('../../../stores_5000.csv', import.meta.url));
    const upload = await request(app()).post('/api/jobs').attach('file', sample);
    expect(upload.status).toBe(202);
    expect(upload.body).toMatchObject({ totalStores: 5000, status: 'queued' });
    const jobId: string = upload.body.jobId;

    await database.pool.query(
      `WITH ranked AS (
         SELECT job_id, store_id, row_number() OVER (ORDER BY store_id) AS sequence
         FROM job_stores WHERE job_id = $1
       )
       INSERT INTO store_enrichments
         (job_id, store_id, estimated_monthly_footfall, estimated_monthly_revenue, store_size_sqft)
       SELECT job_id, store_id,
         CASE sequence % 3 WHEN 0 THEN 40000 WHEN 1 THEN 20000 ELSE 2000 END,
         CASE sequence % 3 WHEN 0 THEN 400000 WHEN 1 THEN 100000 ELSE 20000 END,
         CASE sequence % 3 WHEN 0 THEN 18000 WHEN 1 THEN 5000 ELSE 9000 END
       FROM ranked`,
      [jobId],
    );
    await database.pool.query(
      `UPDATE job_stores SET status = 'succeeded', attempt_count = 1 WHERE job_id = $1`,
      [jobId],
    );
    await database.pool.query(
      `UPDATE jobs SET status = 'completed', started_at = created_at,
         finished_at = clock_timestamp() WHERE id = $1`,
      [jobId],
    );

    const scoringStarted = performance.now();
    const scored = await request(app()).post(`/api/jobs/${jobId}/scoring`).send(configuration);
    const scoringDurationMs = performance.now() - scoringStarted;
    expect(scored.status).toBe(201);
    expect(scored.body).toMatchObject({
      storesScored: 5000,
      tierCounts: { large: 1666, medium: 1667, small: 1667 },
    });
    expect(scoringDurationMs).toBeLessThan(5000);

    const dashboard = await request(app()).get(`/api/jobs/${jobId}/dashboard`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toMatchObject({
      successfullyEnrichedStores: 5000,
      failedStores: 0,
      scoredStores: 5000,
      tierCounts: { large: 1666, medium: 1667, small: 1667 },
      job: {
        totalStores: 5000,
        counts: { pending: 0, processing: 0, retryWait: 0, succeeded: 5000, failed: 0, skipped: 0 },
      },
    });

    const pageStarted = performance.now();
    const page = await request(app()).get(
      `/api/jobs/${jobId}/stores?tier=Medium&page=2&pageSize=100`,
    );
    const pageDurationMs = performance.now() - pageStarted;
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ page: 2, pageSize: 100, totalRecords: 1667, totalPages: 17 });
    expect(page.body.records).toHaveLength(100);
    expect(page.body.records.every((record: { tier: string }) => record.tier === 'Medium')).toBe(
      true,
    );
    expect(
      new Set(page.body.records.map((record: { storeId: string }) => record.storeId)).size,
    ).toBe(100);
    expect(pageDurationMs).toBeLessThan(5000);
  });
});
