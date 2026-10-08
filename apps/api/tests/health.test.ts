import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logging/logger.js';

const logger = createLogger('silent');
describe('health and HTTP infrastructure', () => {
  it('reports database readiness with a request ID', async () => {
    const checkDatabase = vi.fn().mockResolvedValue(undefined);
    const response = await request(createApp({ logger, checkDatabase })).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', database: 'up' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(checkDatabase).toHaveBeenCalledOnce();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
  it('returns 503 with safe standard error when PostgreSQL is unavailable', async () => {
    const response = await request(
      createApp({
        logger,
        checkDatabase: vi.fn().mockRejectedValue(new Error('postgresql://private-password')),
      }),
    ).get('/api/health');
    expect(response.status).toBe(503);
    expect(response.body.error).toEqual({
      code: 'DATABASE_UNAVAILABLE',
      message: 'Database is unavailable.',
      requestId: response.headers['x-request-id'],
    });
    expect(JSON.stringify(response.body)).not.toContain('private-password');
  });
  it('has no premature job/enrichment/scoring endpoints', async () => {
    const app = createApp({ logger, checkDatabase: vi.fn() });
    for (const path of ['/api/jobs', '/api/enrich', '/api/scoring']) {
      const response = await request(app).post(path);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
  });
  it('uses the standard envelope for invalid JSON', async () => {
    const response = await request(createApp({ logger, checkDatabase: vi.fn() }))
      .post('/api/jobs')
      .set('Content-Type', 'application/json')
      .send('{broken');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
  });
  it('rejects oversized JSON using the standard envelope', async () => {
    const response = await request(createApp({ logger, checkDatabase: vi.fn() }))
      .post('/api/jobs')
      .send({ value: 'x'.repeat(110000) });
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('BODY_TOO_LARGE');
  });
});
