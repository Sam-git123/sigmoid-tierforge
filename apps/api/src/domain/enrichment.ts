export interface EnrichmentStore {
  jobId: string;
  storeId: string;
  storeName: string;
  address: string;
  city: string;
  state: string;
  country: string;
}

export interface ClaimedStore extends EnrichmentStore {
  attemptCount: number;
  leaseToken: string;
  leaseExpiresAt: Date;
}

export interface EnrichmentMetrics {
  estimatedMonthlyFootfall: number;
  estimatedMonthlyRevenue: number;
  storeSizeSqft: number;
}

export interface JobProcessingSummary {
  jobId: string;
  status: 'completed' | 'completed_with_errors' | 'failed';
  succeeded: number;
  failed: number;
  skipped: number;
}
