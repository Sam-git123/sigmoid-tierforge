import type { Logger } from 'pino';
import type { EnrichmentClient } from '../clients/enrichment-client.js';
import type {
  EnrichmentRepository,
  RetryWakeup,
} from '../repositories/enrichment-repository.js';
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
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  random?: () => number;
}

export interface EnrichmentCoordinator extends JobStartNotifier {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createCoordinator(dependencies: CoordinatorDependencies): EnrichmentCoordinator {
  const jobs = new Map<string, Promise<void>>();
  const retryTimers = new Map<string, NodeJS.Timeout>();
  let stopped = false;

  async function processJob(jobId: string): Promise<RetryWakeup | null> {
    const started = await dependencies.repository.startJob(jobId);
    if (!started) return null;
    dependencies.logger.info({ jobId }, 'Enrichment job started');
    const workers = Array.from({ length: dependencies.concurrency }, (_, workerId) =>
      runWorker({
        jobId,
        workerId,
        repository: dependencies.repository,
        client: dependencies.client,
        rateLimiter: dependencies.rateLimiter,
        leaseDurationMs: dependencies.leaseDurationMs,
        retryBaseDelayMs: dependencies.retryBaseDelayMs,
        retryMaxDelayMs: dependencies.retryMaxDelayMs,
        ...(dependencies.random ? { random: dependencies.random } : {}),
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
      return null;
    }
    const wakeup = await dependencies.repository.getNextRetryWakeup(jobId);
    if (!wakeup) {
      dependencies.logger.warn({ jobId }, 'Enrichment job stopped with unfinished work');
    }
    return wakeup;
  }

  function scheduleRetry(jobId: string, wakeup: RetryWakeup) {
    if (stopped) return;
    const existing = retryTimers.get(jobId);
    if (existing) clearTimeout(existing);
    const delay = Math.min(2_147_483_647, Math.max(0, Math.ceil(wakeup.delayMs)));
    const timer = setTimeout(() => {
      retryTimers.delete(jobId);
      launch(jobId);
    }, delay);
    timer.unref();
    retryTimers.set(jobId, timer);
    dependencies.logger.debug(
      { jobId, nextRetryAt: wakeup.nextRetryAt, delayMs: delay },
      'Enrichment retry wakeup scheduled',
    );
  }

  function launch(jobId: string) {
    if (stopped || jobs.has(jobId)) return;
    const timer = retryTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      retryTimers.delete(jobId);
    }
    const running = processJob(jobId)
      .then((wakeup) => {
        jobs.delete(jobId);
        if (wakeup) scheduleRetry(jobId, wakeup);
      })
      .catch(() => {
        jobs.delete(jobId);
        dependencies.logger.error({ jobId }, 'Enrichment coordinator failed');
      });
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
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      await Promise.allSettled(jobs.values());
    },
  };
}
