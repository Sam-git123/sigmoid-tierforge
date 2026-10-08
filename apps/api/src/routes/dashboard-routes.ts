import { Router } from 'express';
import { z } from 'zod';
import { createDashboardController } from '../controllers/dashboard-controller.js';
import { validateRequest } from '../middleware/validate-request.js';
import { failureListRequestSchema, storeListRequestSchema } from '../schemas/dashboard-schema.js';
import type { DashboardService } from '../services/dashboard-service.js';

const jobIdParams = z.object({ jobId: z.uuid() });

export function createDashboardRoutes(service: DashboardService) {
  const router = Router();
  const controller = createDashboardController(service);
  router.get(
    '/jobs/:jobId/stores',
    validateRequest(storeListRequestSchema.extend({ params: jobIdParams })),
    controller.listStores,
  );
  router.get(
    '/jobs/:jobId/failures',
    validateRequest(failureListRequestSchema.extend({ params: jobIdParams })),
    controller.listFailures,
  );
  router.get(
    '/jobs/:jobId/dashboard',
    validateRequest(z.object({ params: jobIdParams })),
    controller.getDashboard,
  );
  return router;
}
