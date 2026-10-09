# TierForge bonus implementation report

## Scope and baseline

This change implements both optional requirements in Section 6.2 of the original assignment while retaining the existing PostgreSQL-backed work queue, lease fencing, retries, scoring, and dashboard contracts. The pre-change baseline passed 208 tests. The final implementation passes 217 tests plus the dedicated process-level harness.

The main regression risks were the former active-job uniqueness index, one coordinator pool per job, process-local rate admission, startup discovery of only one job, per-job systemic failure state, and frontend assumptions that an active job blocks another upload. The implementation extends those integration points without introducing another queue or infrastructure service.

## Bonus 1 — Multiple concurrent jobs

### Final architecture and changes

- `POST /api/jobs` creates independent queued jobs even while other jobs are queued or running. Job/store, enrichment, scoring, failure, and dashboard data remain keyed by job ID.
- Each API process runs one bounded pool of `WORKER_CONCURRENCY` worker loops. A job never receives a private pool.
- A claim transaction takes a short PostgreSQL advisory transaction lock, checks the database-wide count of unexpired processing leases, chooses an eligible job, and claims one store with `FOR UPDATE SKIP LOCKED`.
- Eligible jobs are ordered by `scheduler_last_claimed_at NULLS FIRST`, creation time, and ID. Updating the scheduler timestamp on each claim gives continuously eligible jobs round-robin service.
- Systemic failure streaks and termination remain stored and applied per job. Failure of one job skips only its unfinished rows.
- `GET /api/jobs` returns the 50 most recent jobs. The upload page permits additional uploads and links to each job's existing progress, scoring, and dashboard workflow.

### Database migration

`003_concurrent_jobs_and_global_rate_limit.sql` is non-destructive. It:

1. Drops only `jobs_single_active_idx`.
2. Adds nullable `jobs.scheduler_last_claimed_at` and a partial active-job scheduling index.
3. Creates `enrichment_rate_limit`, containing one durable request-reservation/cooldown row.

Existing jobs, stores, enrichments, scores, and scoring configurations are preserved. The migration was applied successfully to the locally configured database.

### Distributed rate limiter

Every initial attempt and retry calls the PostgreSQL limiter immediately before dispatch. A short transaction locks the singleton row and either reserves the next database-time start or returns a delay. The transaction commits before the caller sleeps, so no database connection is held during a rate wait. The default 220 ms spacing is conservative enough to keep any six starts more than one second apart. HTTP `Retry-After` extends the shared persisted cooldown.

Separate backend processes use the same row and therefore cannot mint independent five-request budgets. Database coordination failure rejects admission; there is no unrestricted in-memory fallback. A process crash after reservation may waste one slot temporarily but cannot exceed the limit.

### Verified behavior

- Concurrent HTTP submissions create independent active jobs.
- Three jobs receive fair claims under one database-wide processing cap.
- Two independent backend OS processes both dispatch stores from two jobs.
- The combined process-level starts remained within five requests in every rolling second.
- One systemically failing job does not prevent another job from completing.
- Store ownership, lease tokens, attempt caps, progress, enrichments, and scoring remain job-scoped.

### Known limits

- Participating workers must use the same PostgreSQL database. External clients and applications connected to another database are outside the limiter boundary.
- Worker concurrency and rate configuration should match across processes. With mixed concurrency values, the largest value presented to the claim transaction can become the effective database-wide processing cap.
- Fairness applies to jobs with currently eligible work. A job waiting for its retry due time is intentionally skipped.

## Bonus 2 — Restart resumability

### Startup and lease recovery

Coordinator startup is idempotent and discovers every queued or running job. Pending work and due retries become claimable normally. Future retry timestamps remain in PostgreSQL and determine the next wakeup after restart. Valid processing leases are left untouched so a new process cannot steal work from another live process.

The watchdog scans active jobs and reclaims only expired processing leases. It clears the old token and either schedules another attempt or records retry exhaustion. Every result/failure transaction still requires the current job state, processing state, lease token, and unexpired lease. Repeated startup scans and competing processes are therefore safe.

If every store is already terminal while the job row still says running, startup reconciliation derives and commits the correct terminal job state without another simulator request.

### Completed-work preservation and crash guarantees

Committed succeeded rows are excluded from claim queries. Their attempt counts, metrics, and enrichment timestamps remain unchanged across restart. The unique enrichment key and lease fencing prevent duplicate accepted results.

