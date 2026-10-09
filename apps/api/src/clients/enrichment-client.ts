import { z } from 'zod';
import type { EnrichmentMetrics, EnrichmentStore } from '../domain/enrichment.js';
import { EnrichmentAttemptError } from '../errors/enrichment-error.js';

const responseSchema = z.object({
  store_id: z.string().min(1),
  estimated_monthly_footfall: z.number().finite().nonnegative(),
  estimated_monthly_revenue: z.number().finite().nonnegative(),
  store_size_sqft: z.number().finite().nonnegative(),
});

export interface EnrichmentClient {
  enrich(store: EnrichmentStore): Promise<EnrichmentMetrics>;
}

interface ClientOptions {
  baseUrl: string;
  timeoutMs: number;
  maxRetryAfterMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

function parseRetryAfter(
  value: string | null,
  now: () => number,
  maxRetryAfterMs: number,
): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(maxRetryAfterMs, Math.ceil(seconds * 1000));
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(maxRetryAfterMs, Math.max(0, timestamp - now()));
}

async function readSuccessfulResponse(
  response: Response,
  storeId: string,
): Promise<EnrichmentMetrics> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EnrichmentAttemptError({
      code: 'INVALID_RESPONSE',
      message: 'Enrichment API returned invalid JSON.',
      retryable: false,
    });
  }
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.store_id !== storeId) {
    throw new EnrichmentAttemptError({
      code: 'INVALID_RESPONSE',
      message: 'Enrichment API returned an invalid payload.',
      retryable: false,
    });
  }
  return {
    estimatedMonthlyFootfall: parsed.data.estimated_monthly_footfall,
    estimatedMonthlyRevenue: parsed.data.estimated_monthly_revenue,
    storeSizeSqft: parsed.data.store_size_sqft,
  };
}

async function executeRequest(
  fetcher: typeof fetch,
  endpoint: URL,
  store: EnrichmentStore,
  signal: AbortSignal,
  now: () => number,
  maxRetryAfterMs: number,
): Promise<EnrichmentMetrics> {
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        store_id: store.storeId,
        store_name: store.storeName,
        address: store.address,
        city: store.city,
        state: store.state,
      }),
      signal,
    });
  } catch {
    throw new EnrichmentAttemptError({
      code: 'NETWORK_ERROR',
      message: 'Enrichment request failed.',
      retryable: true,
    });
  }

  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now, maxRetryAfterMs);
    throw new EnrichmentAttemptError({
      code: 'RATE_LIMITED',
      message: 'Enrichment API rate limit exceeded.',
      retryable: true,
      status: response.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (response.status >= 500) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now, maxRetryAfterMs);
    throw new EnrichmentAttemptError({
      code: 'PROVIDER_ERROR',
      message: `Enrichment API returned HTTP ${response.status}.`,
      retryable: true,
      status: response.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (!response.ok) {
    throw new EnrichmentAttemptError({
      code: 'PERMANENT_ERROR',
      message: `Enrichment API returned HTTP ${response.status}.`,
      retryable: false,
      status: response.status,
    });
  }
  return readSuccessfulResponse(response, store.storeId);
}

export function createEnrichmentClient(options: ClientOptions): EnrichmentClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
  const endpoint = new URL('enrich', baseUrl);
  const now = options.now ?? Date.now;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 120_000;

  return {
    async enrich(store) {
      const controller = new AbortController();
      const request = executeRequest(
        fetcher,
        endpoint,
        store,
        controller.signal,
        now,
        maxRetryAfterMs,
      );
      // The transport may ignore abort and settle after the logical timeout. Keep a
      // rejection observer attached even after Promise.race has returned.
      void request.catch(() => undefined);
      let timeout: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new EnrichmentAttemptError({
              code: 'TIMEOUT',
              message: 'Enrichment request timed out.',
              retryable: true,
            }),
          );
          controller.abort();
        }, options.timeoutMs);
        timeout.unref();
      });
      try {
        return await Promise.race([request, deadline]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  };
}
