import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { validateRequest } from '../src/middleware/validate-request.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requestContext } from '../src/middleware/request-context.js';
import { createLogger } from '../src/logging/logger.js';

const logger = createLogger('silent');
function testApp() {
  const app = express();
  app.use(requestContext(logger));
  app.get(
    '/example',
    validateRequest(
      z.object({
        query: z.object({ page: z.coerce.number().int().positive() }),
      }),
    ),
    (_req, res) => res.json(res.locals.validated),
  );
  app.get('/failure', () => {
    throw new Error('Internal secret');
  });
  app.use(errorHandler(logger));
  return app;
}
describe('validation and centralized errors', () => {
  it('parses query values without mutating Express query getters', async () => {
    const response = await request(testApp()).get('/example?page=2');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ query: { page: 2 } });
  });
  it('returns safe field details for rejected inputs', async () => {
    const response = await request(testApp()).get('/example?page=0');
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details[0].path).toBe('query.page');
  });
  it('hides unexpected error messages and stacks', async () => {
    const response = await request(testApp()).get('/failure');
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('Internal secret');
  });
});
