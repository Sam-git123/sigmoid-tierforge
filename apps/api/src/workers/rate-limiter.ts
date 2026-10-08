import { performance } from 'node:perf_hooks';

export interface RequestStartLimiter {
  waitForSlot(): Promise<void>;
  deferFor(milliseconds: number): void;
}

interface RateLimiterOptions {
  minimumIntervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

// Serializing admission gives every caller one process-wide start time. Requiring a
// minimum interval greater than 1000 / maxRps guarantees the rolling-window limit.
export function createRateLimiter(options: RateLimiterOptions): RequestStartLimiter {
  const now = options.now ?? performance.now.bind(performance);
  const sleep = options.sleep ?? defaultSleep;
  let nextStartAt = 0;
  let admission = Promise.resolve();

  return {
    deferFor(milliseconds) {
      nextStartAt = Math.max(nextStartAt, now() + Math.max(0, milliseconds));
    },
    waitForSlot() {
      const slot = admission.then(async () => {
        const delay = Math.max(0, nextStartAt - now());
        if (delay > 0) await sleep(delay);
        const startedAt = now();
        nextStartAt = startedAt + options.minimumIntervalMs;
      });
      admission = slot.catch(() => undefined);
      return slot;
    },
  };
}
