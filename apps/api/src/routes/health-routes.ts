import { Router } from 'express';
import { createHealthController } from '../controllers/health-controller.js';
import { createHealthService } from '../services/health-service.js';
import type { CheckDatabase } from '../services/health-service.js';

export function createHealthRoutes(checkDatabase: CheckDatabase) {
  const router = Router();
  router.get('/health', createHealthController(createHealthService(checkDatabase)));
  return router;
}
