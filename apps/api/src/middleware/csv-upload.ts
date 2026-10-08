import type { RequestHandler } from 'express';
import multer from 'multer';
import { ApiError } from '../errors/api-error.js';

const allowedTypes = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

export function csvUpload(maxBytes: number): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes + 1, files: 1, fields: 0, parts: 2, headerPairs: 100 },
    fileFilter: (_req, file, callback) => {
      if (!/\.csv$/i.test(file.originalname) || !allowedTypes.has(file.mimetype.toLowerCase())) {
        callback(
          new ApiError(
            415,
            'UNSUPPORTED_FILE_TYPE',
            'Upload a .csv file containing UTF-8 CSV text.',
          ),
        );
        return;
      }
      callback(null, true);
    },
  }).single('file');

  return (req, res, next) => {
    if (!req.headers['content-type']) {
      next(
        new ApiError(
          400,
          'CSV_FILE_REQUIRED',
          'A CSV file is required in the multipart field "file".',
        ),
      );
      return;
    }
    if (!req.is('multipart/form-data')) {
      next(
        new ApiError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'Use multipart/form-data with a CSV file in the "file" field.',
        ),
      );
      return;
    }
    upload(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
        next(
          error.code === 'LIMIT_FILE_SIZE'
            ? new ApiError(
                413,
                'CSV_FILE_TOO_LARGE',
                `CSV file exceeds the ${maxBytes}-byte limit.`,
              )
            : new ApiError(
                400,
                'INVALID_MULTIPART',
                'Upload exactly one CSV file in the "file" field, without other fields.',
              ),
        );
        return;
      }
      if (error instanceof ApiError) {
        next(error);
        return;
      }
      if (
        error instanceof Error &&
        /boundary not found|unexpected end of (form|file)|malformed part header/i.test(
          error.message,
        )
      ) {
        next(
          new ApiError(
            400,
            'INVALID_MULTIPART',
            'Malformed multipart upload. Include a complete file and multipart boundary.',
          ),
        );
        return;
      }
      if (error) {
        next(error);
        return;
      }
      if (!req.file) {
        next(
          new ApiError(
            400,
            'CSV_FILE_REQUIRED',
            'A CSV file is required in the multipart field "file".',
          ),
        );
        return;
      }
      if (req.file.size > maxBytes) {
        next(
          new ApiError(413, 'CSV_FILE_TOO_LARGE', `CSV file exceeds the ${maxBytes}-byte limit.`),
        );
        return;
      }
      next();
    });
  };
}
