import { Router } from 'express';
import { z } from 'zod';
import { createScoringController } from '../controllers/scoring-controller.js';
import { validateRequest } from '../middleware/validate-request.js';
import type { ScoringService } from '../services/scoring.service.js';

const jobIdRequest = z.object({
  params: z.object({ jobId: z.uuid() }),
});

export function createScoringRoutes(service: ScoringService) {
  const router = Router();
  const controller = createScoringController(service);
  router.post('/jobs/:jobId/scoring', validateRequest(jobIdRequest), controller.create);
  router.get('/jobs/:jobId/scoring', validateRequest(jobIdRequest), controller.get);
  return router;
}
