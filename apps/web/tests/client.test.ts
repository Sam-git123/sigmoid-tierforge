import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, createApiClient } from '../src/api/client';

describe('API client foundation', () => {
  it('joins the configured base and path and preserves cancellation/headers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"status":"ok"}'));
    const controller = new AbortController();
    const client = createApiClient('/api/', fetcher);
    expect(
      await client.request('/health', { signal: controller.signal, headers: { 'X-Test': 'yes' } }),
    ).toEqual({ status: 'ok' });
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/health');
    const options = fetcher.mock.calls[0]?.[1];
    expect(options?.signal).toBe(controller.signal);
    expect(new Headers(options?.headers).get('Accept')).toBe('application/json');
    expect(new Headers(options?.headers).get('X-Test')).toBe('yes');
  });
  it('preserves structured API errors and request IDs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'DATABASE_UNAVAILABLE',
            message: 'Database is unavailable.',
            requestId: 'id',
          },
        }),
        { status: 503 },
      ),
    );
    await expect(createApiClient('/api', fetcher).request('/health')).rejects.toMatchObject({
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      requestId: 'id',
    });
  });
  it('handles non-JSON failures without leaking upstream HTML', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>private</html>', { status: 502 }));
    await expect(createApiClient('/api', fetcher).request('/health')).rejects.toBeInstanceOf(
      ApiClientError,
    );
  });
  it('handles a 204 without trying to decode JSON', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    expect(await createApiClient('/api', fetcher).request('/health')).toBeNull();
  });
});
