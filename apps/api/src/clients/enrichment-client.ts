import { z } from 'zod';
import type { EnrichmentMetrics, EnrichmentStore } from '../domain/enrichment.js';

const responseSchema = z.object({
  store_id: z.string().min(1),
  estimated_monthly_footfall: z.number().finite().nonnegative(),
  estimated_monthly_revenue: z.number().finite().nonnegative(),
  store_size_sqft: z.number().finite().nonnegative(),
});

export type EnrichmentClientErrorKind = 'http' | 'invalid_response' | 'transport';

export class EnrichmentClientError extends Error {
  constructor(
    message: string,
    readonly kind: EnrichmentClientErrorKind,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EnrichmentClientError';
  }
}

export interface EnrichmentClient {
  enrich(store: EnrichmentStore): Promise<EnrichmentMetrics>;
}

interface ClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export function createEnrichmentClient(options: ClientOptions): EnrichmentClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
  const endpoint = new URL('enrich', baseUrl);

  return {
    async enrich(store) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      timeout.unref();
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
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timeout);
        if (controller.signal.aborted) {
          throw new EnrichmentClientError(
            'Enrichment request timed out.',
            'transport',
            'ENRICHMENT_TIMEOUT',
          );
        }
        throw new EnrichmentClientError(
          'Enrichment request failed.',
          'transport',
          'ENRICHMENT_TRANSPORT_ERROR',
        );
      }

      if (!response.ok) {
        clearTimeout(timeout);
        throw new EnrichmentClientError(
          `Enrichment API returned HTTP ${response.status}.`,
          'http',
          'ENRICHMENT_HTTP_ERROR',
          response.status,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) {
          throw new EnrichmentClientError(
            'Enrichment request timed out.',
            'transport',
            'ENRICHMENT_TIMEOUT',
          );
        }
        throw new EnrichmentClientError(
          'Enrichment API returned invalid JSON.',
          'invalid_response',
          'ENRICHMENT_INVALID_RESPONSE',
        );
      } finally {
        clearTimeout(timeout);
      }
      const parsed = responseSchema.safeParse(payload);
      if (!parsed.success || parsed.data.store_id !== store.storeId) {
        throw new EnrichmentClientError(
          'Enrichment API returned an invalid payload.',
          'invalid_response',
          'ENRICHMENT_INVALID_RESPONSE',
        );
      }
      return {
        estimatedMonthlyFootfall: parsed.data.estimated_monthly_footfall,
        estimatedMonthlyRevenue: parsed.data.estimated_monthly_revenue,
        storeSizeSqft: parsed.data.store_size_sqft,
      };
    },
  };
}
