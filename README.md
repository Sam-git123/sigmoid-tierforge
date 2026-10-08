# TierForge

Phase 6 implementation for Sigmoid's resilient bulk store scoring/tiering exercise. Implemented: pnpm workspace, React shell, Express health/job/scoring APIs, PostgreSQL schema/migrations, bounded CSV ingestion, resilient enrichment workers, lease recovery, systemic-failure shutdown, persisted progress, exact configurable scoring, and immutable scoring revisions. The frontend dashboard is intentionally **not implemented**.

## Prerequisites

- Node.js 24.x and pnpm 12.10.1.
- Docker Engine/Desktop with Compose v2 for the standard database setup, or an existing PostgreSQL 18 server.
- Install pnpm if needed: `npm install --global pnpm@12.10.1`. On Windows, reopen the terminal after installation if its npm global directory is not on PATH. For this user's current PowerShell session: `$env:PATH = "$env:APPDATA\npm;$env:PATH"`.

## Setup and development

Run from `sigmoid-tierforge/`:

```powershell
# First checkout only; preserve an existing .env.
Copy-Item .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm dev
```

On macOS/Linux, use `cp .env.example .env` instead. Never commit `.env`.

- Frontend: http://127.0.0.1:5173
- Backend: http://127.0.0.1:3001/api/health
- Separate terminals: `pnpm dev:web` and `pnpm dev:api`.
- Database start: `docker compose up -d --wait postgres` (same as `pnpm db:up`).
- Database stop: `pnpm db:down`. This preserves the named volume.
- If changing `POSTGRES_PORT`, update the port in `DATABASE_URL` too.
- Both apps load the root `.env`; shell environment variables take precedence.
- `VITE_API_BASE_URL=/api` uses the Vite development proxy. Production hosting must route same-origin `/api` to Express. Phase 1 does not add cross-origin deployment configuration.

The health endpoint returns `200 {"status":"ok","database":"up"}` when a real database query succeeds, or a standard `503 DATABASE_UNAVAILABLE` error otherwise. Startup fails clearly if PostgreSQL cannot be reached. Importing the application factory starts no listeners, pools, or workers; `server.ts` owns the coordinator lifecycle.

## Job API

Upload a CSV as the multipart field `file`:

```powershell
curl.exe -i -X POST http://127.0.0.1:3001/api/jobs -F "file=@stores_5000.csv;type=text/csv"
```

A valid upload returns `202`, a `Location` header, a queued job, and any extra-column warnings:

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

Read persisted progress:

```powershell
curl.exe http://127.0.0.1:3001/api/jobs/45dbdc13-56f4-4921-9f70-ad8ad9d69c63
```

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
  },
  "completedStores": 0,
  "unfinishedStores": 5000,
  "progressPercentage": 0
}
```

`progressPercentage` is `(succeeded + failed + skipped) / totalStores * 100`, rounded to two decimal places. Pending, processing, and retry-wait rows remain unfinished.

The [CSV contract](docs/csv-ingestion.md) documents header/value policy, limits, warnings, status codes, and transaction behavior. The response reflects the committed queued record, then the coordinator starts it asynchronously. A queued or running job causes `409 ACTIVE_JOB_EXISTS`; historical terminal jobs remain available.

## Scoring API

After a job reaches `completed`, `completed_with_errors`, or `failed`, submit a scoring configuration:

```powershell
curl.exe -X POST http://127.0.0.1:3001/api/jobs/JOB_ID/scoring -H "Content-Type: application/json" -d '{"footfallBar":15000,"revenueBar":150000,"sizeBar":8000,"footfallWeight":50,"revenueWeight":30,"sizeWeight":20,"largeThreshold":70,"mediumThreshold":40}'
```

Read the highest committed configuration and its tier summary:

```powershell
curl.exe http://127.0.0.1:3001/api/jobs/JOB_ID/scoring
```

Configuration values support at most two decimal places. The three weights must total exactly `100.00`; metric and tier comparisons are inclusive. Every POST creates an immutable revision and recalculates successful enrichments in one database transaction without calling the enrichment API.

## Commands

- `pnpm run setup`: convenience alias for dependency installation; normal `pnpm install` remains the standard command.
- `pnpm dev`: both development servers.
- `pnpm build`: compile backend and build frontend production assets.
- `pnpm --filter @tierforge/api start`: run the compiled backend after build.
- `pnpm --filter @tierforge/web preview`: preview frontend build; it is not a production deployment.
- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`: quality checks.
- `pnpm format`: apply Prettier conventions, excluding original requirements and supplied simulator/assets.
- `pnpm test`: unit/API/client tests, plus real database tests when `TEST_DATABASE_URL` is set.
- `pnpm test:db`: database suite only; fails with instructions if `TEST_DATABASE_URL` is absent.
- `pnpm db:migrate`: apply pending migrations.

## Database tests

