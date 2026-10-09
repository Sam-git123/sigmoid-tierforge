import { describe, expect, it, vi } from 'vitest';
import { createEnrichmentClient } from '../src/clients/enrichment-client.js';
import type { EnrichmentStore } from '../src/domain/enrichment.js';

const store: EnrichmentStore = {
  jobId: '00000000-0000-4000-8000-000000000001',
  storeId: 'ST000001',
  storeName: 'Fresh Supermarket #1',
  address: '71 Church Street',
  city: 'New Delhi',
  state: 'Delhi',
  country: 'India',
};

describe('enrichment client', () => {
  it('uses the documented five-field request and returns validated metrics', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          store_id: 'ST000001',
          estimated_monthly_footfall: 18234,
          estimated_monthly_revenue: 142033.5,
          store_size_sqft: 6210,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createEnrichmentClient({
      baseUrl: 'http://127.0.0.1:8000',
      timeoutMs: 1000,
      fetch: fetcher,
    });

    await expect(client.enrich(store)).resolves.toEqual({
      estimatedMonthlyFootfall: 18234,
      estimatedMonthlyRevenue: 142033.5,
      storeSizeSqft: 6210,
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:8000/enrich');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      store_id: 'ST000001',
      store_name: 'Fresh Supermarket #1',
      address: '71 Church Street',
      city: 'New Delhi',
      state: 'Delhi',
    });
  });

  it('classifies 429 and parses Retry-After as a retry lower bound', async () => {
    const client = createEnrichmentClient({
      baseUrl: 'http://127.0.0.1:8000/',
      timeoutMs: 1000,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('busy', { status: 429, headers: { 'retry-after': '2' } })),
    });
    await expect(client.enrich(store)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      status: 429,
      retryAfterMs: 2000,
    });
  });

  it('caps excessive Retry-After values so a job cannot wait indefinitely', async () => {
    const client = createEnrichmentClient({
      baseUrl: 'http://127.0.0.1:8000',
      timeoutMs: 1000,
      maxRetryAfterMs: 120_000,
      fetch: vi.fn().mockResolvedValue(
        new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '3000000' },
        }),
      ),
    });
    await expect(client.enrich(store)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 120_000,
    });
  });

  it.each([
    [500, 'PROVIDER_ERROR', true],
    [503, 'PROVIDER_ERROR', true],
    [400, 'PERMANENT_ERROR', false],
    [404, 'PERMANENT_ERROR', false],
  ] as const)('classifies HTTP %i as %s', async (status, code, retryable) => {
    const client = createEnrichmentClient({
      baseUrl: 'http://127.0.0.1:8000',
      timeoutMs: 1000,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('failure', { status })),
    });
    await expect(client.enrich(store)).rejects.toMatchObject({ code, retryable, status });
  });

  it.each([
    {
      store_id: 'OTHER',
      estimated_monthly_footfall: 1,
      estimated_monthly_revenue: 2,
      store_size_sqft: 3,
    },
    {
      store_id: 'ST000001',
      estimated_monthly_footfall: -1,
      estimated_monthly_revenue: 2,
      store_size_sqft: 3,
    },
    {
      store_id: 'ST000001',
      estimated_monthly_footfall: 1,
      estimated_monthly_revenue: '2',
      store_size_sqft: 3,
    },
  ])('rejects an invalid successful payload %#', async (payload) => {
    const client = createEnrichmentClient({
      baseUrl: 'http://127.0.0.1:8000',
      timeoutMs: 1000,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    });
    await expect(client.enrich(store)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: false,
    });
  });

  it('classifies transport failures without leaking their message', async () => {
    const client = createEnrichmentClient({
      baseUrl: 'http://127.0.0.1:8000',
      timeoutMs: 1000,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('private transport detail')),
    });
    await expect(client.enrich(store)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
      message: 'Enrichment request failed.',
    });
  });

  it('aborts a request at the configured timeout', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const client = createEnrichmentClient({
      baseUrl: 'http://127.0.0.1:8000',
      timeoutMs: 5,
      fetch: fetcher,
    });
    await expect(client.enrich(store)).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
  });

  it('releases the logical worker deadline even when the transport ignores abort', async () => {
    let resolveLate!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveLate = resolve;
        }),
    );
    const client = createEnrichmentClient({
      baseUrl: 'http://127.0.0.1:8000',
      timeoutMs: 5,
      fetch: fetcher,
    });
    await expect(client.enrich(store)).rejects.toMatchObject({ code: 'TIMEOUT' });
    resolveLate(
      new Response(
        JSON.stringify({
          store_id: store.storeId,
          estimated_monthly_footfall: 1,
          estimated_monthly_revenue: 2,
          store_size_sqft: 3,
        }),
        { status: 200 },
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
});