PostgreSQL transactions make claim, retry scheduling, completion, systemic termination, scoring publication, and job finalization atomic at their individual boundaries. A forced process exit can leave a claimed row processing; after lease expiry it receives a fresh token and continues within its persisted attempt limit.

The guarantee is no re-enrichment of an already committed successful store. PostgreSQL and the simulator do not share a distributed transaction, so an external request interrupted before its result commits may execute again after lease recovery. External delivery is at least once for that case, while database acceptance remains fenced.

### Graceful and forced shutdown

`SIGINT` and `SIGTERM` stop accepting HTTP connections, stop new worker dispatches, wait for the current coordinator cycle within the shutdown deadline, and then close the database pool. A claim that was acquired but not dispatched remains durable and is recovered after its lease expires. Forced termination relies entirely on the same durable lease path and requires no shutdown hook.

### Forced-restart verification

`pnpm test:bonus` builds the real applications, creates an isolated PostgreSQL schema, starts the unchanged supplied simulator, starts two compiled backend processes, and proxies simulator calls only to record their actual start times and hold one selected response.

In the combined restart scenario, two jobs of 30 and 20 stores ran across ports 3101 and 3102. After three successes were committed, the harness killed the process owning `A-HOLD` while the other backend remained active, restarted the killed process, and waited for both jobs to finish. Results:

- Three captured pre-crash successes retained identical IDs, metrics, timestamps, and attempt counts.
- None of those successful store IDs produced another simulator call.
- `A-HOLD` reached attempt 2 through normal expired-lease recovery.
- Both jobs completed with zero unfinished rows.
- Separate scoring requests scored 30 and 20 stores and produced two isolated revision-1 configurations.
- All 59 observed request starts, across both jobs/processes and retries, respected the five-per-rolling-second assertion.

## Testing

### Tests added or extended

- Distributed limiter database tests: independent pools share one budget, provider cooldown is shared, and database failure fails closed.
- Multi-job database tests: concurrent admission, recent-job listing, fair three-job claims, database-wide processing cap, and systemic failure isolation.
- Restart database tests: expired in-flight recovery, committed-success preservation, idempotent startup, stranded terminal-work finalization, future retry schedule preservation, and shutdown completion safety.
- Frontend workflow test: multiple recent jobs are listed and linked while uploads remain available.
- Process integration harness: two compiled backend processes, shared PostgreSQL, actual simulator traffic, combined forced restart, request-start measurement, success preservation, lease recovery, and isolated scoring.

### Commands and actual results

- `pnpm lint` — passed with zero warnings.
- `pnpm format:check` — passed.
- `pnpm typecheck` — passed for API and web.
- `pnpm test` — 17 API files / 205 tests and 2 web files / 12 tests passed; 217 total, 0 failed.
- `pnpm test:db` — 7 files / 101 PostgreSQL tests passed; 0 failed.
- `pnpm build` — API TypeScript build and web production build passed.
- `pnpm test:bonus` — passed with two backend processes, combined forced restart, two isolated scoring configurations, and a five-per-rolling-second assertion across 59 observed starts.
- `pnpm db:migrate` — applied `003_concurrent_jobs_and_global_rate_limit.sql` successfully to the configured local database.

The supplied 5,000-row CSV remains covered by real parsing, atomic database creation, scoring, dashboard, filtering, and pagination tests. A live 5,000-request simulator run was not repeated because the rate limit alone requires at least 16 minutes 40 seconds before latency and retries. The process test uses smaller jobs so crash boundaries and request IDs can be controlled and asserted deterministically.

## Architecture trade-offs

The existing queue was extended because PostgreSQL already owns work state, retry times, leases, fencing, result uniqueness, and transactional finalization. One scheduling advisory lock and one limiter row add cross-process coordination without creating a second source of truth. At the assignment's 5,000-store and five-request-per-second scale, serializing these short decisions is simpler to reason about than introducing Redis or a broker.

The scheduler does not keep a promise or timer per store. Each process has a fixed worker count, the coordinator has one retry wake timer and one watchdog timer, and idle scans run at the configured lease-reaper interval. Rate waits hold no transaction. Upload memory remains bounded by the existing byte and row limits.

No correctness claim depends on an in-memory completed set, process clock agreement, graceful shutdown, or one coordinator process. PostgreSQL state is authoritative. Exactly-once external execution, attempt-history storage, provider-wide circuit breaking across jobs, job cancellation, and production observability remain outside the requested bonuses.
