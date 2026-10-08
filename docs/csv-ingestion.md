# Phase 2 CSV ingestion contract

`POST /api/jobs` accepts one UTF-8 `.csv` file in the multipart field `file`. It validates the entire bounded upload before opening the job-creation transaction. A successful request creates one queued job and one pending `job_stores` row per record. It never calls the enrichment API.

## Input policy

The exact required header names are `store_id`, `store_name`, `address`, `city`, `state`, and `country`. Header order may vary. An optional UTF-8 BOM and surrounding header whitespace are removed. Header names remain case-sensitive, and duplicate or blank headers are rejected.

All six fields are required and must be nonblank after trimming surrounding whitespace. They are not optional-looking in storage: each is nonnullable and needed to preserve the uploaded store record. Quoted commas, quotes, embedded standard line endings, CRLF/LF/CR files, Unicode text, and blank physical lines are supported by `csv-parse`. Store IDs are strings, preserve leading zeroes and case, and must be unique after trimming within one upload. The same ID may appear in a later historical job.

Extra columns are accepted and ignored. The successful response contains one `EXTRA_COLUMNS_IGNORED` warning listing them. Each data row must still contain exactly the number of fields declared by the complete header, including ignored columns; inconsistent rows are malformed.

Defaults are `CSV_MAX_BYTES=10485760` (10 MiB), `CSV_MAX_ROWS=10000`, and a 65,536-character parser record limit. At most 100 row-validation details are returned, together with the total and a truncation flag. An empty file, header-only file, or file whose records are all invalid returns `No valid store records found` or a more specific row error. Invalid rows are never partially accepted.

## Status codes

- `202`: job and every pending store committed; `Location` points to the status resource.
- `400`: malformed multipart or malformed CSV quoting/row width/UTF-8 structure.
- `413`: file, row count, or individual record exceeds its configured bound.
- `415`: request is not multipart, or the file name/type is not accepted as CSV input.
- `422`: missing/duplicate headers, blank required values, duplicate store IDs, no records, or invalid job UUID.
- `409`: another queued or running job owns the database-enforced active slot.
- `404`: requested job does not exist.

All errors use `{ "error": { "code", "message", "details?", "requestId" } }`. A conflict may include the currently active job ID. Unexpected database errors return the safe centralized `500` response.

## Persistence and progress

`createJobWithStores` inserts the job and batches of up to 500 stores through `jsonb_to_recordset`, all on one checked-out PostgreSQL connection and one transaction. Any batch failure rolls back the job and prior batches. `status='queued'`, `total_stores` equals validated records, and each store has `status='pending'`, `attempt_count=0`, and configured `max_attempts`.

`GET /api/jobs/:jobId` reads metadata and all six store-state counts in one aggregate SQL statement, so the response does not mix snapshots from multiple queries. It returns nested `counts` for pending, processing, retryWait, succeeded, failed, and skipped. No denormalized counters are maintained.
