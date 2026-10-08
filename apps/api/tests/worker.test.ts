import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EnrichmentClient } from '../src/clients/enrichment-client.js';
import type { ClaimedStore } from '../src/domain/enrichment.js';
import { EnrichmentAttemptError } from '../src/errors/enrichment-error.js';
import type { EnrichmentRepository } from '../src/repositories/enrichment-repository.js';
import { createLogger } from '../src/logging/logger.js';
import type { RequestStartLimiter } from '../src/workers/rate-limiter.js';
import { runWorker } from '../src/workers/worker.js';

function claim(storeId: string, attemptCount = 1, maxAttempts = 5): ClaimedStore {
  return {
    jobId: '00000000-0000-4000-8000-000000000001',
    storeId,
    storeName: 'Store',
    address: 'Address',
    city: 'City',
    state: 'State',
    country: 'Country',
    attemptCount,
    maxAttempts,
    leaseToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 20_000),
  };
}

function repositoryWithClaims(claims: ClaimedStore[]): EnrichmentRepository {
  return {
    findActiveJobId: vi.fn(),
    startJob: vi.fn(),
    claimNextStore: vi.fn().mockImplementation(async () => claims.shift() ?? null),
    completeStore: vi.fn().mockResolvedValue(true),
    recordAttemptFailure: vi.fn().mockResolvedValue({
      disposition: 'retry_wait',
      nextAttemptAt: new Date(Date.now() + 1000),
    }),
    getNextRetryWakeup: vi.fn(),
    finishJobIfDone: vi.fn(),
  };
}

function limiter(): RequestStartLimiter {
  return {
    waitForSlot: vi.fn().mockResolvedValue(undefined),
    deferFor: vi.fn(),
  };
}

function workerOptions(
  repository: EnrichmentRepository,
  client: EnrichmentClient,
  rateLimiter = limiter(),
) {
  return {
    jobId: '00000000-0000-4000-8000-000000000001',
    workerId: 0,
    repository,
    client,
    rateLimiter,
    leaseDurationMs: 20_000,
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 30_000,
    random: () => 1,
    logger: createLogger('silent'),
  };
}

describe('enrichment worker', () => {
  it('claims a bounded sequence, waits for admission, and persists each success', async () => {
    const repository = repositoryWithClaims([claim('S1'), claim('S2')]);
    const client: EnrichmentClient = {
      enrich: vi.fn().mockResolvedValue({
        estimatedMonthlyFootfall: 10,
        estimatedMonthlyRevenue: 20,
        storeSizeSqft: 30,
      }),
    };
    const rateLimiter = limiter();
    await runWorker(workerOptions(repository, client, rateLimiter));
    expect(repository.claimNextStore).toHaveBeenCalledTimes(3);
    expect(rateLimiter.waitForSlot).toHaveBeenCalledTimes(2);
    expect(client.enrich).toHaveBeenCalledTimes(2);
    expect(repository.completeStore).toHaveBeenCalledTimes(2);
    expect(repository.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it.each([
    [
      '500',
      new EnrichmentAttemptError({
        code: 'PROVIDER_ERROR',
        message: 'Enrichment API returned HTTP 500.',
        retryable: true,
        status: 500,
      }),
      'PROVIDER_ERROR',
    ],
    [
      '429',
      new EnrichmentAttemptError({
        code: 'RATE_LIMITED',
        message: 'Enrichment API rate limit exceeded.',
        retryable: true,
        status: 429,
        retryAfterMs: 2500,
      }),
      'RATE_LIMITED',
    ],
    ['network error', new Error('connection reset'), 'NETWORK_ERROR'],
  ] as const)('retries a %s and then persists success', async (_name, firstError, code) => {
    const repository = repositoryWithClaims([claim('S1', 1), claim('S1', 2)]);
    const client: EnrichmentClient = {
      enrich: vi.fn().mockRejectedValueOnce(firstError).mockResolvedValueOnce({
        estimatedMonthlyFootfall: 10,
        estimatedMonthlyRevenue: 20,
        storeSizeSqft: 30,
      }),
    };
    const rateLimiter = limiter();
    await runWorker(workerOptions(repository, client, rateLimiter));
    expect(repository.recordAttemptFailure).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: 'S1', attemptCount: 1 }),
      expect.objectContaining({ code }),
      code === 'RATE_LIMITED' ? 2500 : 1000,
    );
    expect(repository.completeStore).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: 'S1', attemptCount: 2 }),
      expect.any(Object),
    );
    expect(rateLimiter.waitForSlot).toHaveBeenCalledTimes(2);
    if (code === 'RATE_LIMITED') expect(rateLimiter.deferFor).toHaveBeenCalledWith(2500);
  });

  it('marks a retryable failure exhausted at the configured attempt limit', async () => {
    const repository = repositoryWithClaims([claim('S1', 5, 5)]);
    vi.mocked(repository.recordAttemptFailure).mockResolvedValue({ disposition: 'failed' });
    const client: EnrichmentClient = {
      enrich: vi.fn().mockRejectedValue(
        new EnrichmentAttemptError({
          code: 'PROVIDER_ERROR',
          message: 'Enrichment API returned HTTP 500.',
          retryable: true,
          status: 500,
        }),
      ),
    };
    await runWorker(workerOptions(repository, client));
    expect(repository.recordAttemptFailure).toHaveBeenCalledWith(
      expect.objectContaining({ attemptCount: 5, maxAttempts: 5 }),
      {
        code: 'RETRY_EXHAUSTED',
        message:
          'Retry attempts exhausted after 5 attempts. Last error: PROVIDER_ERROR - Enrichment API returned HTTP 500.',
      },
      null,
    );
    expect(repository.completeStore).not.toHaveBeenCalled();
  });

  it('does not retry a permanent provider request error', async () => {
    const repository = repositoryWithClaims([claim('S1')]);
    vi.mocked(repository.recordAttemptFailure).mockResolvedValue({ disposition: 'failed' });
    const client: EnrichmentClient = {
      enrich: vi.fn().mockRejectedValue(
        new EnrichmentAttemptError({
          code: 'PERMANENT_ERROR',
          message: 'Enrichment API returned HTTP 400.',
          retryable: false,
          status: 400,
        }),
      ),
    };
    await runWorker(workerOptions(repository, client));
    expect(repository.recordAttemptFailure).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ code: 'PERMANENT_ERROR' }),
      null,
    );
  });
});
