import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { ApiError } from '../errors/api-error.js';

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    let apiError = error instanceof ApiError ? error : null;
    if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed') {
      apiError = new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
    } else if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
      apiError = new ApiError(413, 'BODY_TOO_LARGE', 'Request body exceeds the allowed size.');
    }
    const status = apiError?.status ?? 500;
    if (status >= 500) {
      logger.error(
        { requestId: req.requestId, code: apiError?.code ?? 'INTERNAL_ERROR' },
        'Request failed',
      );
    }
    res.status(status).json({
      error: {
        code: apiError?.code ?? 'INTERNAL_ERROR',
        message: apiError?.message ?? 'An unexpected error occurred.',
        ...(apiError?.details !== undefined ? { details: apiError.details } : {}),
        requestId: req.requestId,
      },
    });
  };
}
