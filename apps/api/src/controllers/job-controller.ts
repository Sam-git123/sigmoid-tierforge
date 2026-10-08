import type { RequestHandler } from 'express';
import { ApiError } from '../errors/api-error.js';
import type { JobService } from '../services/job-service.js';

export function createJobController(service: JobService) {
  const create: RequestHandler = async (req, res) => {
    if (!req.file) throw new ApiError(400, 'CSV_FILE_REQUIRED', 'A CSV file is required.');
    const job = await service.createJob(req.file.buffer);
    res.location(job.statusUrl).status(202).json(job);
  };
  const get: RequestHandler = async (req, res) => {
    const jobId = req.params.jobId;
    if (typeof jobId !== 'string')
      throw new ApiError(422, 'VALIDATION_ERROR', 'Job ID must be a UUID.');
    res.json(await service.getJob(jobId));
  };
  return { create, get };
}
