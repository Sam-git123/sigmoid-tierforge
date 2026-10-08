import type { CsvLimits } from '../domain/jobs.js';
import { ActiveJobConflict } from '../errors/active-job-conflict.js';
import { ApiError } from '../errors/api-error.js';
import type { JobRepository } from '../repositories/job-repository.js';
import { parseStoreCsv } from './csv-service.js';

export function createJobService(
  repository: JobRepository,
  options: CsvLimits & { maxAttempts: number },
) {
  return {
    async createJob(buffer: Buffer) {
      const { stores, warnings } = parseStoreCsv(buffer, options);
      try {
        const job = await repository.createJobWithStores(stores, options.maxAttempts);
        return { ...job, statusUrl: `/api/jobs/${job.jobId}`, warnings };
      } catch (error) {
        if (error instanceof ActiveJobConflict) {
          const active = await repository.findActiveJob();
          throw new ApiError(
            409,
            'ACTIVE_JOB_EXISTS',
            'Another job is queued or running. Wait for it to finish before uploading another CSV.',
            { activeJobId: active?.jobId ?? null },
          );
        }
        throw error;
      }
    },
    async getJob(jobId: string) {
      const job = await repository.getJobProgress(jobId);
      if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.');
      return job;
    },
  };
}

export type JobService = ReturnType<typeof createJobService>;
