import type { Logger } from 'pino';
import type { EnrichmentClient } from '../clients/enrichment-client.js';
import type { EnrichmentRepository } from '../repositories/enrichment-repository.js';
import type { JobStartNotifier } from '../services/job-service.js';
import type { RequestStartLimiter } from './rate-limiter.js';
import { runWorker } from './worker.js';

interface CoordinatorDependencies {
  repository: EnrichmentRepository;
  client: EnrichmentClient;
  rateLimiter: RequestStartLimiter;
  logger: Logger;
  concurrency: number;
  leaseDurationMs: number;
}

export interface EnrichmentCoordinator extends JobStartNotifier {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createCoordinator(dependencies: CoordinatorDependencies): EnrichmentCoordinator {
  const jobs = new Map<string, Promise<void>>();
  let stopped = false;

  async function processJob(jobId: string) {
    const started = await dependencies.repository.startJob(jobId);
    if (!started) return;
    dependencies.logger.info({ jobId }, 'Enrichment job started');
    const workers = Array.from({ length: dependencies.concurrency }, (_, workerId) =>
      runWorker({
        jobId,
        workerId,
        repository: dependencies.repository,
        client: dependencies.client,
        rateLimiter: dependencies.rateLimiter,
        leaseDurationMs: dependencies.leaseDurationMs,
        logger: dependencies.logger,
      }),
    );
    const outcomes = await Promise.allSettled(workers);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected').length;
    if (rejected > 0) {
      dependencies.logger.error({ jobId, rejected }, 'Worker loops stopped unexpectedly');
    }
    const summary = await dependencies.repository.finishJobIfDone(jobId);
    if (summary) {
      dependencies.logger.info(summary, 'Enrichment job processing summary');
    } else {
      dependencies.logger.warn({ jobId }, 'Enrichment job stopped with unfinished work');
    }
  }

  function launch(jobId: string) {
    if (stopped || jobs.has(jobId)) return;
    const running = processJob(jobId)
      .catch(() => {
        dependencies.logger.error({ jobId }, 'Enrichment coordinator failed');
      })
      .finally(() => jobs.delete(jobId));
    jobs.set(jobId, running);
  }

  return {
    async start() {
      const activeJobId = await dependencies.repository.findActiveJobId();
      if (activeJobId) launch(activeJobId);
    },
    notifyJobCreated(jobId) {
      setImmediate(() => launch(jobId));
    },
    async stop() {
      stopped = true;
      await Promise.allSettled(jobs.values());
    },
  };
}
