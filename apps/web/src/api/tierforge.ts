import { z } from 'zod';
import { apiClient, type createApiClient } from './client';

const nullableText = z.string().nullable();
const tierSchema = z.enum(['Large', 'Medium', 'Small']);
const jobStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'completed_with_errors',
  'failed',
]);
const countsSchema = z.object({
  pending: z.number(),
  processing: z.number(),
  retryWait: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  skipped: z.number(),
});
const jobBaseSchema = z.object({
  jobId: z.string(),
  status: jobStatusSchema,
  totalStores: z.number(),
  createdAt: z.string(),
  startedAt: nullableText,
  finishedAt: nullableText,
  failureCode: nullableText,
  failureReason: nullableText,
});
const scoringConfigurationSchema = z.object({
  footfallBar: z.string(),
  revenueBar: z.string(),
  sizeBar: z.string(),
  footfallWeight: z.string(),
  revenueWeight: z.string(),
  sizeWeight: z.string(),
  largeThreshold: z.string(),
  mediumThreshold: z.string(),
});
const tierCountsSchema = z.object({ large: z.number(), medium: z.number(), small: z.number() });

export const jobProgressSchema = jobBaseSchema.extend({
  counts: countsSchema,
  completedStores: z.number(),
  unfinishedStores: z.number(),
  progressPercentage: z.number(),
});
const uploadResponseSchema = jobBaseSchema.extend({
  statusUrl: z.string(),
  warnings: z.array(
    z.object({
      code: z.literal('EXTRA_COLUMNS_IGNORED'),
      message: z.string(),
      columns: z.array(z.string()),
    }),
  ),
});
const failureSchema = z.object({
  storeId: z.string(),
  storeName: z.string(),
  attemptCount: z.number(),
  lastErrorCode: nullableText,
  lastErrorMessage: nullableText,
  finalStatus: z.enum(['failed', 'skipped']),
});
const storeSchema = z.object({
  storeId: z.string(),
  storeName: z.string(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  country: z.string(),
  status: z.string(),
  estimatedMonthlyFootfall: nullableText,
  estimatedMonthlyRevenue: nullableText,
  storeSizeSqft: nullableText,
  score: nullableText,
  tier: tierSchema.nullable(),
  lastErrorCode: nullableText,
  lastErrorMessage: nullableText,
});
function pageSchema<T extends z.ZodType>(record: T) {
  return z.object({
    records: z.array(record),
    page: z.number(),
    pageSize: z.number(),
    totalRecords: z.number(),
    totalPages: z.number(),
  });
}
const scoringSummarySchema = z.object({
  jobId: z.string(),
  revision: z.number(),
  configuration: scoringConfigurationSchema,
  storesScored: z.number(),
  tierCounts: tierCountsSchema,
});
const currentScoringSchema = z.object({
  jobId: z.string(),
  revision: z.number().nullable(),
  configuration: scoringConfigurationSchema.nullable(),
  storesScored: z.number(),
  tierCounts: tierCountsSchema,
});
const dashboardSchema = z.object({
  job: jobBaseSchema.extend({ counts: countsSchema }),
  successfullyEnrichedStores: z.number(),
  failedStores: z.number(),
  skippedStores: z.number(),
  scoredStores: z.number(),
  tierCounts: tierCountsSchema,
  currentScoringRevision: z.number().nullable(),
  currentScoringConfiguration: scoringConfigurationSchema.nullable(),
});

export type JobProgress = z.infer<typeof jobProgressSchema>;
export type JobSummary = z.infer<typeof jobBaseSchema>;
export type UploadResponse = z.infer<typeof uploadResponseSchema>;
export type FailureRecord = z.infer<typeof failureSchema>;
export type StoreRecord = z.infer<typeof storeSchema>;
export type StoreTier = z.infer<typeof tierSchema>;
export type ScoringConfiguration = z.infer<typeof scoringConfigurationSchema>;
export type DashboardSummary = z.infer<typeof dashboardSchema>;
export type Paginated<T> = {
  records: T[];
  page: number;
  pageSize: number;
  totalRecords: number;
  totalPages: number;
};
export type ScoringInput = ScoringConfiguration;

type ApiClient = ReturnType<typeof createApiClient>;

function jsonBody(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  };
}

export function createTierForgeApi(client: ApiClient) {
  return {
    async uploadStores(file: File): Promise<UploadResponse> {
      const body = new FormData();
      body.append('file', file);
      return uploadResponseSchema.parse(await client.request('/jobs', { method: 'POST', body }));
    },
    async getJob(jobId: string): Promise<JobProgress> {
      return jobProgressSchema.parse(await client.request(`/jobs/${jobId}`));
    },
    async getJobs(): Promise<{ records: JobSummary[]; totalRecords: number }> {
      return z
        .object({ records: z.array(jobBaseSchema), totalRecords: z.number() })
        .parse(await client.request('/jobs'));
    },
    async getFailures(jobId: string, page = 1, pageSize = 20): Promise<Paginated<FailureRecord>> {
      return pageSchema(failureSchema).parse(
        await client.request(`/jobs/${jobId}/failures?page=${page}&pageSize=${pageSize}`),
      );
    },
    async getScoring(jobId: string) {
      return currentScoringSchema.parse(await client.request(`/jobs/${jobId}/scoring`));
    },
    async scoreJob(jobId: string, configuration: ScoringInput) {
      return scoringSummarySchema.parse(
        await client.request(`/jobs/${jobId}/scoring`, jsonBody(configuration)),
      );
    },
    async getDashboard(jobId: string): Promise<DashboardSummary> {
      return dashboardSchema.parse(await client.request(`/jobs/${jobId}/dashboard`));
    },
    async getStores(
      jobId: string,
      options: { page: number; pageSize: number; tier?: StoreTier },
    ): Promise<Paginated<StoreRecord>> {
      const query = new URLSearchParams({
        page: String(options.page),
        pageSize: String(options.pageSize),
      });
      if (options.tier) query.set('tier', options.tier);
      return pageSchema(storeSchema).parse(
        await client.request(`/jobs/${jobId}/stores?${query.toString()}`),
      );
    },
  };
}

export const tierForgeApi = createTierForgeApi(apiClient);
