import { loadEnvironmentFile } from '../config/load-env.js';
import { parseEnvironment } from '../config/env.js';
import { createLogger } from '../logging/logger.js';
import { createDatabasePool } from './pool.js';
import { runMigrations } from './migrate.js';

loadEnvironmentFile();
const logger = createLogger();
async function main() {
  const env = parseEnvironment(process.env);
  const pool = createDatabasePool(env, logger);
  try {
    const applied = await runMigrations(pool);
    logger.info({ applied }, applied.length ? 'Migrations applied' : 'Database is up to date');
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  logger.error(
    { code: 'MIGRATION_FAILED' },
    'Migration failed; check database access and migration history',
  );
  process.exitCode = 1;
});
