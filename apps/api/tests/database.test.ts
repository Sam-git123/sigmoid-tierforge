import { randomUUID } from 'node:crypto';
import { mkdtemp, copyFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { runMigrations } from '../src/db/migrate.js';
import { withTransaction } from '../src/db/transaction.js';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logging/logger.js';
import { createHealthRepository } from '../src/repositories/health-repository.js';

const connectionString = process.env.TEST_DATABASE_URL;
const schema = `tierforge_test_${randomUUID().replaceAll('-', '')}`;
// Only generated alphanumeric/underscore identifiers are interpolated in DDL.
if (!/^tierforge_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid test schema');

describe.skipIf(!connectionString)('PostgreSQL foundation (isolated schema)', () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 3000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    expect(await runMigrations(pool)).toEqual(['001_foundation.sql']);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  async function rollbackTest(action: (client: PoolClient) => Promise<void>) {
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      await action(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  async function seed(client: PoolClient) {
    const id = randomUUID();
    await client.query('INSERT INTO jobs (id, total_stores) VALUES ($1, 1)', [id]);
    await client.query(
      `INSERT INTO job_stores
      (job_id, store_id, store_name, address, city, state, country)
      VALUES ($1, 'S1', 'Store', 'Address', 'City', 'State', 'Country')`,
      [id],
    );
    return id;
  }
  async function config(client: PoolClient, id: string, revision = 1) {
    await client.query(
      `INSERT INTO scoring_configs
      (job_id, footfall_bar, revenue_bar, size_bar, footfall_weight, revenue_weight,
      size_weight, large_threshold, medium_threshold, revision)
      VALUES ($1, 15000, 150000, 8000, 50, 30, 20, 70, 40, $2)`,
      [id, revision],
    );
  }
  async function enrichment(client: PoolClient, id: string) {
    await client.query(
      `INSERT INTO store_enrichments
      (job_id, store_id, estimated_monthly_footfall, estimated_monthly_revenue, store_size_sqft)
      VALUES ($1, 'S1', 15000, 142033.50, 6210)`,
      [id],
    );
  }

  it('connects to real PostgreSQL and serves live readiness', async () => {
    expect((await pool.query('SELECT 1 AS value')).rows[0].value).toBe(1);
    const app = createApp({ logger: createLogger('silent'), ...createHealthRepository(pool) });
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
  it('reruns migrations without changes', async () => {
    expect(await runMigrations(pool)).toEqual([]);
    expect((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count).toBe('1');
  });
  it('rejects duplicate stores within a job', () =>
    rollbackTest(async (client) => {
      const id = await seed(client);
      await expect(
        client.query(
          `INSERT INTO job_stores
      SELECT * FROM job_stores WHERE job_id = $1`,
          [id],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    }));
  it.each(['queued', 'running'])('rejects a second active %s job', (status) =>
    rollbackTest(async (client) => {
      await seed(client);
      await expect(
        client.query(
          `INSERT INTO jobs (status, started_at)
      VALUES ($1, CASE WHEN $1 = 'running' THEN now() ELSE NULL END)`,
          [status],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    }),
  );
  it('allows a subsequent job after the previous job is terminal', () =>
    rollbackTest(async (client) => {
      const id = await seed(client);
      await client.query("UPDATE jobs SET status = 'failed', finished_at = now() WHERE id = $1", [
        id,
      ]);
      await expect(client.query('INSERT INTO jobs DEFAULT VALUES')).resolves.toMatchObject({
        rowCount: 1,
      });
    }));
  it('enforces the active-job constraint across simultaneous connections', async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    const id = randomUUID();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query('INSERT INTO jobs (id) VALUES ($1)', [id]);
      const rejected = expect(
        second.query('INSERT INTO jobs DEFAULT VALUES'),
      ).rejects.toMatchObject({ code: '23505' });
      await first.query('COMMIT');
      await rejected;
    } finally {
      await first.query('ROLLBACK');
      await second.query('ROLLBACK');
      first.release();
      second.release();
      await pool.query('DELETE FROM jobs WHERE id = $1', [id]);
    }
  });
  it.each([
    "UPDATE jobs SET status = 'unknown'",
    "UPDATE job_stores SET status = 'unknown'",
    'UPDATE jobs SET total_stores = -1',
    'UPDATE job_stores SET attempt_count = -1',
    'UPDATE job_stores SET max_attempts = 0',
    'UPDATE job_stores SET attempt_count = 7',
    "UPDATE job_stores SET status = 'processing'",
    "UPDATE job_stores SET status = 'retry_wait'",
    'UPDATE job_stores SET lease_token = gen_random_uuid()',
  ])('rejects invalid work/job state %#', (sql) =>
    rollbackTest(async (client) => {
      await seed(client);
      await expect(client.query(sql)).rejects.toMatchObject({ code: '23514' });
    }),
  );
  it('accepts a well-formed processing lease and retry state', () =>
    rollbackTest(async (client) => {
      const id = await seed(client);
      await client.query(
        `UPDATE job_stores SET status = 'processing', attempt_count = 1,
      lease_token = gen_random_uuid(), lease_expires_at = now() + interval '20 seconds'
      WHERE job_id = $1`,
        [id],
      );
      await client.query(
        `UPDATE job_stores SET status = 'retry_wait',
      lease_token = NULL, lease_expires_at = NULL, next_attempt_at = now() + interval '1 second'
      WHERE job_id = $1`,
        [id],
      );
      expect((await client.query('SELECT status FROM job_stores')).rows[0].status).toBe(
        'retry_wait',
      );
    }));
  it('rejects orphan enrichments', () =>
    rollbackTest(async (client) => {
      await expect(enrichment(client, randomUUID())).rejects.toMatchObject({ code: '23503' });
    }));
  it.each(['estimated_monthly_footfall', 'estimated_monthly_revenue', 'store_size_sqft'])(
    'rejects negative %s',
    (column) =>
      rollbackTest(async (client) => {
        const id = await seed(client);
        await enrichment(client, id);
        await expect(
          client.query(`UPDATE store_enrichments SET ${column} = -1`),
        ).rejects.toMatchObject({ code: '23514' });
      }),
  );
  it('rejects numeric NaN rather than accepting it as nonnegative', () =>
    rollbackTest(async (client) => {
      const id = await seed(client);
      await enrichment(client, id);
      await expect(
        client.query("UPDATE store_enrichments SET store_size_sqft = 'NaN'"),
      ).rejects.toMatchObject({ code: '23514' });
    }));
  it('preserves exact monetary decimals', () =>
    rollbackTest(async (client) => {
      const id = await seed(client);
      await enrichment(client, id);
      expect(
        (await client.query('SELECT estimated_monthly_revenue FROM store_enrichments')).rows[0]
          .estimated_monthly_revenue,
      ).toBe('142033.50');
    }));
  it.each([
    'UPDATE scoring_configs SET footfall_weight = 49',
    'UPDATE scoring_configs SET footfall_weight = -1',
    'UPDATE scoring_configs SET medium_threshold = 70',
    'UPDATE scoring_configs SET revenue_bar = -1',
    'UPDATE scoring_configs SET revision = 0',
  ])('rejects invalid scoring configuration %#', (sql) =>
    rollbackTest(async (client) => {
      const id = await seed(client);
      await config(client, id);
      await expect(client.query(sql)).rejects.toMatchObject({ code: '23514' });
    }),
  );
  it('prevents scores without an enrichment', () =>
    rollbackTest(async (client) => {
      const id = await seed(client);
      await config(client, id);
      await expect(
        client.query(
          `INSERT INTO store_scores (job_id, store_id, score, tier, config_revision)
      VALUES ($1, 'S1', 50, 'Medium', 1)`,
          [id],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    }));
  it('prevents cross-job configuration references', () =>
    rollbackTest(async (client) => {
      const id = await seed(client);
      await enrichment(client, id);
      await client.query("UPDATE jobs SET status = 'failed', finished_at = now() WHERE id = $1", [
        id,
      ]);
      const other = await seed(client);
      await config(client, other);
      await expect(
        client.query(
          `INSERT INTO store_scores (job_id, store_id, score, tier, config_revision)
      VALUES ($1, 'S1', 50, 'Medium', 1)`,
          [id],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    }));
  it('supports separate score revisions without calculating scores', () =>
    rollbackTest(async (client) => {
      const id = await seed(client);
      await enrichment(client, id);
      await config(client, id, 1);
      await config(client, id, 2);
      await client.query(
        `INSERT INTO store_scores (job_id, store_id, score, tier, config_revision)
      VALUES ($1, 'S1', 50, 'Medium', 1), ($1, 'S1', 70, 'Large', 2)`,
        [id],
      );
      expect((await client.query('SELECT count(*) FROM store_scores')).rows[0].count).toBe('2');
      await expect(client.query("UPDATE store_scores SET tier = 'Unknown'")).rejects.toMatchObject({
        code: '23514',
      });
    }));
  it('rolls back a failed application transaction', async () => {
    const id = randomUUID();
    await expect(
      withTransaction(pool, async (client) => {
        await client.query('INSERT INTO jobs (id) VALUES ($1)', [id]);
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');
    expect((await pool.query('SELECT id FROM jobs WHERE id = $1', [id])).rowCount).toBe(0);
  });
  it('has the requested queue/lease/status/tier indexes', async () => {
    const result = await pool.query<{ indexname: string }>(
      'SELECT indexname FROM pg_indexes WHERE schemaname = $1',
      [schema],
    );
    expect(result.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'jobs_single_active_idx',
        'job_stores_pending_idx',
        'job_stores_retry_eligible_idx',
        'job_stores_expired_lease_idx',
        'job_stores_status_idx',
        'store_scores_tier_idx',
      ]),
    );
  });
  it('rolls back failed migration DDL and rejects modified migration history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tierforge-migration-test-'));
    const source = fileURLToPath(new URL('../migrations/001_foundation.sql', import.meta.url));
    const first = join(directory, '001_foundation.sql');
    const second = join(directory, '002_broken.sql');
    try {
      await copyFile(source, first);
      await writeFile(second, 'CREATE TABLE should_rollback (id integer); SELECT invalid_column;');
      await expect(runMigrations(pool, directory)).rejects.toMatchObject({ code: '42703' });
      expect(
        (await pool.query("SELECT to_regclass('should_rollback') AS relation")).rows[0].relation,
      ).toBeNull();
      expect((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count).toBe('1');
      await writeFile(first, '-- changed migration');
      await expect(runMigrations(pool, directory)).rejects.toThrow('Applied migration has changed');
    } finally {
      await unlink(first);
      await unlink(second);
      await rmdir(directory);
    }
  });
});
