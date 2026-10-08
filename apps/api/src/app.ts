import express from 'express';
import type { Logger } from 'pino';
import { ApiError } from './errors/api-error.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestContext } from './middleware/request-context.js';
import { createHealthRoutes } from './routes/health-routes.js';
import type { CheckDatabase } from './services/health-service.js';
import type { JobService } from './services/job-service.js';
import { createJobRoutes } from './routes/job-routes.js';
import { createScoringRoutes } from './routes/scoring-routes.js';
import type { ScoringService } from './services/scoring.service.js';

interface AppDependencies {
  logger: Logger;
  checkDatabase: CheckDatabase;
  jobService: JobService;
  csvMaxBytes: number;
  scoringService?: ScoringService;
}

// Importing the application creates no listener, database pool, or background task.
export function createApp({
  logger,
  checkDatabase,
  jobService,
  csvMaxBytes,
  scoringService,
}: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext(logger));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', createHealthRoutes(checkDatabase));
  app.use('/api', createJobRoutes(jobService, csvMaxBytes));
  if (scoringService) app.use('/api', createScoringRoutes(scoringService));
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Route not found.')));
  app.use(errorHandler(logger));
  return app;
}
