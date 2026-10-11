import type { CsvLimits } from '../domain/jobs.js';
import { ApiError } from '../errors/api-error.js';
import type { JobRepository } from '../repositories/job-repository.js';
import { parseStoreCsv } from './csv-service.js';

export interface JobStartNotifier {
  notifyJobCreated(jobId: string): void;
}

const noJobStarter: JobStartNotifier = { notifyJobCreated() {} };

export function createJobService(
  repository: JobRepository,
  options: CsvLimits & { maxAttempts: number },
  jobStarter: JobStartNotifier = noJobStarter,
) {
  return {
    async createJob(buffer: Buffer) {
      const { stores, warnings } = parseStoreCsv(buffer, options);
      const job = await repository.createJobWithStores(stores, options.maxAttempts);
      jobStarter.notifyJobCreated(job.jobId);
      return { ...job, statusUrl: `/api/jobs/${job.jobId}`, warnings };
    },
    async getJob(jobId: string) {
      const job = await repository.getJobProgress(jobId);
      if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.');
      return job;
    },
    async listJobs() {
      return repository.listJobs(50);
    },
  };
}

export type JobService = ReturnType<typeof createJobService>;
