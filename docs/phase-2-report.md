# Phase 2 handoff and verification

Date: 8 October 2026 (Asia/Calcutta). Scope: CSV ingestion, validation, queued job creation, and persisted job status only. No enrichment request, worker, scoring operation, dashboard screen, commit, or push was created.

## Delivered

- `POST /api/jobs` accepts one bounded multipart CSV in the `file` field, parses it with `csv-parse`, validates the complete upload, and returns a queued job.
- Header, row, encoding, store ID, file type, byte, row-count, and individual-record validation produce safe structured errors.
- `createJobWithStores`, `getJobById`, `getJobProgress`, and `findActiveJob` isolate SQL in the job repository.
- Job and pending stores are committed atomically. Stores are inserted in batches of 500 through `jsonb_to_recordset`, within one transaction, with zero attempts and configured maximum attempts.
- The existing partial unique index remains the authoritative single-active-job guard for both queued and running jobs, including simultaneous requests.
- `GET /api/jobs/:jobId` returns job lifecycle fields and all six persisted state counts from one aggregate SQL statement.
- The supplied 5,000-row Sigmoid CSV is accepted without calling the enrichment simulator.

The policy for required values, extra columns, empty lines, whitespace, case sensitivity, limits, and errors is documented in [csv-ingestion.md](csv-ingestion.md).

## API examples

```powershell
curl.exe -i -X POST http://127.0.0.1:3001/api/jobs -F "file=@stores_5000.csv;type=text/csv"
```

Successful upload (`202 Accepted`, with `Location: /api/jobs/<jobId>`):

```json
{
  "jobId": "45dbdc13-56f4-4921-9f70-ad8ad9d69c63",
  "status": "queued",
  "totalStores": 5000,
  "createdAt": "2026-10-08T11:50:00.000Z",
  "startedAt": null,
  "finishedAt": null,
  "failureCode": null,
  "failureReason": null,
  "statusUrl": "/api/jobs/45dbdc13-56f4-4921-9f70-ad8ad9d69c63",
  "warnings": []
}
```

```powershell
curl.exe http://127.0.0.1:3001/api/jobs/45dbdc13-56f4-4921-9f70-ad8ad9d69c63
```

Status (`200 OK`):

```json
{
  "jobId": "45dbdc13-56f4-4921-9f70-ad8ad9d69c63",
  "status": "queued",
  "totalStores": 5000,
  "createdAt": "2026-10-08T11:50:00.000Z",
  "startedAt": null,
  "finishedAt": null,
  "failureCode": null,
  "failureReason": null,
  "counts": {
    "pending": 5000,
    "processing": 0,
    "retryWait": 0,
    "succeeded": 0,
    "failed": 0,
    "skipped": 0
  }
}
```

Missing header (`422 Unprocessable Content`):

```json
{
  "error": {
    "code": "MISSING_CSV_HEADER",
    "message": "Missing required column: store_id",
    "details": { "columns": ["store_id"] },
    "requestId": "<request UUID>"
  }
}
```

Active job conflict (`409 Conflict`) returns `ACTIVE_JOB_EXISTS` and the active job ID when it is still active at lookup time.

## Actual verification

Environment: Windows PowerShell, Node 24.18.1, pnpm 12.10.1, and an isolated native PostgreSQL 18 instance on `127.0.0.1:55432`.

- `pnpm test`: API **125 passed** across seven files; web **4 passed**. Total: **129 passed, zero failed, zero skipped**.
- `pnpm test:db`: **63 passed** across the foundation and job API database suites.
- The job database suite covers valid upload, missing file, empty/header-only input, missing/duplicate headers, blank required values, duplicate store IDs, malformed quotes and row widths, extra-column warning policy, type/size/row limits, safe rollback after the job insert, rollback across multiple insert batches, queued/running conflicts, two concurrent HTTP submissions, historical jobs, progress states, and the actual 5,000-row file.
- `pnpm typecheck`: passed for API and web.
- `pnpm lint`: passed with zero warnings.
- `pnpm build`: API TypeScript compilation and Vite production build passed.
- `pnpm format:check` and `git diff --check`: passed.
- `pnpm db:migrate`, with a process-only working database URL override: passed and reported the database up to date. No migration change was necessary for Phase 2.
- Live HTTP smoke test: the running API accepted `stores_5000.csv` in **131 ms**, returned a queued job, and the status resource reported 5,000 pending with all other counts zero and null start/finish timestamps. The exact smoke job and its 5,000 test rows were removed afterward; the API and database were stopped.
- An upstream `fetch` spy remained unused during job creation, and `store_enrichments` stayed empty.
- The two original requirements copies still have identical SHA-256 `628AA66D3C38906A6E925002BC7B3C73909CA0A4A5BCA3091861AAA3DE83DF36`.

## Files added

- `apps/api/src/controllers/job-controller.ts`
- `apps/api/src/domain/jobs.ts`
- `apps/api/src/errors/active-job-conflict.ts`
- `apps/api/src/middleware/csv-upload.ts`
- `apps/api/src/repositories/job-repository.ts`
- `apps/api/src/routes/job-routes.ts`
- `apps/api/src/services/csv-service.ts`
- `apps/api/src/services/job-service.ts`
- `apps/api/tests/csv.test.ts`
- `apps/api/tests/helpers/app.ts`
- `apps/api/tests/helpers/test-database.ts`
- `apps/api/tests/job-service.test.ts`
- `apps/api/tests/jobs.database.test.ts`
- `docs/csv-ingestion.md`
- `docs/phase-2-report.md`

## Files modified

- `.env.example`
- `AGENTS.md`
- `README.md`
- `apps/api/package.json`
- `apps/api/src/app.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/server.ts`
- `apps/api/src/workers/README.md`
- `apps/api/tests/database.test.ts`
- `apps/api/tests/env.test.ts`
- `apps/api/tests/health.test.ts`
- `docs/architecture.md`
- `docs/database-schema.md`
- `docs/decisions-and-assumptions.md`
- `docs/implementation-plan.md`
- `pnpm-lock.yaml`

## Unresolved items and limits

- The ignored local `.env` currently has a JDBC-style `DATABASE_URL`, which the Node URL validator correctly rejects. Verification used the working `TEST_DATABASE_URL` as a process-only `DATABASE_URL` override and did not overwrite the user's local file. Change the local value to a `postgresql://` URL before running the API normally.
- Docker remains unavailable in this environment, so Compose runtime verification remains the Phase 1 limitation. Native PostgreSQL exercised the same SQL and constraints.
- Multipart bodies use bounded in-memory storage. The default 10 MiB/10,000-row limits make this appropriate for the supplied 5,000-row take-home input; substantially larger production ingestion would warrant streaming or staged storage.
- The API returns nested `counts`; it does not maintain denormalized counters. Jobs intentionally remain queued until Phase 3.
- The frontend remains the Phase 1 shell. This phase requested the ingestion/status API, not an upload screen or dashboard.

Suggested commit message: `feat: add CSV ingestion and queued job creation`. No commit was created.
