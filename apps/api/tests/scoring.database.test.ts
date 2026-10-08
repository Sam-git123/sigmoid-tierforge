import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { StoreInput } from '../src/domain/jobs.js';
import { createLogger } from '../src/logging/logger.js';
import { createHealthRepository } from '../src/repositories/health-repository.js';
import { createJobRepository } from '../src/repositories/job-repository.js';
import { createScoringRepository } from '../src/repositories/scoring-repository.js';
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
    address: 'Address',
    city: 'City',
    state: 'State',
    country: 'Country',
  };
}

describe.skipIf(!connectionString)('scoring with PostgreSQL', () => {
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
      csvMaxBytes: 10_000,
    });
  }

  async function seedTerminalJob() {
    const job = await createJobRepository(database.pool).createJobWithStores(
      ['A', 'B', 'C', 'FAILED'].map(store),
      5,
    );
    await database.pool.query(
      `UPDATE job_stores SET status = CASE WHEN store_id = 'FAILED' THEN 'failed' ELSE 'succeeded' END
       WHERE job_id = $1`,
      [job.jobId],
    );
    await database.pool.query(
      `INSERT INTO store_enrichments
         (job_id, store_id, estimated_monthly_footfall, estimated_monthly_revenue, store_size_sqft)
       VALUES
         ($1, 'A', 40000, 400000, 18000),
         ($1, 'B', 20000, 100000, 5000),
         ($1, 'C', 2000, 20000, 9000),
         ($1, 'FAILED', 999999, 999999, 999999)`,
      [job.jobId],
    );
    await database.pool.query(
      `UPDATE jobs SET status = 'completed_with_errors', finished_at = clock_timestamp()
       WHERE id = $1`,
      [job.jobId],
    );
    return job;
  }

  it('scores the exact Sigmoid examples in one set-based revision and excludes failed stores', async () => {
    const job = await seedTerminalJob();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const before = await request(app()).get(`/api/jobs/${job.jobId}/scoring`);
      expect(before.status).toBe(200);
      expect(before.body).toEqual({
        jobId: job.jobId,
        revision: null,
        configuration: null,
        storesScored: 0,
        tierCounts: { large: 0, medium: 0, small: 0 },
      });
      const response = await request(app())
        .post(`/api/jobs/${job.jobId}/scoring`)
        .send(configuration);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        jobId: job.jobId,
        revision: 1,
        storesScored: 3,
        tierCounts: { large: 1, medium: 1, small: 1 },
      });
      expect(
        (
          await database.pool.query(
            `SELECT store_id, score, tier, config_revision
             FROM store_scores WHERE job_id = $1 ORDER BY store_id`,
            [job.jobId],
          )
        ).rows,
      ).toEqual([
        { store_id: 'A', score: '100.00', tier: 'Large', config_revision: 1 },
        { store_id: 'B', score: '50.00', tier: 'Medium', config_revision: 1 },
        { store_id: 'C', score: '20.00', tier: 'Small', config_revision: 1 },
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('publishes a new revision on recalculation while preserving revision history', async () => {
    const job = await seedTerminalJob();
    await request(app()).post(`/api/jobs/${job.jobId}/scoring`).send(configuration).expect(201);
    const recalculated = await request(app())
      .post(`/api/jobs/${job.jobId}/scoring`)
      .send({
        ...configuration,
        footfallBar: 30000,
        revenueBar: 300000,
        sizeBar: 16000,
      });
    expect(recalculated.status).toBe(201);
    expect(recalculated.body).toMatchObject({
      revision: 2,
      storesScored: 3,
      tierCounts: { large: 1, medium: 0, small: 2 },
    });
    const current = await request(app()).get(`/api/jobs/${job.jobId}/scoring`);
    expect(current.body).toMatchObject({
      revision: 2,
      configuration: { footfallBar: '30000.00' },
      tierCounts: { large: 1, medium: 0, small: 2 },
    });
    expect(
      (
        await database.pool.query(
          `SELECT config_revision, count(*)::integer AS count
           FROM store_scores WHERE job_id = $1 GROUP BY config_revision ORDER BY config_revision`,
          [job.jobId],
        )
      ).rows,
    ).toEqual([
      { config_revision: 1, count: 3 },
      { config_revision: 2, count: 3 },
    ]);
  });

  it('rolls back a failed recalculation and leaves the prior revision current', async () => {
    const job = await seedTerminalJob();
    await request(app()).post(`/api/jobs/${job.jobId}/scoring`).send(configuration).expect(201);
    await database.pool.query(`CREATE FUNCTION reject_second_score_revision() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.config_revision = 2 THEN RAISE EXCEPTION 'forced scoring failure'; END IF;
        RETURN NEW;
      END $$`);
    await database.pool.query(`CREATE TRIGGER reject_second_score_revision
      BEFORE INSERT ON store_scores FOR EACH ROW EXECUTE FUNCTION reject_second_score_revision()`);
    try {
      const failed = await request(app())
        .post(`/api/jobs/${job.jobId}/scoring`)
        .send({ ...configuration, footfallBar: 30000 });
      expect(failed.status).toBe(500);
      const current = await request(app()).get(`/api/jobs/${job.jobId}/scoring`);
      expect(current.body).toMatchObject({ revision: 1, storesScored: 3 });
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::integer AS count FROM scoring_configs WHERE job_id = $1',
            [job.jobId],
          )
        ).rows[0].count,
      ).toBe(1);
    } finally {
      await database.pool.query('DROP TRIGGER reject_second_score_revision ON store_scores');
      await database.pool.query('DROP FUNCTION reject_second_score_revision()');
    }
  });

  it('serializes concurrent recalculations into distinct complete revisions', async () => {
    const job = await seedTerminalJob();
    const responses = await Promise.all([
      request(app()).post(`/api/jobs/${job.jobId}/scoring`).send(configuration),
      request(app())
        .post(`/api/jobs/${job.jobId}/scoring`)
        .send({ ...configuration, footfallBar: 30000 }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses.map((response) => response.body.revision).sort()).toEqual([1, 2]);
    expect(
      (
        await database.pool.query(
          `SELECT count(*)::integer AS count FROM store_scores WHERE job_id = $1`,
          [job.jobId],
        )
      ).rows[0].count,
    ).toBe(6);
    expect((await request(app()).get(`/api/jobs/${job.jobId}/scoring`)).body.revision).toBe(2);
  });

  it('rejects invalid configurations and jobs that are not terminal', async () => {
    const terminal = await seedTerminalJob();
    const invalid = await request(app())
      .post(`/api/jobs/${terminal.jobId}/scoring`)
      .send({ ...configuration, sizeWeight: 19.99 });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('SCORING_VALIDATION_ERROR');

    await database.reset();
    const queued = await createJobRepository(database.pool).createJobWithStores([store('Q')], 5);
    const premature = await request(app())
      .post(`/api/jobs/${queued.jobId}/scoring`)
      .send(configuration);
    expect(premature.status).toBe(409);
    expect(premature.body.error).toMatchObject({
      code: 'JOB_NOT_TERMINAL',
      details: { status: 'queued' },
    });
  });
});
