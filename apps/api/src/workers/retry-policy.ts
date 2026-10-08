interface BackoffOptions {
  attemptNumber: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random?: () => number;
}

// Full jitter selects a value from zero through the capped exponential delay.
// The jittered result itself never exceeds maxDelayMs.
export function computeBackoffDelayMs(options: BackoffOptions): number {
  if (!Number.isInteger(options.attemptNumber) || options.attemptNumber < 1) {
    throw new Error('attemptNumber must be a positive integer');
  }
  if (!Number.isFinite(options.baseDelayMs) || options.baseDelayMs <= 0) {
    throw new Error('baseDelayMs must be positive');
  }
  if (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < options.baseDelayMs) {
    throw new Error('maxDelayMs must be at least baseDelayMs');
  }
  const exponent = Math.min(options.attemptNumber - 1, 52);
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** exponent);
  const sample = Math.min(1, Math.max(0, (options.random ?? Math.random)()));
  return Math.floor(ceiling * sample);
}
