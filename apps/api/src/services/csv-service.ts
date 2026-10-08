import { CsvError, parse } from 'csv-parse/sync';
import { z } from 'zod';
import { requiredStoreColumns } from '../domain/jobs.js';
import type { CsvLimits, CsvWarning, StoreInput } from '../domain/jobs.js';
import { ApiError } from '../errors/api-error.js';

const requiredValue = z.string().trim().min(1, 'A nonblank value is required');
const storeSchema = z.object({
  store_id: requiredValue.max(256, 'Store ID must be at most 256 characters'),
  store_name: requiredValue,
  address: requiredValue,
  city: requiredValue,
  state: requiredValue,
  country: requiredValue,
});
const requiredColumnSet = new Set<string>(requiredStoreColumns);
const maxErrorDetails = 100;
const maxRecordCharacters = 65_536;

export function parseStoreCsv(buffer: Buffer, limits: CsvLimits) {
  if (buffer.byteLength > limits.maxBytes) {
    throw new ApiError(
      413,
      'CSV_FILE_TOO_LARGE',
      `CSV file exceeds the ${limits.maxBytes}-byte limit.`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new ApiError(400, 'INVALID_CSV_ENCODING', 'CSV file must contain valid UTF-8 text.');
  }
  if (text.includes('\0')) {
    throw new ApiError(
      400,
      'INVALID_CSV_ENCODING',
      'CSV file must contain UTF-8 text without NUL bytes.',
    );
  }

  const stores: StoreInput[] = [];
  const warnings: CsvWarning[] = [];
  const seenIds = new Map<string, number>();
  const errors: { row: number; field: string; message: string }[] = [];
  let errorCount = 0;
  let rowCount = 0;
  function addError(row: number, field: string, message: string) {
    errorCount += 1;
    if (errors.length < maxErrorDetails) errors.push({ row, field, message });
  }

  try {
    // The upload is byte-bounded before parsing. Returning null avoids a second
    // accumulated parser output; only validated stores and capped errors are retained.
    parse(text, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      max_record_size: maxRecordCharacters,
      columns: (rawHeaders: string[]) => {
        const headers = rawHeaders.map((header) => header.trim());
        const seen = new Set<string>();
        for (const header of headers) {
          if (!header)
            throw new ApiError(422, 'INVALID_CSV_HEADERS', 'CSV column names must not be blank.');
          if (seen.has(header)) {
            throw new ApiError(422, 'DUPLICATE_CSV_HEADER', `Duplicate CSV column: ${header}`, {
              column: header,
            });
          }
          seen.add(header);
        }
        const missing = requiredStoreColumns.filter((column) => !seen.has(column));
        if (missing.length) {
          throw new ApiError(422, 'MISSING_CSV_HEADER', `Missing required column: ${missing[0]}`, {
            columns: missing,
          });
        }
        const extra = headers.filter((header) => !requiredColumnSet.has(header));
        if (extra.length) {
          warnings.push({
            code: 'EXTRA_COLUMNS_IGNORED',
            message: 'Extra CSV columns were ignored.',
            columns: extra,
          });
        }
        // Disabled extra columns still participate in the parser's strict row-width check.
        return headers.map((header) => (requiredColumnSet.has(header) ? header : false));
      },
      on_record: (record: unknown, context) => {
        rowCount += 1;
        if (rowCount > limits.maxRows) {
          throw new ApiError(
            413,
            'CSV_TOO_MANY_ROWS',
            `CSV file exceeds the ${limits.maxRows}-store limit.`,
          );
        }
        const result = storeSchema.safeParse(record);
        if (!result.success) {
          for (const issue of result.error.issues) {
            const field = issue.path.join('.');
            addError(
              context.lines,
              field,
              `Invalid ${field} at row ${context.lines}: ${issue.message}`,
            );
          }
          return null;
        }
        const store = result.data;
        const originalRow = seenIds.get(store.store_id);
        if (originalRow !== undefined) {
          addError(
            context.lines,
            'store_id',
            `Duplicate store ID: ${store.store_id} (first seen at row ${originalRow})`,
          );
        } else {
          seenIds.set(store.store_id, context.lines);
          stores.push(store);
        }
        return null;
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof CsvError) {
      const row = typeof error.lines === 'number' ? error.lines : undefined;
      if (error.code === 'CSV_MAX_RECORD_SIZE') {
        throw new ApiError(
          413,
          'CSV_RECORD_TOO_LARGE',
          'CSV row exceeds the 65,536-character limit.',
          { row },
        );
      }
      throw new ApiError(
        400,
        'INVALID_CSV_STRUCTURE',
        `Invalid CSV structure${row === undefined ? '' : ` at row ${row}`}`,
        {
          row,
          reason: 'Check quoting and ensure every row has the same number of fields as the header.',
        },
      );
    }
    throw error;
  }
  if (errorCount) {
    throw new ApiError(
      422,
      'INVALID_CSV_ROWS',
      errors[0]?.message ?? 'CSV row validation failed.',
      {
        errors,
        totalErrors: errorCount,
        truncated: errorCount > errors.length,
      },
    );
  }
  if (!stores.length) throw new ApiError(422, 'EMPTY_CSV', 'No valid store records found.');
  return { stores, warnings };
}
