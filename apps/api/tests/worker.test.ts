import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EnrichmentClient } from '../src/clients/enrichment-client.js';
import type { ClaimedStore } from '../src/domain/enrichment.js';
import type { EnrichmentRepository } from '../src/repositories/enrichment-repository.js';
import { createLogger } from '../src/logging/logger.js';
import type { RequestStartLimiter } from '../src/workers/rate-limiter.js';
import { runWorker } from '../src/workers/worker.js';

function claim(storeId: string): ClaimedStore {
  return {
    jobId: '00000000-0000-4000-8000-000000000001',
    storeId,
    storeName: 'Store',
    address: 'Address',
    city: 'City',
    state: 'State',
    country: 'Country',
    attemptCount: 1,
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
    failStore: vi.fn().mockResolvedValue(true),
    finishJobIfDone: vi.fn(),
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
    const rateLimiter: RequestStartLimiter = { waitForSlot: vi.fn().mockResolvedValue(undefined) };
    await runWorker({
      jobId: '00000000-0000-4000-8000-000000000001',
      workerId: 0,
      repository,
      client,
      rateLimiter,
      leaseDurationMs: 20_000,
      logger: createLogger('silent'),
    });
    expect(repository.claimNextStore).toHaveBeenCalledTimes(3);
    expect(rateLimiter.waitForSlot).toHaveBeenCalledTimes(2);
    expect(client.enrich).toHaveBeenCalledTimes(2);
    expect(repository.completeStore).toHaveBeenCalledTimes(2);
    expect(repository.failStore).not.toHaveBeenCalled();
  });

  it('records a bounded Phase 3 failure and continues with later work', async () => {
    const repository = repositoryWithClaims([claim('S1'), claim('S2')]);
    const client: EnrichmentClient = {
      enrich: vi.fn().mockRejectedValueOnce(new Error('unexpected')).mockResolvedValueOnce({
        estimatedMonthlyFootfall: 10,
        estimatedMonthlyRevenue: 20,
        storeSizeSqft: 30,
      }),
    };
    await runWorker({
      jobId: '00000000-0000-4000-8000-000000000001',
      workerId: 0,
      repository,
      client,
      rateLimiter: { waitForSlot: vi.fn().mockResolvedValue(undefined) },
      leaseDurationMs: 20_000,
      logger: createLogger('silent'),
    });
    expect(repository.failStore).toHaveBeenCalledWith(expect.objectContaining({ storeId: 'S1' }), {
      code: 'ENRICHMENT_UNEXPECTED_ERROR',
      message: 'Unexpected enrichment failure.',
    });
    expect(repository.completeStore).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: 'S2' }),
      expect.any(Object),
    );
  });
});
