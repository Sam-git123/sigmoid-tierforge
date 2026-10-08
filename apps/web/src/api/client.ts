export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createApiClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async request(path: string, options: RequestInit = {}): Promise<unknown> {
      if (!path.startsWith('/') || path.startsWith('//')) {
        throw new Error('API paths must start with a single slash');
      }
      const headers = new Headers(options.headers);
      headers.set('Accept', 'application/json');
      const response = await fetcher(`${base}${path}`, { ...options, headers });
      const payload: unknown =
        response.status === 204 ? null : await response.json().catch(() => null);
      if (!response.ok) {
        const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
        throw new ApiClientError(
          response.status,
          typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
          typeof error.message === 'string' ? error.message : 'The request could not be completed.',
          typeof error.requestId === 'string' ? error.requestId : undefined,
          error.details,
        );
      }
      return payload; // Callers validate their own response schema at the feature boundary.
    },
  };
}

export const apiClient = createApiClient(import.meta.env.VITE_API_BASE_URL || '/api');
