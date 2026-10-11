# TierForge

TierForge is a local full-stack application for Sigmoid’s resilient bulk store scoring and tiering exercise. It accepts a CSV of stores, enriches each store through the supplied unreliable simulator, persists progress and failure reasons, and calculates configurable Large, Medium, and Small tiers from stored metrics.

The design keeps slow, failure-prone enrichment separate from fast, deterministic scoring. A React frontend calls an Express API, while PostgreSQL stores workflow state, results, fair scheduling metadata, and global request-rate reservations. Multiple jobs and API processes cooperate through bounded per-process pools while sharing the simulator's five-request-per-second budget and a database-wide processing cap.

## Tech stack

- **Frontend:** React 19, TypeScript, Vite, React Router, TanStack Query, and Tailwind CSS.
- **Backend:** Node.js 24, TypeScript, Express 5, Zod, Pino, and the built-in Fetch API.
- **Database:** PostgreSQL 18 through `pg`, versioned SQL migrations, transactions, constraints, and indexed work selection.
- **Tests:** Vitest, Supertest, React server-rendered component tests, and real PostgreSQL integration tests.
- **Local dependency:** the supplied Python FastAPI/Uvicorn enrichment simulator.

## Prerequisites

- Node.js `>=24 <25`.
- pnpm `>=12 <13`; the repository pins pnpm 12.10.1.
- Docker Engine/Desktop with Compose v2, or an existing PostgreSQL server.
- Python 3 with `pip` for the supplied simulator. It was verified with Python 3.13.
- Free local ports 5173 for the frontend, 3001 for the API, 5432 for Docker PostgreSQL, and 8000 for the simulator. All are configurable where documented except the Vite development port.

## Setup

Clone the repository and install the locked dependencies:

```powershell
git clone <repository-url>
cd sigmoid-tierforge
npm install --global pnpm@12.10.1
pnpm install --frozen-lockfile
```

Create local configuration. `.env` is ignored by Git; never commit credentials.

```powershell
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env`. Review at least `DATABASE_URL`, `POSTGRES_PASSWORD`, and `ENRICHMENT_API_BASE_URL` before starting services.

Start PostgreSQL and apply migrations:

```powershell
pnpm db:up
pnpm db:migrate
```

`pnpm db:up` runs `docker compose up -d --wait postgres`. If using an existing PostgreSQL server, set `DATABASE_URL` in `.env`, skip `pnpm db:up`, and run `pnpm db:migrate` directly. Stop the Compose database with `pnpm db:down`; its named volume is preserved.

## Run the enrichment simulator

The supplied simulator is in `enrichment_simulator/` and must remain unchanged. Its authoritative startup commands are:

```text
pip install -r requirements.txt
uvicorn main:app --port 8000
```

A project-local virtual environment avoids changing global Python packages. From the repository root on Windows PowerShell:

```powershell
cd enrichment_simulator
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

On macOS or Linux:

```bash
cd enrichment_simulator
python3 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
./.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

The simulator exposes:

- `POST /enrich`, accepting `store_id`, `store_name`, `address`, `city`, and `state`.
- `GET /health`, returning `{"status":"ok"}` and not consuming enrichment rate limit.
- Deterministic metrics per `store_id`.
- A global limit of five enrichment requests per second, transient HTTP 500 responses, and occasional 45–60 second delayed successes.

The application sends no API key and calls the base URL from `ENRICHMENT_API_BASE_URL`, which defaults to `http://127.0.0.1:8000`. The CSV `country` field is retained locally and omitted from the simulator request because it is not part of the supplied contract.

## Start the application

With PostgreSQL, migrations, and the simulator ready, run the API and frontend in separate terminals from the repository root:

```powershell
pnpm dev:api
```

```powershell
pnpm dev:web
```

Open <http://127.0.0.1:5173>. The API health endpoint is <http://127.0.0.1:3001/api/health>.

