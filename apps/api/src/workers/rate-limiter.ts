import { performance } from 'node:perf_hooks';

export interface RequestStartLimiter {
  waitForSlot(): Promise<void>;
  deferFor(milliseconds: number): Promise<void>;
}

interface RateLimiterOptions {
  minimumIntervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

// Deterministic in-memory implementation used by focused worker/unit tests. The
// server runtime uses distributed-rate-limiter.ts for cross-process admission.
export function createRateLimiter(options: RateLimiterOptions): RequestStartLimiter {
  const now = options.now ?? performance.now.bind(performance);
  const sleep = options.sleep ?? defaultSleep;
  let nextStartAt = 0;
  let admission = Promise.resolve();

  return {
    async deferFor(milliseconds) {
      nextStartAt = Math.max(nextStartAt, now() + Math.max(0, milliseconds));
    },
    waitForSlot() {
      const slot = admission.then(async () => {
        // A Retry-After can extend the shared cooldown while this caller is
        // asleep. Recheck after every timer so an already queued caller cannot
        // bypass the newer deadline.
        while (true) {
          const delay = Math.max(0, nextStartAt - now());
          if (delay <= 0) break;
          await sleep(delay);
        }
        const startedAt = now();
        nextStartAt = startedAt + options.minimumIntervalMs;
      });
      admission = slot.catch(() => undefined);
      return slot;
    },
  };
}
