import { ApiClientError } from '../api/client';

const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatNumber(value: string | number | null): string {
  if (value === null) return '—';
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? numberFormatter.format(number) : String(value);
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (Array.isArray(error.details)) {
      const messages = error.details
        .filter((detail): detail is { message: string } => {
          return (
            typeof detail === 'object' &&
            detail !== null &&
            'message' in detail &&
            typeof detail.message === 'string'
          );
        })
        .map((detail) => detail.message);
      if (messages.length) return `${error.message} ${messages.join(' ')}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
