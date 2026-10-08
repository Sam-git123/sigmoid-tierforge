import { ApiError } from '../errors/api-error.js';

export type CheckDatabase = () => Promise<void>;

export function createHealthService(checkDatabase: CheckDatabase) {
  return {
    async check() {
      try {
        await checkDatabase();
      } catch {
        throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is unavailable.');
      }
      return { status: 'ok', database: 'up' } as const;
    },
  };
}
