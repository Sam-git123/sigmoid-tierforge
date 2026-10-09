import type { Logger } from 'pino';
import type { EnrichmentClient } from '../clients/enrichment-client.js';
import type { ClaimedStore, EnrichmentMetrics } from '../domain/enrichment.js';
import { EnrichmentAttemptError } from '../errors/enrichment-error.js';
import type {
  AttemptFailure,
  EnrichmentRepository,
  SystemicFailureImpact,
} from '../repositories/enrichment-repository.js';
import type { RequestStartLimiter } from './rate-limiter.js';
import { computeBackoffDelayMs } from './retry-policy.js';

interface WorkerDependencies {
  jobId: string;
  workerId: number;
  repository: EnrichmentRepository;
  client: EnrichmentClient;
  rateLimiter: RequestStartLimiter;
  leaseDurationMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  systemicFailureStreak?: number;
  random?: () => number;
  logger: Logger;
}

function describeFailure(error: unknown): EnrichmentAttemptError {
  if (error instanceof EnrichmentAttemptError) {
    return error;
  }
  return new EnrichmentAttemptError({
    code: 'NETWORK_ERROR',
    message: 'Unexpected enrichment transport failure.',
    retryable: true,
  });
}

function systemicImpact(error: EnrichmentAttemptError): SystemicFailureImpact {
  if (error.status !== undefined && [401, 403, 404, 405].includes(error.status)) {
    return 'immediate';
  }
  if (
    ['RATE_LIMITED', 'PROVIDER_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'INVALID_RESPONSE'].includes(
      error.code,
    )
  ) {
    return 'increment';
  }
  return 'none';
}

function persistedFailure(error: EnrichmentAttemptError): AttemptFailure {
  return {
    code: error.code,
    message: error.message.slice(0, 1000),
    systemicImpact: systemicImpact(error),
  };
}

function exhaustedFailure(error: EnrichmentAttemptError, attempts: number): AttemptFailure {
  return {
    code: 'RETRY_EXHAUSTED',
    message: (
      `Retry attempts exhausted after ${attempts} attempts. ` +
      `Last error: ${error.code} - ${error.message}`
    ).slice(0, 1000),
    systemicImpact: systemicImpact(error),
  };
}

function retryDelay(
  error: EnrichmentAttemptError,
  claim: ClaimedStore,
  dependencies: WorkerDependencies,
) {
  const backoff = computeBackoffDelayMs({
    attemptNumber: claim.attemptCount,
    baseDelayMs: dependencies.retryBaseDelayMs,
    maxDelayMs: dependencies.retryMaxDelayMs,
    ...(dependencies.random ? { random: dependencies.random } : {}),
  });
  return Math.max(backoff, error.retryAfterMs ?? 0);
}

function errorLog(error: EnrichmentAttemptError) {
  return {
    code: error.code,
    status: error.status,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
  };
}

/*
 * Attempts execute outside database transactions. The current token is checked
 * again by every persistence path, so a timed-out request can settle late without
 * obtaining permission to change durable state.
 */
export async function runWorker(dependencies: WorkerDependencies): Promise<void> {
  const { jobId, workerId, repository, client, rateLimiter, leaseDurationMs, logger } =
    dependencies;
  while (true) {
    const claim = await repository.claimNextStore(jobId, leaseDurationMs);
    if (!claim) return;
    logger.debug({ workerId, ...correlation(claim) }, 'Store claimed');
    let metrics: EnrichmentMetrics;
    try {
      await rateLimiter.waitForSlot();
      if (!(await repository.isClaimCurrent(claim))) {
        logger.warn({ workerId, ...correlation(claim) }, 'Expired or revoked claim not dispatched');
        continue;
      }
      logger.info({ workerId, ...correlation(claim) }, 'Enrichment attempt started');
      metrics = await client.enrich(claim);
    } catch (cause) {
      const error = describeFailure(cause);
      if (error.retryAfterMs !== undefined) {
        rateLimiter.deferFor(error.retryAfterMs);
      }
      logger.warn(
        { workerId, ...correlation(claim), ...errorLog(error) },
        'Enrichment attempt failed',
      );
      const canRetry = error.retryable && claim.attemptCount < claim.maxAttempts;
      const failure = canRetry
        ? persistedFailure(error)
        : error.retryable
          ? exhaustedFailure(error, claim.attemptCount)
          : persistedFailure(error);
      const result = await repository.recordAttemptFailure(
        claim,
        failure,
        canRetry ? retryDelay(error, claim, dependencies) : null,
        dependencies.systemicFailureStreak ?? 30,
      );
      if (result.disposition === 'stale') {
        logger.warn({ workerId, ...correlation(claim) }, 'Stale enrichment failure discarded');
      } else if (result.disposition === 'retry_wait') {
        logger.info(
          { workerId, ...correlation(claim), nextAttemptAt: result.nextAttemptAt },
          'Enrichment retry scheduled',
        );
      } else if (result.disposition === 'job_failed') {
        logger.error(
          { workerId, ...correlation(claim) },
          'Systemic enrichment failure stopped job',
        );
      }
      continue;
    }
    const accepted = await repository.completeStore(claim, metrics);
    if (accepted) {
      logger.info({ workerId, ...correlation(claim) }, 'Enrichment attempt succeeded');
    } else {
      logger.warn({ workerId, ...correlation(claim) }, 'Stale enrichment result discarded');
    }
  }
}

function correlation(claim: ClaimedStore) {
  return {
    jobId: claim.jobId,
    storeId: claim.storeId,
    attemptCount: claim.attemptCount,
    leaseToken: claim.leaseToken,
  };
}
