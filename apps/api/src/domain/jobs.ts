export const requiredStoreColumns = [
  'store_id',
  'store_name',
  'address',
  'city',
  'state',
  'country',
] as const;

export interface StoreInput {
  store_id: string;
  store_name: string;
  address: string;
  city: string;
  state: string;
  country: string;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed';

export interface Job {
  jobId: string;
  status: JobStatus;
  totalStores: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  failureCode: string | null;
  failureReason: string | null;
}

export interface JobCounts {
  pending: number;
  processing: number;
  retryWait: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface JobProgress extends Job {
  counts: JobCounts;
}

export interface CsvLimits {
  maxBytes: number;
  maxRows: number;
}

export interface CsvWarning {
  code: 'EXTRA_COLUMNS_IGNORED';
  message: string;
  columns: string[];
}
