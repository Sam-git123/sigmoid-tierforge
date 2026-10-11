import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDistributedRateLimiter } from '../src/workers/distributed-rate-limiter.js';
import { createTestDatabase } from './helpers/test-database.js';

const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)('PostgreSQL distributed request limiter', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let firstPool: pg.Pool;
  let secondPool: pg.Pool;

  beforeAll(async () => {
    if (!connectionString) throw new Error('TEST_DATABASE_URL required');
    database = await createTestDatabase(connectionString);
    firstPool = new pg.Pool({ connectionString: database.databaseUrl, max: 2 });
    secondPool = new pg.Pool({ connectionString: database.databaseUrl, max: 2 });
    await database.pool.query(`
      CREATE TABLE rate_limit_test_events (reserved_start_at timestamptz NOT NULL);
      CREATE FUNCTION capture_rate_limit_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.next_start_at > OLD.next_start_at THEN
          INSERT INTO rate_limit_test_events (reserved_start_at)
          VALUES (NEW.next_start_at - interval '220 milliseconds');
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER capture_rate_limit_reservation
      AFTER UPDATE ON enrichment_rate_limit
      FOR EACH ROW EXECUTE FUNCTION capture_rate_limit_reservation();
    `);
  });
  beforeEach(async () => {
    await database.reset();
    await database.pool.query('TRUNCATE rate_limit_test_events');
  });
  afterAll(async () => {
    await firstPool?.end();
    await secondPool?.end();
    await database?.close();
  });

  it('shares one five-per-second budget across independent pools', async () => {
    const first = createDistributedRateLimiter({ pool: firstPool, minimumIntervalMs: 220 });
    const second = createDistributedRateLimiter({ pool: secondPool, minimumIntervalMs: 220 });
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? first : second).waitForSlot()),
    );
    const events = await database.pool.query<{ reservedStartAt: Date }>(
      `SELECT reserved_start_at AS "reservedStartAt"
       FROM rate_limit_test_events ORDER BY reserved_start_at`,
    );
    expect(events.rows).toHaveLength(10);
    for (let index = 1; index < events.rows.length; index += 1) {
      expect(
        events.rows[index]!.reservedStartAt.getTime() -
          events.rows[index - 1]!.reservedStartAt.getTime(),
      ).toBeGreaterThanOrEqual(220);
    }
    for (let index = 5; index < events.rows.length; index += 1) {
      expect(
        events.rows[index]!.reservedStartAt.getTime() -
          events.rows[index - 5]!.reservedStartAt.getTime(),
      ).toBeGreaterThan(1000);
    }
  });

  it('shares provider cooldowns across limiter instances', async () => {
    const first = createDistributedRateLimiter({ pool: firstPool, minimumIntervalMs: 220 });
    const second = createDistributedRateLimiter({ pool: secondPool, minimumIntervalMs: 220 });
    await first.waitForSlot();
    await first.deferFor(300);
    const before = Date.now();
    await second.waitForSlot();
    expect(Date.now() - before).toBeGreaterThanOrEqual(275);
  });

  it('fails closed when PostgreSQL coordination is unavailable', async () => {
    const closed = new pg.Pool({ connectionString: database.databaseUrl, max: 1 });
    const limiter = createDistributedRateLimiter({ pool: closed, minimumIntervalMs: 220 });
    await closed.end();
    await expect(limiter.waitForSlot()).rejects.toThrow();
    await expect(limiter.deferFor(1000)).rejects.toThrow();
  });
});
