export type EnrichmentErrorCode =
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'PERMANENT_ERROR'
  | 'RETRY_EXHAUSTED'
  | 'LEASE_EXPIRED'
  | 'JOB_ABORTED_SYSTEMIC_FAILURE';

interface EnrichmentAttemptErrorOptions {
  code: Exclude<
    EnrichmentErrorCode,
    'RETRY_EXHAUSTED' | 'LEASE_EXPIRED' | 'JOB_ABORTED_SYSTEMIC_FAILURE'
  >;
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
}

export class EnrichmentAttemptError extends Error {
  readonly code: Exclude<
    EnrichmentErrorCode,
    'RETRY_EXHAUSTED' | 'LEASE_EXPIRED' | 'JOB_ABORTED_SYSTEMIC_FAILURE'
  >;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(options: EnrichmentAttemptErrorOptions) {
    super(options.message);
    this.name = 'EnrichmentAttemptError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}
