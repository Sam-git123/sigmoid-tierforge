import type { Pool } from 'pg';

export function createHealthRepository(pool: Pool) {
  return {
    async checkDatabase(): Promise<void> {
      await pool.query('SELECT 1');
    },
  };
}
