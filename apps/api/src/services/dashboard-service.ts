import { ApiError } from '../errors/api-error.js';
import type { StoreListOptions } from '../domain/dashboard.js';
import type { DashboardRepository } from '../repositories/dashboard-repository.js';
import type { FailureListQuery, StoreListQuery } from '../schemas/dashboard-schema.js';

function notFound(): ApiError {
  return new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.');
}

export function createDashboardService(repository: DashboardRepository) {
  return {
    async listStores(jobId: string, query: StoreListQuery) {
      const options: StoreListOptions = query.tier
        ? { page: query.page, pageSize: query.pageSize, tier: query.tier }
        : { page: query.page, pageSize: query.pageSize };
      const result = await repository.listStores(jobId, options);
      if (!result) throw notFound();
      return result;
    },

    async listFailures(jobId: string, query: FailureListQuery) {
      const result = await repository.listFailures(jobId, query);
      if (!result) throw notFound();
      return result;
    },

    async getDashboard(jobId: string) {
      const result = await repository.getDashboard(jobId);
      if (!result) throw notFound();
      return result;
    },
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