For convenience, `pnpm dev` starts both development servers in one terminal. After `pnpm build`, run the compiled API with `pnpm --filter @tierforge/api start` and preview the frontend build with `pnpm --filter @tierforge/web preview`. The preview command is for local verification, not production hosting.

## Usage

1. Upload a UTF-8 CSV containing `store_id`, `store_name`, `address`, `city`, `state`, and `country`.
2. Follow the job progress page while pending, processing, retry-wait, succeeded, failed, and skipped counts come from PostgreSQL.
3. Inspect terminal store failures and their persisted error codes and messages.
4. Configure metric bars, weights totaling exactly 100%, and inclusive Large and Medium thresholds.
5. Submit scoring to calculate tiers from persisted successful enrichments.
6. View tier counts and the paginated store list, filter by Large, Medium, or Small, and submit a new configuration to recalculate without calling the simulator again.
7. Return to the upload page to create another job or reopen any of the 50 most recent jobs while other jobs continue.

The supplied `stores_5000.csv` is ready to upload. Concurrent submissions create independent jobs; PostgreSQL schedules eligible work fairly across them.

## API overview

- `POST /api/jobs` — multipart CSV upload using field name `file`.
- `GET /api/jobs` — list the 50 most recent jobs for navigation.
- `GET /api/jobs/:jobId` — persisted job status and progress counts.
- `GET /api/jobs/:jobId/stores` — stable paginated store results with optional `tier` filter.
- `GET /api/jobs/:jobId/failures` — paginated failed and skipped stores with reasons.
- `GET /api/jobs/:jobId/dashboard` — job, enrichment, scoring, and tier summary.
- `POST /api/jobs/:jobId/scoring` — create a scoring revision and calculate scores atomically.
- `GET /api/jobs/:jobId/scoring` — read the latest committed scoring revision.
- `GET /api/health` — API and database readiness.

Application errors use `{ "error": { "code", "message", "details?", "requestId" } }`. Missing metrics and scores are returned as `null`; failed or unscored stores are never assigned fabricated zeros or a Small tier.

## Testing and verification

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database or an account allowed to create and drop isolated schemas. It may use the same server as local development because each database test creates a random `tierforge_test_<uuid>` schema and drops only that schema.

Add `TEST_DATABASE_URL` to the ignored `.env` file, then run:

```powershell
pnpm test
```

`pnpm test` is the single complete test command. When `TEST_DATABASE_URL` is absent, PostgreSQL suites explicitly skip; when it is present but unreachable, they fail. To require only the database suites:

```powershell
pnpm test:db
```

Additional repository checks:

```powershell
pnpm lint
pnpm typecheck
pnpm format:check
pnpm build
```

The process-level bonus test requires the simulator's `.venv`, production build output, free ports 8000, 8001, 3101, and 3102, and `TEST_DATABASE_URL`. It builds the project, starts the unchanged simulator, runs two backend processes, and performs a forced restart:

```powershell
pnpm test:bonus
```

The tests cover CSV parsing and atomic creation, concurrent jobs, fair cross-job claims, real PostgreSQL constraints and row locking, distributed request admission, retry/backoff and `Retry-After`, timeouts, restart recovery, stale success/failure fencing, systemic isolation, exact scoring boundaries, rescoring without enrichment, dashboard reads, the supplied 5,000-row CSV, and the React workflow.

## Architecture decisions

