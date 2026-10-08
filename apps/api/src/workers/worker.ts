import type { Logger } from 'pino';
import { EnrichmentClientError, type EnrichmentClient } from '../clients/enrichment-client.js';
import type { ClaimedStore, EnrichmentMetrics } from '../domain/enrichment.js';
import type {
  AttemptFailure,
  EnrichmentRepository,
} from '../repositories/enrichment-repository.js';
import type { RequestStartLimiter } from './rate-limiter.js';

interface WorkerDependencies {
  jobId: string;
  workerId: number;
  repository: EnrichmentRepository;
  client: EnrichmentClient;
  rateLimiter: RequestStartLimiter;
  leaseDurationMs: number;
  logger: Logger;
}

function describeFailure(error: unknown): AttemptFailure & { status?: number } {
  if (error instanceof EnrichmentClientError) {
    return {
      code: error.code,
      message: error.message.slice(0, 1000),
      ...(error.status !== undefined ? { status: error.status } : {}),
    };
  }
  return { code: 'ENRICHMENT_UNEXPECTED_ERROR', message: 'Unexpected enrichment failure.' };
}

function correlation(claim: ClaimedStore) {
  return {
    jobId: claim.jobId,
    storeId: claim.storeId,
    attemptCount: claim.attemptCount,
    leaseToken: claim.leaseToken,
  };
}

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
      logger.info({ workerId, ...correlation(claim) }, 'Enrichment attempt started');
      metrics = await client.enrich(claim);
    } catch (error) {
      const failure = describeFailure(error);
      logger.warn(
        { workerId, ...correlation(claim), code: failure.code, status: failure.status },
        'Enrichment attempt failed',
      );
      const accepted = await repository.failStore(claim, failure);
      if (!accepted) {
        logger.warn({ workerId, ...correlation(claim) }, 'Stale enrichment failure discarded');
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
