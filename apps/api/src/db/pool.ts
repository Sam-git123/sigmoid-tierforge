import pg from 'pg';
import type { Environment } from '../config/env.js';
import type { Logger } from 'pino';

export function createDatabasePool(env: Environment, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    application_name: 'tierforge-api',
  });
  pool.on('error', () =>
    logger.error({ code: 'DB_IDLE_CONNECTION_ERROR' }, 'Database connection failed'),
  );
  return pool;
}
