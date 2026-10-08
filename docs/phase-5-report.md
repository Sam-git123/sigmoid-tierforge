# Phase 5 handoff and verification

Date: 8 October 2026 (Asia/Calcutta). Scope: expired-lease recovery, coordinator watchdog behavior, complete enrichment job lifecycle, systemic provider-failure handling, and persisted progress reporting. No scoring, frontend dashboard, commit, or push was created.

## Delivered

- Migration `002_job_failure_streak.sql` adds the nonnegative persisted provider-failure streak used to serialize job-level safeguards.
- The watchdog scans with database time, locks job before store, and conditionally reclaims expired processing leases. Remaining attempts return to `retry_wait` with a new due time; final expired attempts become `RETRY_EXHAUSTED`.
- Completion and watchdog writes use the same running-job, processing-state, lease-token, and expiry rules. A racing or late callback cannot change a reclaimed or terminal row.
- Normal terminal states are deterministic: all succeeded becomes `completed`; mixed successes and store failures becomes `completed_with_errors`; zero successes becomes `failed` with `NO_SUCCESSFUL_ENRICHMENTS`.
- Accepted provider-related failures form a persisted consecutive streak in job-lock acquisition order. Accepted success resets it; unrelated permanent store failures do not alter it.
- At `SYSTEMIC_FAILURE_STREAK`, or immediately for HTTP 401/403/404/405, one transaction fails the job with `SYSTEMIC_PROVIDER_FAILURE`, skips unfinished rows, clears their leases/retries, and preserves completed enrichment results.
- The coordinator keeps periodic recovery scans and bounded operational retries active until the job is terminal. Startup discovers the one active job and abandoned processing work becomes recoverable after lease expiry.
- `GET /api/jobs/:jobId` now returns `completedStores`, `unfinishedStores`, and `progressPercentage` alongside all six persisted state counts. Terminal percentage is `(succeeded + failed + skipped) / total_stores * 100`.

## Race and lifecycle guarantees

- Job mutation always locks the job row before a work row.
- Systemic termination and accepted attempt outcomes serialize through the job lock.
- Terminal jobs reject claims, success writes, and failure writes from late workers.
- Systemic termination preserves existing `store_enrichments` rows and changes only unfinished stores to skipped.
- The partial unique active-job index releases automatically at every terminal transition, allowing a later upload while retaining history.
- Progress comes from one SQL statement snapshot and raises an internal error if its state counts do not equal `total_stores`.

## Files added

- `apps/api/migrations/002_job_failure_streak.sql`
- `docs/phase-5-report.md`

## Phase 5 files modified

- `.env.example`
- `AGENTS.md`
- `README.md`
- `apps/api/src/domain/jobs.ts`
- `apps/api/src/errors/enrichment-error.ts`
- `apps/api/src/repositories/enrichment-repository.ts`
- `apps/api/src/repositories/job-repository.ts`
- `apps/api/src/server.ts`
- `apps/api/src/workers/README.md`
- `apps/api/src/workers/coordinator.ts`
- `apps/api/src/workers/worker.ts`
- `apps/api/tests/database.test.ts`
- `apps/api/tests/enrichment.database.test.ts`
- `apps/api/tests/jobs.database.test.ts`
- `apps/api/tests/worker.test.ts`
- `docs/architecture.md`
- `docs/database-schema.md`
- `docs/decisions-and-assumptions.md`
- `docs/enrichment-engine.md`
- `docs/implementation-plan.md`

All files listed above remain uncommitted. The supplied simulator and original requirements were not modified.

## Verification

- API TypeScript check passed.
- Worker unit tests passed: 6 tests in 1 file.
- Focused PostgreSQL progress/recovery run passed: 7 tests across 2 files.
- Focused PostgreSQL lifecycle run passed: 7 tests in 1 file.
- Final migration-idempotency and coordinator-shutdown run passed: 2 tests across 2 files.
- Per the requested lean workflow, the full test, lint, build, and frontend suites were not rerun. Earlier phase reports retain their broader results.

## Remaining limitations

- Rate limiting and coordinator ownership are process-local; multiple API processes are unsupported.
- A hard stop recovers after restart and lease expiry, rather than immediately.
- Upstream delivery remains at least once; database result application is fenced to one current attempt.
- Attempt history and raw upstream payload archival are not stored separately.
- Scoring and dashboard functionality remain later phases.
- The real simulator smoke test remains unavailable in this environment because Python is not installed.
