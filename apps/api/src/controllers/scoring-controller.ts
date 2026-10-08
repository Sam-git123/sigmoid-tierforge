import type { RequestHandler } from 'express';
import { ApiError } from '../errors/api-error.js';
import type { ScoringService } from '../services/scoring.service.js';

function jobId(value: string | string[] | undefined): string {
  if (typeof value !== 'string') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Job ID must be a UUID.');
  }
  return value;
}

export function createScoringController(service: ScoringService) {
  const create: RequestHandler = async (req, res) => {
    res.status(201).json(await service.scoreJob(jobId(req.params.jobId), req.body));
  };
  const get: RequestHandler = async (req, res) => {
    res.json(await service.getCurrent(jobId(req.params.jobId)));
  };
  return { create, get };
}
