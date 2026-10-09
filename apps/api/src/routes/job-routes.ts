import { Router } from 'express';
import { z } from 'zod';
import { createJobController } from '../controllers/job-controller.js';
import { csvUpload } from '../middleware/csv-upload.js';
import { validateRequest } from '../middleware/validate-request.js';
import type { JobService } from '../services/job-service.js';

export function createJobRoutes(service: JobService, maxBytes: number) {
  const router = Router();
  const controller = createJobController(service);
  router.post('/jobs', csvUpload(maxBytes), controller.create);
  router.get('/jobs', controller.list);
  router.get(
    '/jobs/:jobId',
    validateRequest(
      z.object({
        params: z.object({ jobId: z.uuid() }),
      }),
    ),
    controller.get,
  );
  return router;
}
