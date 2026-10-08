# Phase 4 handoff and verification

Date: 8 October 2026 (Asia/Calcutta). Scope: resilient enrichment attempts, typed failure handling, persisted retry scheduling, independent request deadlines, shared provider cooldowns, and lease-fenced writes. No scoring, dashboard, expired-lease watchdog, systemic job failure policy, commit, or push was created.

## Delivered

- Enrichment failures use the typed codes `RATE_LIMITED`, `PROVIDER_ERROR`, `NETWORK_ERROR`, `TIMEOUT`, `INVALID_RESPONSE`, `PERMANENT_ERROR`, and `RETRY_EXHAUSTED`.
- HTTP 429 and 5xx responses, network failures, and timeouts are retryable. Invalid provider payloads and other non-success HTTP responses are terminal.
- Retry delays use capped exponential backoff with full jitter. A valid `Retry-After` value is a lower bound for both the affected row and the shared request limiter.
- Retry state is persisted as `retry_wait` with `next_attempt_at`; workers do not sleep while waiting for a row to become eligible.
- The coordinator uses PostgreSQL's clock to schedule the earliest retry wake-up and rechecks the database after every wake-up.
- Request deadlines do not depend on the HTTP adapter honoring cancellation. Late fulfillment or rejection is observed and cannot write directly to the database.
- Every attempt result is accepted only when the job is running and the row is processing with the same unexpired lease token. A stale response returns without changing store state or metrics.
- Retry exhaustion records a terminal `RETRY_EXHAUSTED` failure. Attempts never exceed the persisted `max_attempts` value.

## Race handling

- A retry changes the row state and clears its lease inside the same transaction that records the failure.
- A subsequent claim creates a new lease token, so an older response cannot overwrite the newer attempt.
- Concurrent success writes for one lease serialize on the row lock; only one can persist metrics and mark the row succeeded.
- Retry eligibility and coordinator wake-up delays use the database clock, avoiding application/database clock skew.

## Verification status

- API TypeScript checking passed.
- Focused Phase 4 tests passed: **44 tests across 5 files**. They cover backoff, rate limiting, HTTP classification, timeout behavior, ignored cancellation, retries, exhaustion, permanent failures, and environment defaults.
- The PostgreSQL suite passed during implementation with **75 tests across 3 files**. It covers persisted retry timing, due-row claims, stale-token fencing, concurrent completion, coordinator retry success and exhaustion, and a late response after timeout.
- The broader Phase 3 verification remains recorded in [the Phase 3 report](phase-3-report.md).
- Per the requested lean workflow, the final check is limited to API typechecking and focused Phase 4 tests; full lint, build, frontend, and database suites are deferred until the complete frontend and backend flow is ready.

## Files added

- `apps/api/src/errors/enrichment-error.ts`
- `apps/api/src/workers/retry-policy.ts`
- `apps/api/tests/retry-policy.test.ts`
- `docs/phase-4-report.md`

## Files modified

- `.env.example`
- `AGENTS.md`
- `README.md`
- `apps/api/src/clients/enrichment-client.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/domain/enrichment.ts`
- `apps/api/src/repositories/enrichment-repository.ts`
- `apps/api/src/server.ts`
- `apps/api/src/workers/README.md`
- `apps/api/src/workers/coordinator.ts`
- `apps/api/src/workers/rate-limiter.ts`
- `apps/api/src/workers/worker.ts`
- `apps/api/tests/enrichment-client.test.ts`
- `apps/api/tests/enrichment.database.test.ts`
- `apps/api/tests/env.test.ts`
- `apps/api/tests/rate-limiter.test.ts`
- `apps/api/tests/worker.test.ts`
- `docs/architecture.md`
- `docs/database-schema.md`
- `docs/decisions-and-assumptions.md`
- `docs/enrichment-engine.md`
- `docs/implementation-plan.md`

No dependency or schema migration was needed. No file under `enrichment_simulator/` changed.

## Remaining risks and deferred work

- A process crash can leave a row in `processing` until the Phase 5 expired-lease watchdog reclaims it.
- Repeated systemic provider failure remains a Phase 5 job-level policy.
- Rate limiting is process-local; running multiple API processes would require a distributed limiter.
- Attempt history is represented by current row state rather than a separate audit table.
- An end-to-end simulator run remains pending because Python is unavailable in this environment.