Use a local/test database whose account can create schemas. Enable the `TEST_DATABASE_URL` line in root `.env` (it can equal the local `DATABASE_URL`), then run:

```powershell
pnpm test
```

The database suite creates a random `tierforge_test_<uuid>` schema, applies the actual migration, tests real constraints/transactions/concurrency, and drops only that generated schema afterward. It does not truncate application tables or reset the public schema. Failed connectivity with a configured test URL fails the suite; an absent URL explicitly skips database tests. Do not point tests at production.

Tests cover health success/failure, request IDs/error envelopes, request/environment validation, API-client behavior, CSV quoting/structure/limits, actual 5,000-row ingestion, schema integrity, concurrent HTTP active-job admission, transactional batch rollback, migration rollback/checksums, and repeat migration idempotency.

## Schema and migrations

Five domain tables: `jobs`, `job_stores`, `store_enrichments`, `scoring_configs`, and `store_scores`. See [schema decisions](docs/database-schema.md). `schema_migrations` records migration names/checksums.

Migrations are ordered, forward-only SQL files in `apps/api/migrations/`. A PostgreSQL advisory lock serializes migration runners; each file and its ledger insert commit in one transaction. Never edit an applied migration: add a new numbered file. Failed DDL rolls back; changed/missing applied files cause failure. The CLI uses bounded pool/statement timeouts. Keep the migrations directory alongside the API source/build when distributing the backend.

The one-active-job constraint covers both `queued` and `running`. Exact NUMERIC metrics/configuration/scores and composite foreign keys preserve store/job/revision identity. Phases 3 and 4 use the original schema without another migration: existing lease/retry columns fence work and schedule retries, while `store_enrichments` stores accepted metrics.

## Architecture and boundaries

The API has routes, controllers, services, repositories, database modules, middleware, an enrichment client, and a worker coordinator. Six logical loops share one monotonic limiter, claim one row at a time through `FOR UPDATE SKIP LOCKED`, and never hold a transaction across limiter or network waits. The frontend has React Router, TanStack Query, Tailwind's Vite plugin, and a reusable fetch client; no upload or dashboard screen is part of this phase.

Later phases will implement the remaining [planned architecture](docs/architecture.md), using the [original requirements](docs/requirements/tierforge-requirements.md). See the [implementation plan](docs/implementation-plan.md), [enrichment policy](docs/enrichment-engine.md), and [Phase 6 verification report](docs/phase-6-report.md).

## Provided simulator

Preserve the supplied service unchanged. Run it in a separate terminal before uploading a CSV:

```text
pip install -r requirements.txt
uvicorn main:app --port 8000
```

Its [README](enrichment_simulator/README.md) is the contract authority. The application calls `POST /enrich` through `ENRICHMENT_API_BASE_URL`, omitting `country` exactly as documented. The supplied `stores_5000.csv` and original RTF are preserved. The referenced generator script was not supplied.

## Local verification fallback in this workspace

Docker was unavailable during implementation. Database execution was verified using the installed PostgreSQL 18 binaries and a separate cluster under ignored `.local/postgres-phase1`, bound to `127.0.0.1:55432`. The ignored local `.env` uses port 55432; the example retains standard 5432.

To start that already-initialized verification cluster, from this repository in PowerShell:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' -D "$PWD\.local\postgres-phase1" -l "$PWD\.local\postgres-phase1.log" -o '-h 127.0.0.1 -p 55432' -w start
pnpm db:migrate
pnpm dev
```

Stop it with:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' -D "$PWD\.local\postgres-phase1" -m fast -w stop
```

This fallback is specific to this workspace, not a portable replacement for Docker Compose. Stop the native cluster before starting Compose on the same configured port.

## Known limitations

- Docker Compose startup is unverified in this environment; native PostgreSQL tests do not establish container startup.
- HTTP 429/5xx, network errors, and timeouts retry up to `MAX_ATTEMPTS`; invalid responses and permanent HTTP failures do not retry. Full-jitter backoff is persisted, and valid `Retry-After` values are lower bounds for the row and shared limiter.
- A one-second watchdog reclaims expired processing leases. Startup resumes the single active job and eventually reclaims abandoned attempts; full multi-process or exactly-once restart semantics are not claimed.
- Thirty consecutive accepted provider-related failures fail the job and skip unfinished rows. HTTP 401/403/404/405 stop it immediately as likely integration/configuration failures.
- The frontend dashboard is not implemented; scoring is currently API-only.
- CSV upload uses bounded in-memory multipart storage (10 MiB by default) and retains validated records until its single creation transaction completes; this is deliberate for the 5,000-row take-home scope.
- Scoring revisions are immutable and the highest committed revision is current; historical revisions remain stored.
- Separate attempt-history and raw-upstream-payload archival tables remain deferred.
- No authentication, multi-process rate limiting, deployment, or restart resumability. No commits were created.
