import type { RequestHandler } from 'express';
import type { createHealthService } from '../services/health-service.js';

export function createHealthController(
  service: ReturnType<typeof createHealthService>,
): RequestHandler {
  return async (_req, res) => {
    res.json(await service.check());
  };
}
