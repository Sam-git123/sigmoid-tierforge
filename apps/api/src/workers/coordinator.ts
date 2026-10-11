import type { Logger } from 'pino';
import type { EnrichmentClient } from '../clients/enrichment-client.js';
import type { EnrichmentRepository, RetryWakeup } from '../repositories/enrichment-repository.js';
import type { JobStartNotifier } from '../services/job-service.js';
import type { RequestStartLimiter } from './rate-limiter.js';
import { computeBackoffDelayMs } from './retry-policy.js';
import { runWorker } from './worker.js';

interface CoordinatorDependencies {
  repository: EnrichmentRepository;
  client: EnrichmentClient;
  rateLimiter: RequestStartLimiter;
  logger: Logger;
  concurrency: number;
  leaseDurationMs: number;
  leaseReaperIntervalMs?: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  systemicFailureStreak?: number;
  random?: () => number;
}

export interface EnrichmentCoordinator extends JobStartNotifier {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createCoordinator(dependencies: CoordinatorDependencies): EnrichmentCoordinator {
  const leaseReaperIntervalMs = dependencies.leaseReaperIntervalMs ?? 1000;
  const systemicFailureStreak = dependencies.systemicFailureStreak ?? 30;
  let cycle: Promise<void> | null = null;
  let wakeTimer: NodeJS.Timeout | null = null;
  let watchdogTimer: NodeJS.Timeout | null = null;
  let rerunRequested = false;
  let watchdogCursor = 0;
  let started = false;
  let stopped = false;

  function retryDelayForAttempt(attemptNumber: number) {
    return computeBackoffDelayMs({
      attemptNumber,
      baseDelayMs: dependencies.retryBaseDelayMs,
      maxDelayMs: dependencies.retryMaxDelayMs,
      ...(dependencies.random ? { random: dependencies.random } : {}),
    });
  }

  function clearWakeTimer() {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = null;
  }

  function scheduleWake(wakeup?: RetryWakeup) {
    if (stopped) return;
    clearWakeTimer();
    const requestedDelay = wakeup?.delayMs ?? leaseReaperIntervalMs;
    const delay = Math.min(2_147_483_647, Math.max(0, Math.ceil(requestedDelay)));
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      kick();
    }, delay);
    wakeTimer.unref();
    if (wakeup) {
      dependencies.logger.debug(
        { nextRetryAt: wakeup.nextRetryAt, delayMs: delay },
        'Global enrichment retry wakeup scheduled',
      );
    }
  }

  async function reconcileActiveJobs(): Promise<RetryWakeup | null> {
    const jobIds = await dependencies.repository.findActiveJobIds();
    for (const jobId of jobIds) {
      const summary = await dependencies.repository.finishJobIfDone(jobId);
      if (summary) dependencies.logger.info(summary, 'Enrichment job processing summary');
    }
    return dependencies.repository.getNextRetryWakeupAcrossJobs();
  }

  async function runCycle() {
    const workers = Array.from({ length: dependencies.concurrency }, (_, workerId) =>
      runWorker({
        workerId,
        repository: dependencies.repository,
        client: dependencies.client,
        rateLimiter: dependencies.rateLimiter,
        leaseDurationMs: dependencies.leaseDurationMs,
        maxProcessing: dependencies.concurrency,
        shouldStop: () => stopped,
        retryBaseDelayMs: dependencies.retryBaseDelayMs,
        retryMaxDelayMs: dependencies.retryMaxDelayMs,
        systemicFailureStreak,
        ...(dependencies.random ? { random: dependencies.random } : {}),
        logger: dependencies.logger,
      }),
    );
    const outcomes = await Promise.allSettled(workers);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected').length;
    if (rejected > 0) {
      dependencies.logger.error({ rejected }, 'Shared worker loops stopped unexpectedly');
    }
    const wakeup = await reconcileActiveJobs();
    if (stopped) return;
    if (!rerunRequested) scheduleWake(wakeup ?? undefined);
  }

  function kick() {
    if (stopped || !started) return;
    clearWakeTimer();
    if (cycle) {
      rerunRequested = true;
      return;
    }
    rerunRequested = false;
    const running = runCycle()
      .catch((error: unknown) => {
        dependencies.logger.error(
          { error: error instanceof Error ? error.message : 'Unknown error' },
          'Enrichment coordinator cycle failed',
        );
        if (!stopped) scheduleWake();
      })
      .finally(() => {
        if (cycle === running) cycle = null;
        if (rerunRequested && !stopped) kick();
      });
    cycle = running;
  }

  function scheduleWatchdog() {
    if (stopped || watchdogTimer) return;
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      void runWatchdog();
    }, leaseReaperIntervalMs);
    watchdogTimer.unref();
  }

  async function runWatchdog() {
    if (stopped) return;
    try {
      const jobIds = await dependencies.repository.findActiveJobIds();
      const scans = Math.min(jobIds.length, dependencies.concurrency);
      for (let offset = 0; offset < scans; offset += 1) {
        const index = (watchdogCursor + offset) % jobIds.length;
        const jobId = jobIds[index]!;
        const result = await dependencies.repository.reclaimExpiredLease(
          jobId,
          retryDelayForAttempt,
          systemicFailureStreak,
        );
        if (result) {
          dependencies.logger.warn(
            { jobId, storeId: result.storeId, disposition: result.disposition },
            'Expired enrichment lease reclaimed',
          );
        }
      }
      if (jobIds.length > 0) watchdogCursor = (watchdogCursor + scans) % jobIds.length;
      kick();
    } catch (error) {
      dependencies.logger.error(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        'Enrichment watchdog scan failed',
      );
    } finally {
      scheduleWatchdog();
    }
  }

  return {
    async start() {
      if (started) return;
      started = true;
      stopped = false;
      scheduleWatchdog();
      kick();
    },

    notifyJobCreated() {
      setImmediate(kick);
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      clearWakeTimer();
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = null;
      await Promise.allSettled(cycle ? [cycle] : []);
    },
  };
}
