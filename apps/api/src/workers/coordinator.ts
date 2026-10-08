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
  const jobs = new Map<string, Promise<void>>();
  const replacementTasks = new Set<Promise<void>>();
  const retryTimers = new Map<string, NodeJS.Timeout>();
  const watchdogTimers = new Map<string, NodeJS.Timeout>();
  const trackedJobs = new Set<string>();
  let stopped = false;

  function retryDelayForAttempt(attemptNumber: number) {
    return computeBackoffDelayMs({
      attemptNumber,
      baseDelayMs: dependencies.retryBaseDelayMs,
      maxDelayMs: dependencies.retryMaxDelayMs,
      ...(dependencies.random ? { random: dependencies.random } : {}),
    });
  }

  function clearTimer(map: Map<string, NodeJS.Timeout>, jobId: string) {
    const timer = map.get(jobId);
    if (timer) clearTimeout(timer);
    map.delete(jobId);
  }

  function stopTracking(jobId: string) {
    trackedJobs.delete(jobId);
    clearTimer(retryTimers, jobId);
    clearTimer(watchdogTimers, jobId);
  }

  function scheduleWatchdog(jobId: string) {
    if (stopped || !trackedJobs.has(jobId) || watchdogTimers.has(jobId)) return;
    const timer = setTimeout(() => {
      watchdogTimers.delete(jobId);
      void runWatchdog(jobId);
    }, leaseReaperIntervalMs);
    timer.unref();
    watchdogTimers.set(jobId, timer);
  }

  async function reconcileJob(jobId: string): Promise<RetryWakeup | null> {
    const summary = await dependencies.repository.finishJobIfDone(jobId);
    if (summary) {
      stopTracking(jobId);
      dependencies.logger.info(summary, 'Enrichment job processing summary');
      return null;
    }
    const wakeup = await dependencies.repository.getNextRetryWakeup(jobId);
    if (!wakeup) {
      dependencies.logger.debug({ jobId }, 'Enrichment job remains active without a due retry');
    }
    return wakeup;
  }

  async function processJob(jobId: string): Promise<RetryWakeup | null> {
    const started = await dependencies.repository.startJob(jobId);
    if (!started) {
      await reconcileJob(jobId);
      return null;
    }
    dependencies.logger.info({ jobId }, 'Enrichment job started or resumed');
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
        systemicFailureStreak,
        ...(dependencies.random ? { random: dependencies.random } : {}),
        logger: dependencies.logger,
      }),
    );
    const outcomes = await Promise.allSettled(workers);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected').length;
    if (rejected > 0) {
      dependencies.logger.error({ jobId, rejected }, 'Worker loops stopped unexpectedly');
    }
    return reconcileJob(jobId);
  }

  function scheduleRetry(jobId: string, wakeup: RetryWakeup) {
    if (stopped || !trackedJobs.has(jobId)) return;
    clearTimer(retryTimers, jobId);
    const delay = Math.min(2_147_483_647, Math.max(0, Math.ceil(wakeup.delayMs)));
    const timer = setTimeout(() => {
      retryTimers.delete(jobId);
      dispatch(jobId);
    }, delay);
    timer.unref();
    retryTimers.set(jobId, timer);
    dependencies.logger.debug(
      { jobId, nextRetryAt: wakeup.nextRetryAt, delayMs: delay },
      'Enrichment retry wakeup scheduled',
    );
  }

  function scheduleOperationalRetry(jobId: string) {
    scheduleRetry(jobId, {
      nextRetryAt: new Date(Date.now() + leaseReaperIntervalMs),
      delayMs: leaseReaperIntervalMs,
    });
  }

  function launchReplacement(jobId: string) {
    const task = runWorker({
      jobId,
      workerId: dependencies.concurrency,
      repository: dependencies.repository,
      client: dependencies.client,
      rateLimiter: dependencies.rateLimiter,
      leaseDurationMs: dependencies.leaseDurationMs,
      retryBaseDelayMs: dependencies.retryBaseDelayMs,
      retryMaxDelayMs: dependencies.retryMaxDelayMs,
      systemicFailureStreak,
      ...(dependencies.random ? { random: dependencies.random } : {}),
      logger: dependencies.logger,
    })
      .then(async () => {
        const wakeup = await reconcileJob(jobId);
        if (wakeup) scheduleRetry(jobId, wakeup);
      })
      .catch((error: unknown) => {
        dependencies.logger.error(
          { jobId, error: error instanceof Error ? error.message : 'Unknown error' },
          'Recovery worker stopped unexpectedly',
        );
        scheduleOperationalRetry(jobId);
      })
      .finally(() => {
        replacementTasks.delete(task);
      });
    replacementTasks.add(task);
  }

  function dispatch(jobId: string) {
    if (stopped || !trackedJobs.has(jobId)) return;
    if (jobs.has(jobId)) {
      launchReplacement(jobId);
      return;
    }
    launch(jobId);
  }

  function launch(jobId: string) {
    if (stopped || jobs.has(jobId)) return;
    trackedJobs.add(jobId);
    scheduleWatchdog(jobId);
    clearTimer(retryTimers, jobId);
    const running = processJob(jobId)
      .then((wakeup) => {
        jobs.delete(jobId);
        if (wakeup) {
          scheduleRetry(jobId, wakeup);
        } else if (trackedJobs.has(jobId)) {
          scheduleOperationalRetry(jobId);
        }
      })
      .catch((error: unknown) => {
        jobs.delete(jobId);
        dependencies.logger.error(
          { jobId, error: error instanceof Error ? error.message : 'Unknown error' },
          'Enrichment coordinator cycle failed',
        );
        if (trackedJobs.has(jobId)) scheduleOperationalRetry(jobId);
      });
    jobs.set(jobId, running);
  }

  async function runWatchdog(jobId: string) {
    if (stopped || !trackedJobs.has(jobId)) return;
    try {
      for (let recovered = 0; recovered < dependencies.concurrency; recovered += 1) {
        const result = await dependencies.repository.reclaimExpiredLease(
          jobId,
          retryDelayForAttempt,
          systemicFailureStreak,
        );
        if (!result) break;
        dependencies.logger.warn(
          { jobId, storeId: result.storeId, disposition: result.disposition },
          'Expired enrichment lease reclaimed',
        );
        if (result.disposition === 'job_failed') break;
      }
      const wakeup = await reconcileJob(jobId);
      if (wakeup) scheduleRetry(jobId, wakeup);
    } catch (error) {
      dependencies.logger.error(
        { jobId, error: error instanceof Error ? error.message : 'Unknown error' },
        'Enrichment watchdog scan failed',
      );
    } finally {
      scheduleWatchdog(jobId);
    }
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
      trackedJobs.clear();
      for (const timer of retryTimers.values()) clearTimeout(timer);
      for (const timer of watchdogTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      watchdogTimers.clear();
      await Promise.allSettled([...jobs.values(), ...replacementTasks]);
    },
  };
}
