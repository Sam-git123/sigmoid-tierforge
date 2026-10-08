import { describe, expect, it, vi } from 'vitest';
import { createJobService } from '../src/services/job-service.js';
import type { JobRepository } from '../src/repositories/job-repository.js';
import { ActiveJobConflict } from '../src/errors/active-job-conflict.js';

const csv = Buffer.from(
  'store_id,store_name,address,city,state,country\nST1,Name,Address,City,State,Country',
);
function setup() {
  const repository: JobRepository = {
    createJobWithStores: vi.fn(),
    getJobById: vi.fn(),
    getJobProgress: vi.fn(),
    findActiveJob: vi.fn(),
  };
  const service = createJobService(repository, { maxBytes: 10000, maxRows: 100, maxAttempts: 4 });
  return { repository, service };
}
describe('job service boundaries', () => {
  it('validates the complete upload before touching the repository', async () => {
    const { repository, service } = setup();
    await expect(
      service.createJob(Buffer.concat([csv, Buffer.from('\nST1,Duplicate,A,C,S,I')])),
    ).rejects.toMatchObject({ status: 422 });
    expect(repository.createJobWithStores).not.toHaveBeenCalled();
    expect(repository.findActiveJob).not.toHaveBeenCalled();
  });
  it('passes configured attempt limits to atomic creation', async () => {
    const { repository, service } = setup();
    vi.mocked(repository.createJobWithStores).mockResolvedValue({
      jobId: 'created-id',
      status: 'queued',
      totalStores: 1,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
      failureCode: null,
      failureReason: null,
    });
    const result = await service.createJob(csv);
    expect(repository.createJobWithStores).toHaveBeenCalledWith(
      [
        {
          store_id: 'ST1',
          store_name: 'Name',
          address: 'Address',
          city: 'City',
          state: 'State',
          country: 'Country',
        },
      ],
      4,
    );
    expect(result.statusUrl).toBe('/api/jobs/created-id');
  });
  it('notifies the background coordinator only after durable creation', async () => {
    const { repository } = setup();
    vi.mocked(repository.createJobWithStores).mockResolvedValue({
      jobId: 'created-id',
      status: 'queued',
      totalStores: 1,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
      failureCode: null,
      failureReason: null,
    });
    const starter = { notifyJobCreated: vi.fn() };
    const service = createJobService(
      repository,
      { maxBytes: 10000, maxRows: 100, maxAttempts: 4 },
      starter,
    );
    await service.createJob(csv);
    expect(starter.notifyJobCreated).toHaveBeenCalledWith('created-id');
    expect(vi.mocked(repository.createJobWithStores).mock.invocationCallOrder[0]!).toBeLessThan(
      starter.notifyJobCreated.mock.invocationCallOrder[0]!,
    );
  });
  it('handles a conflict even if the winning job finishes before lookup', async () => {
    const { repository, service } = setup();
    vi.mocked(repository.createJobWithStores).mockRejectedValue(new ActiveJobConflict());
    vi.mocked(repository.findActiveJob).mockResolvedValue(null);
    await expect(service.createJob(csv)).rejects.toMatchObject({
      status: 409,
      code: 'ACTIVE_JOB_EXISTS',
      details: { activeJobId: null },
    });
  });
  it('does not mislabel unexpected database failures as conflicts', async () => {
    const { repository, service } = setup();
    const failure = new Error('database error');
    vi.mocked(repository.createJobWithStores).mockRejectedValue(failure);
    await expect(service.createJob(csv)).rejects.toBe(failure);
  });
  it('uses the atomic progress read without a separate metadata lookup', async () => {
    const { repository, service } = setup();
    vi.mocked(repository.getJobProgress).mockResolvedValue(null);
    await expect(service.getJob('missing')).rejects.toMatchObject({
      status: 404,
      code: 'JOB_NOT_FOUND',
    });
    expect(repository.getJobById).not.toHaveBeenCalled();
  });
});
