import { createApp } from './app.js';
import { parseEnvironment } from './config/env.js';
import { loadEnvironmentFile } from './config/load-env.js';
import { createDatabasePool } from './db/pool.js';
import { createLogger } from './logging/logger.js';
import { createHealthRepository } from './repositories/health-repository.js';
import { createJobRepository } from './repositories/job-repository.js';
import { createJobService } from './services/job-service.js';

async function start(): Promise<void> {
  loadEnvironmentFile();
  const env = parseEnvironment(process.env);
  const logger = createLogger(env.LOG_LEVEL);
  const pool = createDatabasePool(env, logger);
  const repository = createHealthRepository(pool);
  try {
    await repository.checkDatabase();
  } catch {
    logger.fatal({ code: 'DATABASE_UNAVAILABLE' }, 'Cannot start without PostgreSQL');
    await pool.end();
    process.exitCode = 1;
    return;
  }

  const jobService = createJobService(createJobRepository(pool), {
    maxBytes: env.CSV_MAX_BYTES,
    maxRows: env.CSV_MAX_ROWS,
    maxAttempts: env.MAX_ATTEMPTS,
  });
  const app = createApp({
    logger,
    checkDatabase: repository.checkDatabase,
    jobService,
    csvMaxBytes: env.CSV_MAX_BYTES,
  });
  const server = app.listen(env.API_PORT, '127.0.0.1', () => {
    logger.info({ port: env.API_PORT }, 'TierForge API listening');
  });
  server.on('error', () => {
    logger.fatal({ code: 'LISTEN_FAILED' }, 'API listener failed');
    void pool.end().finally(() => {
      process.exitCode = 1;
    });
  });

  let stopping = false;
  function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');
    const deadline = setTimeout(() => {
      logger.error({ code: 'SHUTDOWN_TIMEOUT' }, 'Shutdown deadline exceeded');
      process.exit(1);
    }, 10_000);
    deadline.unref();
    server.close(() => {
      void pool.end().finally(() => {
        clearTimeout(deadline);
      });
    });
  }
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

void start().catch((error: unknown) => {
  const logger = createLogger();
  logger.fatal({
    code: 'STARTUP_FAILED',
    message:
      error instanceof Error && error.message.startsWith('Invalid environment configuration:')
        ? error.message
        : 'Startup failed',
  });
  process.exitCode = 1;
});
