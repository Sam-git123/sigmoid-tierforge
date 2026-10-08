import type { Pool } from 'pg';
import type { Job, JobCounts, JobProgress, StoreInput } from '../domain/jobs.js';
import { withTransaction } from '../db/transaction.js';
import { ActiveJobConflict } from '../errors/active-job-conflict.js';

const jobColumns = `id AS "jobId", status, total_stores AS "totalStores",
  created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt",
  failure_code AS "failureCode", failure_reason AS "failureReason"`;
const batchSize = 500;

export interface JobRepository {
  createJobWithStores(stores: readonly StoreInput[], maxAttempts: number): Promise<Job>;
  getJobById(jobId: string): Promise<Job | null>;
  getJobProgress(jobId: string): Promise<JobProgress | null>;
  findActiveJob(): Promise<Job | null>;
}

export function createJobRepository(pool: Pool): JobRepository {
  return {
    async createJobWithStores(stores, maxAttempts) {
      if (!stores.length) throw new Error('Cannot create a job without stores');
      try {
        return await withTransaction(pool, async (client) => {
          const created = await client.query<Job>(
            `INSERT INTO jobs (status, total_stores) VALUES ('queued', $1) RETURNING ${jobColumns}`,
            [stores.length],
          );
          const job = created.rows[0];
          if (!job) throw new Error('Job insert did not return a row');
          for (let offset = 0; offset < stores.length; offset += batchSize) {
            const batch = stores.slice(offset, offset + batchSize);
            await client.query(
              `INSERT INTO job_stores
                (job_id, store_id, store_name, address, city, state, country, status, attempt_count, max_attempts)
               SELECT $1, input.store_id, input.store_name, input.address, input.city, input.state,
                 input.country, 'pending', 0, $2
               FROM jsonb_to_recordset($3::jsonb) AS input
                 (store_id text, store_name text, address text, city text, state text, country text)`,
              [job.jobId, maxAttempts, JSON.stringify(batch)],
            );
          }
          return job;
        });
      } catch (error) {
        // Translate only the active-job index, never unrelated uniqueness/DB failures.
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === '23505' &&
          'constraint' in error &&
          error.constraint === 'jobs_single_active_idx'
        ) {
          throw new ActiveJobConflict();
        }
        throw error;
      }
    },
    async getJobById(jobId) {
      const result = await pool.query<Job>(`SELECT ${jobColumns} FROM jobs WHERE id = $1`, [jobId]);
      return result.rows[0] ?? null;
    },
    async findActiveJob() {
      const result = await pool.query<Job>(
        `SELECT ${jobColumns} FROM jobs WHERE status IN ('queued', 'running') LIMIT 1`,
      );
      return result.rows[0] ?? null;
    },
    async getJobProgress(jobId) {
      // Job metadata and every count share one MVCC statement snapshot.
      const result = await pool.query<Job & JobCounts>(
        `SELECT j.id AS "jobId", j.status, j.total_stores AS "totalStores",
          j.created_at AS "createdAt", j.started_at AS "startedAt", j.finished_at AS "finishedAt",
          j.failure_code AS "failureCode", j.failure_reason AS "failureReason",
          (count(*) FILTER (WHERE s.status = 'pending'))::integer AS pending,
          (count(*) FILTER (WHERE s.status = 'processing'))::integer AS processing,
          (count(*) FILTER (WHERE s.status = 'retry_wait'))::integer AS "retryWait",
          (count(*) FILTER (WHERE s.status = 'succeeded'))::integer AS succeeded,
          (count(*) FILTER (WHERE s.status = 'failed'))::integer AS failed,
          (count(*) FILTER (WHERE s.status = 'skipped'))::integer AS skipped
        FROM jobs j LEFT JOIN job_stores s ON s.job_id = j.id
        WHERE j.id = $1 GROUP BY j.id`,
        [jobId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const { pending, processing, retryWait, succeeded, failed, skipped, ...job } = row;
      return { ...job, counts: { pending, processing, retryWait, succeeded, failed, skipped } };
    },
  };
}