- **Separate enrichment and scoring:** enrichment owns unreliable network work and stores typed metrics. Scoring imports no enrichment client and reads only persisted successes, so recalculation is fast and makes zero upstream calls.
- **PostgreSQL-backed work queue:** `job_stores` holds durable status, attempt count, retry time, lease token, lease expiry, and last error. This avoids another service for the take-home while giving transactions, constraints, and recovery state.
- **Fair atomic claiming:** one short advisory-lock transaction enforces the database-wide processing cap, selects the least-recently-served eligible job, locks one store with `FOR UPDATE SKIP LOCKED`, increments its attempt, and assigns a UUID lease. Network calls happen after commit.
- **Distributed rate limiter:** every process locks one PostgreSQL rate row only long enough to reserve its next request-start slot. Initial calls, retries, jobs, and API processes share the same 220 ms spacing and provider cooldown. Transactions and connections are released before waiting.
- **Bounded retry:** HTTP 429, HTTP 5xx, network errors, and timeouts retry up to the persisted per-store maximum. Full-jitter exponential backoff is stored in `next_attempt_at`; valid `Retry-After` values extend both row scheduling and database-wide admission up to the configured operational cooldown cap.
- **Timeout and lease recovery:** an eight-second logical request deadline prevents a delayed call from occupying a worker indefinitely. A watchdog reclaims expired 20-second leases and either schedules another attempt or records exhaustion.
- **Fencing tokens:** each claim receives a new lease token. Completion and failure transactions require the running job, processing status, matching token, and an unexpired lease, so a late response from an old attempt cannot mutate current state.
- **Idempotent completion:** the ownership fence permits only the current attempt to transition work, while the `(job_id, store_id)` enrichment primary key provides an additional duplicate-result defense. Job finalization is safe to run repeatedly.
- **Restart recovery:** startup scans every queued/running job. Pending and due retry work resumes immediately, valid foreign-process leases remain untouched, expired leases are reclaimed, and jobs stranded after their final store transition are finalized without another simulator call.
- **Atomic database scoring:** each immutable configuration revision and its set-based `INSERT ... SELECT` scores commit in one transaction under the job lock. Failure leaves the previous revision current.
- **Bounded shared pool:** each process has at most `WORKER_CONCURRENCY` loops, while the claim transaction also enforces that limit database-wide. Jobs do not receive separate unbounded pools or request budgets.

See [the implemented architecture](docs/architecture.md), [database schema](docs/database-schema.md), [enrichment policy](docs/enrichment-engine.md), [requirement verification](docs/requirements-verification.md), [bonus implementation report](docs/bonus-implementation-report.md), [interview notes](docs/interview-notes.md), and [final submission report](docs/phase-10-report.md).

## Environment and security

`.env.example` documents all runtime settings. `.env`, `.env.*`, logs, local databases, virtual environments, test output, and build output are ignored, while `.env.example` remains tracked. PostgreSQL and simulator addresses come from environment configuration. `VITE_*` values are public browser settings and must never contain secrets.

Environment validation reports only invalid field names, not credential-bearing values. Pino emits structured logs and redacts password, database URL, and authorization fields. User-visible errors avoid raw upstream response bodies and internal stack traces. SQL parameters are bound through `pg`; migrations are versioned and checksum-protected.

## Known limitations

- All participating processes must use the same PostgreSQL database and distributed limiter table. A separate application or database would have an independent request budget.
- `WORKER_CONCURRENCY` and rate settings should be identical across API processes; the largest configured claim limit can otherwise become the effective database-wide concurrency cap.
- Restart recovery guarantees no re-enrichment of a committed successful store. An external request interrupted before its database commit may be repeated after lease expiry, so upstream delivery remains at least once.
- CSV uploads use bounded in-memory buffering and validation: 10 MiB and 10,000 rows by default.
- The simulator may continue a request after the application’s logical timeout. The late result is discarded safely, but the remote work cannot be forcibly cancelled.
- Scoring revisions are retained indefinitely; there is no revision retention or deletion workflow.
- Separate attempt-history and raw upstream-payload archives are not stored.
- Authentication, authorization, production deployment configuration, observability infrastructure, and data-retention tooling are outside this local take-home scope.
- The supplied 5,000-row CSV and RTF are preserved. The sample generator referenced by the assignment was not present in the supplied files.
- The complete 5,000-request run against the real simulator was not repeated because five requests per second requires at least 16 minutes 40 seconds before latency and retries. The supplied file was verified through real ingestion, persistence, scoring, dashboard, filtering, and pagination with deterministic database enrichment fixtures.
