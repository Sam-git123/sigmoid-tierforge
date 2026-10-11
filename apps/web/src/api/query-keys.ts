import type { StoreTier } from './tierforge';

export const queryKeys = {
  jobs: ['jobs'] as const,
  job: (jobId: string) => ['job', jobId] as const,
  failures: (jobId: string, page: number) => ['failures', jobId, page] as const,
  scoring: (jobId: string) => ['scoring', jobId] as const,
  dashboard: (jobId: string) => ['dashboard', jobId] as const,
  stores: (jobId: string, page: number, pageSize: number, tier?: StoreTier) =>
    ['stores', jobId, page, pageSize, tier ?? 'all'] as const,
  allStores: (jobId: string) => ['stores', jobId] as const,
};
