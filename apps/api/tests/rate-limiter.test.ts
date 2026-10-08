import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/workers/rate-limiter.js';

describe('shared request-start rate limiter', () => {
  it('paces many competing workers to at most five starts in a rolling second', async () => {
    let time = 0;
    const starts: number[] = [];
    const limiter = createRateLimiter({
      minimumIntervalMs: 220,
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
    });

    await Promise.all(
      Array.from({ length: 20 }, async () => {
        await limiter.waitForSlot();
        starts.push(time);
      }),
    );

    expect(starts).toHaveLength(20);
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(220);
    }
    for (let index = 5; index < starts.length; index += 1) {
      expect(starts[index]! - starts[index - 5]!).toBeGreaterThan(1000);
    }
  });

  it('applies a provider cooldown to callers already waiting for admission', async () => {
    let time = 0;
    const limiter = createRateLimiter({
      minimumIntervalMs: 220,
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
    });
    await limiter.waitForSlot();
    const waiting = limiter.waitForSlot();
    limiter.deferFor(2000);
    await waiting;
    expect(time).toBe(2000);
  });
});
