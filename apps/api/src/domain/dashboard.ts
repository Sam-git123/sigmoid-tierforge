import type { JobCounts, JobStatus } from './jobs.js';
import type { ScoringConfiguration, StoreTier, TierCounts } from './scoring.js';

export interface Pagination {
  page: number;
  pageSize: number;
}

export interface StoreListOptions extends Pagination {
  tier?: StoreTier;
}

export interface StoreReadModel {
  storeId: string;
  storeName: string;
  address: string;
  city: string;
  state: string;
  country: string;
  status: string;
  estimatedMonthlyFootfall: string | null;
  estimatedMonthlyRevenue: string | null;
  storeSizeSqft: string | null;
  score: string | null;
  tier: StoreTier | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface FailureReadModel {
  storeId: string;
  storeName: string;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  finalStatus: 'failed' | 'skipped';
}

export interface Paginated<T> {
  records: T[];
  page: number;
  pageSize: number;
  totalRecords: number;
  totalPages: number;
}

export interface DashboardSummary {
  job: {
    jobId: string;
    status: JobStatus;
    totalStores: number;
    counts: JobCounts;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    failureCode: string | null;
    failureReason: string | null;
  };
  successfullyEnrichedStores: number;
  failedStores: number;
  skippedStores: number;
  scoredStores: number;
  tierCounts: TierCounts;
  currentScoringRevision: number | null;
  currentScoringConfiguration: ScoringConfiguration | null;
}
