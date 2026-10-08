import type { RequestHandler } from 'express';
import { ApiError } from '../errors/api-error.js';
import type { FailureListQuery, StoreListQuery } from '../schemas/dashboard-schema.js';
import type { DashboardService } from '../services/dashboard-service.js';

function jobId(value: string | string[] | undefined): string {
  if (typeof value !== 'string') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Job ID must be a UUID.');
  }
  return value;
}

export function createDashboardController(service: DashboardService) {
  const listStores: RequestHandler = async (req, res) => {
    const query = (res.locals.validated as { query: StoreListQuery }).query;
    res.json(await service.listStores(jobId(req.params.jobId), query));
  };
  const listFailures: RequestHandler = async (req, res) => {
    const query = (res.locals.validated as { query: FailureListQuery }).query;
    res.json(await service.listFailures(jobId(req.params.jobId), query));
  };
  const getDashboard: RequestHandler = async (req, res) => {
    res.json(await service.getDashboard(jobId(req.params.jobId)));
  };
  return { listStores, listFailures, getDashboard };
}
