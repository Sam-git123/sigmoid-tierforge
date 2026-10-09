import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createJobRepository } from '../src/repositories/job-repository.js';
import { createHealthRepository } from '../src/repositories/health-repository.js';
import { createJobService } from '../src/services/job-service.js';
import { createLogger } from '../src/logging/logger.js';
import { createTestDatabase } from './helpers/test-database.js';
import type { CsvLimits, StoreInput } from '../src/domain/jobs.js';

const header = 'store_id,store_name,address,city,state,country';
const valid = header + '\nST1,Shop,Street,City,State,Country';
const defaults = { maxBytes: 10_485_760, maxRows: 10000 };
const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)('job API with PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    if (!connectionString) throw new Error('TEST_DATABASE_URL required');
    database = await createTestDatabase(connectionString);
  });
  beforeEach(async () => database.reset());
  afterAll(async () => database?.close());

  function app(limits: CsvLimits = defaults) {
    return createApp({
      logger: createLogger('silent'),
      ...createHealthRepository(database.pool),
      jobService: createJobService(createJobRepository(database.pool), {
        ...limits,
        maxAttempts: 4,
      }),
      csvMaxBytes: limits.maxBytes,
    });
  }
  function upload(text = valid, limits = defaults) {
    return request(app(limits))
      .post('/api/jobs')
      .attach('file', Buffer.from(text), { filename: 'stores.csv', contentType: 'text/csv' });
  }
  async function expectEmpty() {
    expect(
      (await database.pool.query('SELECT count(*)::int AS count FROM jobs')).rows[0].count,
    ).toBe(0);
    expect(
      (await database.pool.query('SELECT count(*)::int AS count FROM job_stores')).rows[0].count,
    ).toBe(0);
  }

  it('creates a queued job with pending rows and configured attempt limits, without enrichment calls', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No upstream calls allowed'));
    try {
      const response = await upload(valid + '\nST2,Second,Other Road,City,State,Country');
      expect(response.status).toBe(202);
      expect(response.headers.location).toBe(response.body.statusUrl);
      expect(response.body).toMatchObject({
        status: 'queued',
        totalStores: 2,
        startedAt: null,
        finishedAt: null,
        failureCode: null,
        failureReason: null,
        warnings: [],
      });
      const rows = (await database.pool.query('SELECT * FROM job_stores ORDER BY store_id')).rows;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({
          job_id: response.body.jobId,
          status: 'pending',
          attempt_count: 0,
          max_attempts: 4,
          lease_token: null,
        });
      }
      const repository = createJobRepository(database.pool);
      expect(await repository.getJobById(response.body.jobId)).toMatchObject({
        status: 'queued',
        totalStores: 2,
      });
      expect(await repository.findActiveJob()).toMatchObject({ jobId: response.body.jobId });
      expect(await repository.getJobById(randomUUID())).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it('returns all six progress counts and nullable lifecycle fields', async () => {
    const created = await upload();
    const response = await request(app()).get(created.body.statusUrl);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      jobId: created.body.jobId,
      status: 'queued',
      totalStores: 1,
      createdAt: created.body.createdAt,
      startedAt: null,
      finishedAt: null,
      failureCode: null,
      failureReason: null,
      counts: { pending: 1, processing: 0, retryWait: 0, succeeded: 0, failed: 0, skipped: 0 },
      completedStores: 0,
      unfinishedStores: 1,
      progressPercentage: 0,
    });
  });
  it('lists recent jobs independently while several remain active', async () => {
    const created = await Promise.all([
      upload(header + '\nLIST-1,N,A,C,S,I'),
      upload(header + '\nLIST-2,N,A,C,S,I'),
      upload(header + '\nLIST-3,N,A,C,S,I'),
    ]);
    expect(created.every((response) => response.status === 202)).toBe(true);
    const response = await request(app()).get('/api/jobs');
    expect(response.status).toBe(200);
    expect(response.body.totalRecords).toBe(3);
    expect(response.body.records).toHaveLength(3);
    expect(new Set(response.body.records.map((job: { jobId: string }) => job.jobId))).toEqual(
      new Set(created.map((job) => job.body.jobId)),
    );
    expect(response.body.records.every((job: { status: string }) => job.status === 'queued')).toBe(
      true,
    );
  });
  it('counts each persisted state separately, including processing/retry_wait/skipped', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => `S${i},N,A,C,S,I`);
    const created = await upload(header + '\n' + rows.join('\n'));
    await database.pool.query(`UPDATE jobs SET status = 'running', started_at = now()`);
    await database.pool.query(`UPDATE job_stores SET status = 'processing', attempt_count = 1,
      lease_token = gen_random_uuid(), lease_expires_at = now() + interval '20 seconds' WHERE store_id = 'S1'`);
    await database.pool.query(`UPDATE job_stores SET status = 'retry_wait', attempt_count = 1,
      next_attempt_at = now() + interval '1 second' WHERE store_id = 'S2'`);
    for (const [id, status] of [
      ['S3', 'succeeded'],
      ['S4', 'failed'],
      ['S5', 'skipped'],
    ]) {
      await database.pool.query('UPDATE job_stores SET status = $1 WHERE store_id = $2', [
        status,
        id,
      ]);
    }
    const response = await request(app()).get(created.body.statusUrl);
    expect(response.body).toMatchObject({
      status: 'running',
      totalStores: 6,
      counts: { pending: 1, processing: 1, retryWait: 1, succeeded: 1, failed: 1, skipped: 1 },
      completedStores: 3,
      unfinishedStores: 3,
      progressPercentage: 50,
    });
    expect(response.body.startedAt).not.toBeNull();
    expect(
      (Object.values(response.body.counts) as number[]).reduce((sum, count) => sum + count, 0),
    ).toBe(response.body.totalStores);
  });
  it('exposes finished timestamps and job failure reasons when persisted', async () => {
    const created = await upload();
    await database.pool.query("UPDATE job_stores SET status = 'failed'");
    await database.pool.query(`UPDATE jobs SET status = 'failed', finished_at = now(),
      failure_code = 'TEST_FAILURE', failure_reason = 'Test reason'`);
    const response = await request(app()).get(created.body.statusUrl);
    expect(response.body).toMatchObject({
      status: 'failed',
      failureCode: 'TEST_FAILURE',
      failureReason: 'Test reason',
      counts: { failed: 1, pending: 0 },
    });
    expect(response.body.finishedAt).not.toBeNull();
  });
  it('returns 404 for missing jobs and 422 for invalid UUIDs', async () => {
    expect((await request(app()).get('/api/jobs/' + randomUUID())).status).toBe(404);
    expect((await request(app()).get('/api/jobs/not-a-uuid')).status).toBe(422);
  });
  it('rejects a missing file with a clear error', async () => {
    const response = await request(app()).post('/api/jobs');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CSV_FILE_REQUIRED');
    await expectEmpty();
  });
  it('rejects an empty multipart body with no file', async () => {
    const response = await request(app())
      .post('/api/jobs')
      .set('Content-Type', 'multipart/form-data; boundary=empty')
      .send('--empty--\r\n');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CSV_FILE_REQUIRED');
    await expectEmpty();
  });
  it.each([
    ['', 422, 'EMPTY_CSV'],
    [header, 422, 'EMPTY_CSV'],
    [header.replace('store_id', 'id') + '\nST1,N,A,C,S,I', 422, 'MISSING_CSV_HEADER'],
    [header + ',store_id\nST1,N,A,C,S,I,ST1', 422, 'DUPLICATE_CSV_HEADER'],
    [valid + '\nST1,Duplicate,A,C,S,I', 422, 'INVALID_CSV_ROWS'],
    [header + '\n,N,A,C,S,I', 422, 'INVALID_CSV_ROWS'],
    [header + '\nST1,N,A,C,,I', 422, 'INVALID_CSV_ROWS'],
    [valid + '\nST2,N,A,C,S', 400, 'INVALID_CSV_STRUCTURE'],
    [valid + '\nST2,"broken,A,C,S,I', 400, 'INVALID_CSV_STRUCTURE'],
  ])('rejects invalid files without partial persistence %#', async (csv, status, code) => {
    const response = await upload(csv);
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
    await expectEmpty();
  });
  it('ignores extra columns with a warning and persists only store fields', async () => {
    const response = await upload(header + ',note\nST1,N,A,C,S,I,unused');
    expect(response.status).toBe(202);
    expect(response.body.warnings[0]).toMatchObject({
      code: 'EXTRA_COLUMNS_IGNORED',
      columns: ['note'],
    });
    expect((await database.pool.query('SELECT store_id FROM job_stores')).rows).toEqual([
      { store_id: 'ST1' },
    ]);
  });
  it('still requires the full row width when extra columns are ignored', async () => {
    const response = await upload(header + ',note\nST1,N,A,C,S,I');
    expect(response.status).toBe(400);
    await expectEmpty();
  });
  it('rejects unsupported media, names, fields, and multiple files', async () => {
    expect((await request(app()).post('/api/jobs').send({ file: valid })).status).toBe(415);
    expect(
      (await request(app()).post('/api/jobs').attach('file', Buffer.from(valid), 'stores.txt'))
        .status,
    ).toBe(415);
    expect(
      (
        await request(app()).post('/api/jobs').attach('file', Buffer.from(valid), {
          filename: 'stores.csv',
          contentType: 'application/pdf',
        })
      ).status,
    ).toBe(415);
    expect(
      (await request(app()).post('/api/jobs').attach('upload', Buffer.from(valid), 'stores.csv'))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app())
          .post('/api/jobs')
          .attach('file', Buffer.from(valid), 'stores.csv')
          .attach('file', Buffer.from(valid), 'other.csv')
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app())
          .post('/api/jobs')
          .field('note', 'ignored?')
          .attach('file', Buffer.from(valid), 'stores.csv')
      ).status,
    ).toBe(400);
    await expectEmpty();
  });
  it('accepts .CSV with a generic browser file MIME type', async () => {
    const response = await request(app()).post('/api/jobs').attach('file', Buffer.from(valid), {
      filename: 'STORES.CSV',
      contentType: 'application/octet-stream',
    });
    expect(response.status).toBe(202);
  });
  it('rejects missing multipart boundaries and truncated forms', async () => {
    const missing = await request(app())
      .post('/api/jobs')
      .set('Content-Type', 'multipart/form-data')
      .send(valid);
    expect(missing.status).toBe(400);
    const truncated = await request(app())
      .post('/api/jobs')
      .set('Content-Type', 'multipart/form-data; boundary=test')
      .send(
        '--test\r\nContent-Disposition: form-data; name="file"; filename="stores.csv"\r\nContent-Type: text/csv\r\n\r\n' +
          valid,
      );
    expect(truncated.status).toBe(400);
    await expectEmpty();
  });
  it('enforces upload byte/row limits and accepts the exact byte limit', async () => {
    expect(
      (await upload(valid, { maxBytes: Buffer.byteLength(valid) - 1, maxRows: 10 })).status,
    ).toBe(413);
    expect((await upload(valid + '\nST2,N,A,C,S,I', { ...defaults, maxRows: 1 })).status).toBe(413);
    await expectEmpty();
    expect((await upload(valid, { maxBytes: Buffer.byteLength(valid), maxRows: 1 })).status).toBe(
      202,
    );
  });
  it.each(['queued', 'running'])('allows a new job while an existing job is %s', async (status) => {
    const first = await upload();
    if (status === 'running')
      await database.pool.query("UPDATE jobs SET status = 'running', started_at = now()");
    const second = await upload();
    expect(second.status).toBe(202);
    expect(second.body.jobId).not.toBe(first.body.jobId);
    expect((await database.pool.query('SELECT count(*) FROM jobs')).rows[0].count).toBe('2');
  });
  it('allows historical completed jobs and repeated store IDs in a later job', async () => {
    const first = await upload();
    await database.pool.query("UPDATE job_stores SET status = 'succeeded'");
    await database.pool.query(
      "UPDATE jobs SET status = 'completed', started_at = now(), finished_at = now()",
    );
    expect(await createJobRepository(database.pool).findActiveJob()).toBeNull();
    const second = await upload();
    expect(second.status).toBe(202);
    expect(second.body.jobId).not.toBe(first.body.jobId);
    expect((await database.pool.query('SELECT count(*) FROM jobs')).rows[0].count).toBe('2');
  });
  it('atomically admits both concurrent HTTP submissions as independent jobs', async () => {
    const responses = await Promise.all([upload(), upload()]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 202]);
    expect(new Set(responses.map((response) => response.body.jobId)).size).toBe(2);
    expect(
      (await database.pool.query("SELECT count(*) FROM jobs WHERE status IN ('queued','running')"))
        .rows[0].count,
    ).toBe('2');
    expect((await database.pool.query('SELECT count(*) FROM job_stores')).rows[0].count).toBe('2');
  });
  it('rolls back an earlier store batch and the job if a later batch fails', async () => {
    const repository = createJobRepository(database.pool);
    const stores: StoreInput[] = Array.from({ length: 501 }, (_, i) => ({
      store_id: i === 500 ? 'S0' : `S${i}`,
      store_name: 'N',
      address: 'A',
      city: 'C',
      state: 'S',
      country: 'I',
    }));
    // Bypass CSV validation deliberately to force a DB uniqueness error in batch two.
    await expect(repository.createJobWithStores(stores, 4)).rejects.toMatchObject({
      code: '23505',
    });
    await expectEmpty();
  });
  it('rolls back an upload when persistence fails after the job insert', async () => {
    await database.pool
      .query(`CREATE FUNCTION reject_test_store() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION ''deliberate test failure''; END';
      CREATE TRIGGER reject_test_store BEFORE INSERT ON job_stores
      FOR EACH ROW EXECUTE FUNCTION reject_test_store();`);
    try {
      const response = await upload();
      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('deliberate test failure');
      await expectEmpty();
    } finally {
      await database.pool.query(
        'DROP TRIGGER reject_test_store ON job_stores; DROP FUNCTION reject_test_store();',
      );
    }
  });
  it('uploads the actual Sigmoid 5,000-row CSV using one transaction and batch inserts', async () => {
    const sample = fileURLToPath(new URL('../../../stores_5000.csv', import.meta.url));
    const response = await request(app()).post('/api/jobs').attach('file', sample);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'queued', totalStores: 5000 });
    const progress = await request(app()).get(response.body.statusUrl);
    expect(progress.body.counts).toEqual({
      pending: 5000,
      processing: 0,
      retryWait: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    });
    const result = await database.pool.query(
      `SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status = 'pending' AND attempt_count = 0 AND max_attempts = 4)::int AS initialized
      FROM job_stores WHERE job_id = $1`,
      [response.body.jobId],
    );
    expect(result.rows[0]).toEqual({ total: 5000, initialized: 5000 });
    expect(
      (await database.pool.query('SELECT count(*) FROM store_enrichments')).rows[0].count,
    ).toBe('0');
  });
});
