import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { ApiError } from '../errors/api-error.js';

// Keep parsed input in locals: Express 5 exposes req.query as a getter.
export function validateRequest(schema: ZodType): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) {
      next(
        new ApiError(
          422,
          'VALIDATION_ERROR',
          'Request validation failed.',
          result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        ),
      );
      return;
    }
    res.locals.validated = result.data;
    next();
  };
}
