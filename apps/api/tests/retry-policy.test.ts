import { describe, expect, it } from 'vitest';
import { computeBackoffDelayMs } from '../src/workers/retry-policy.js';

describe('retry backoff policy', () => {
  it.each([
    [1, 1, 1000],
    [2, 1, 2000],
    [3, 0.5, 2000],
    [4, 0.25, 2000],
  ])(
    'computes capped exponential full jitter for attempt %i',
    (attemptNumber, random, expected) => {
      expect(
        computeBackoffDelayMs({
          attemptNumber,
          baseDelayMs: 1000,
          maxDelayMs: 30000,
          random: () => random,
        }),
      ).toBe(expected);
    },
  );

  it('caps the final jittered delay at the configured maximum', () => {
    expect(
      computeBackoffDelayMs({
        attemptNumber: 20,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
        random: () => 1,
      }),
    ).toBe(30000);
  });

  it('can choose the lower bound without producing a negative delay', () => {
    expect(
      computeBackoffDelayMs({
        attemptNumber: 1,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
        random: () => 0,
      }),
    ).toBe(0);
  });
});
