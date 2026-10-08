import { describe, expect, it } from 'vitest';
import { parseEnvironment } from '../src/config/env.js';

const valid = { DATABASE_URL: 'postgresql://local:example@localhost:5432/tierforge' };
describe('environment validation', () => {
  it('applies safe foundation defaults', () => {
    expect(parseEnvironment(valid)).toMatchObject({
      API_PORT: 3001,
      WORKER_CONCURRENCY: 5,
      ENRICHMENT_MAX_RPS: 5,
      ENRICHMENT_TIMEOUT_MS: 10000,
      MAX_ATTEMPTS: 6,
      LEASE_DURATION_MS: 20000,
    });
  });
  it.each([
    {},
    { DATABASE_URL: 'https://localhost/db' },
    { ...valid, API_PORT: '0' },
    { ...valid, API_PORT: '65536' },
    { ...valid, API_PORT: '1.5' },
    { ...valid, API_PORT: '' },
    { ...valid, ENRICHMENT_API_BASE_URL: 'ftp://localhost' },
    { ...valid, ENRICHMENT_MAX_RPS: '6' },
    { ...valid, LEASE_DURATION_MS: '12000' },
    { ...valid, RETRY_CAP_MS: '500' },
    { ...valid, MIN_DISPATCH_INTERVAL_MS: '100' },
  ])('rejects invalid configuration %#', (env) => {
    expect(() => parseEnvironment(env)).toThrow('Invalid environment configuration');
  });
  it('does not expose credentials in validation errors', () => {
    expect(() => parseEnvironment({ DATABASE_URL: 'bad://user:secret-value@localhost' })).toThrow(
      'Invalid environment configuration: DATABASE_URL',
    );
  });
  it('accepts explicit overrides without loading process globals', () => {
    expect(parseEnvironment({ ...valid, API_PORT: '4000', LOG_LEVEL: 'silent' }).API_PORT).toBe(
      4000,
    );
  });
});
