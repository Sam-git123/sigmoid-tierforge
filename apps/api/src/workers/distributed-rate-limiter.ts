import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { RequestStartLimiter } from './rate-limiter.js';

interface DistributedRateLimiterOptions {
  pool: Pool;
  minimumIntervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/*
 * The singleton row is locked only while inspecting or reserving a slot.
 * Callers commit before sleeping, then compete again, so no connection or
 * transaction is held during rate-limit waits. A crashed process can waste a
 * reservation temporarily but cannot create an extra budget.
 */
export function createDistributedRateLimiter(
  options: DistributedRateLimiterOptions,
): RequestStartLimiter {
  const sleep = options.sleep ?? defaultSleep;

  return {
    async waitForSlot() {
      while (true) {
        const delayMs = await withTransaction(options.pool, async (client) => {
          const state = await client.query<{ delayMs: number }>(
            `SELECT greatest(
                0,
                extract(epoch FROM (
                  greatest(next_start_at, cooldown_until) - clock_timestamp()
                )) * 1000
              )::double precision AS "delayMs"
             FROM enrichment_rate_limit
             WHERE singleton = true
             FOR UPDATE`,
          );
          const delay = state.rows[0]?.delayMs;
          if (delay === undefined) throw new Error('Global rate-limit state is missing');
          if (delay > 0) return delay;
          await client.query(
            `UPDATE enrichment_rate_limit
             SET next_start_at = clock_timestamp() + ($1 * interval '1 millisecond'),
                 updated_at = clock_timestamp()
             WHERE singleton = true`,
            [options.minimumIntervalMs],
          );
          return 0;
        });
        if (delayMs <= 0) return;
        await sleep(Math.max(1, Math.ceil(delayMs)));
      }
    },

    async deferFor(milliseconds) {
      await options.pool.query(
        `UPDATE enrichment_rate_limit
         SET cooldown_until = greatest(
               cooldown_until,
               clock_timestamp() + ($1 * interval '1 millisecond')
             ),
             updated_at = clock_timestamp()
         WHERE singleton = true`,
        [Math.max(0, milliseconds)],
      );
    },
  };
}
