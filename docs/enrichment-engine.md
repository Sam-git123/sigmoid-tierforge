# Phase 3–5 enrichment engine

Phase 3 added asynchronous enrichment to durable jobs, Phase 4 added bounded resilient attempts, and Phase 5 added worker recovery plus complete terminal lifecycle handling. The engine uses the unchanged Sigmoid simulator contract. Scoring, dashboard reads, and the frontend are implemented in their separate modules and documented in the main architecture guide.

## Simulator contract

The client calls `POST /enrich` at `ENRICHMENT_API_BASE_URL` with JSON fields `store_id`, `store_name`, `address`, `city`, and `state`. The CSV `country` value remains in `job_stores` but is omitted upstream because the simulator README does not include it.

A `200` response is accepted only when it contains the matching `store_id` and finite, nonnegative numeric values for `estimated_monthly_footfall`, `estimated_monthly_revenue`, and `store_size_sqft`. Non-2xx responses remain distinguishable by HTTP status. Invalid JSON, invalid metrics, identity mismatch, transport errors, and the configured request timeout use safe internal error codes.

## Coordinator and worker lifecycle

`server.ts` creates exactly one coordinator and one rate limiter for the process. At startup the coordinator looks for the single queued or running job. After a new upload commits, the job service sends a non-blocking notification; `setImmediate` starts the coordinator after the request path can return its `202` response.

The coordinator changes queued to running and starts `WORKER_CONCURRENCY=6` logical loops. Each loop claims at most one store, waits for limiter admission, calls the client, persists its result, and repeats. It never creates one promise per uploaded row. When no loop can claim more pending work, the coordinator finalizes the job if no nonterminal rows remain.

Jobs finish as `completed` when all stores succeeded, `completed_with_errors` when successes and failures coexist, or `failed` when none succeeded. HTTP 429, transient 5xx, network errors, and timeouts retry while attempt budget remains. Invalid successful payloads and other HTTP failures are permanent. The fifth retryable failure becomes `RETRY_EXHAUSTED` and preserves its last typed cause.

## Rate and transaction boundaries

Every initial or retry request start passes through the PostgreSQL distributed limiter. A transaction locks the singleton rate row, uses database time, and reserves starts at `MIN_DISPATCH_INTERVAL_MS=220`; callers commit before sleeping and retrying. No burst capacity accumulates. Five starts span 880 ms and the sixth reservation is later than 1,000 ms after the first. Every job and API process using the database shares this budget, including persisted `Retry-After` cooldowns.

Claims use a short transaction and consistent job-before-store lock order:

1. Lock the running job.
2. Select one pending row or due retry row with `FOR UPDATE SKIP LOCKED`.
3. Change it to processing, increment `attempt_count`, assign a UUID token and database-time lease expiry.
4. Commit before limiter waiting or network I/O.

Successful persistence uses another short transaction. It locks and verifies the running job, then requires the exact job/store identity, processing state, current lease token, and an unexpired database-time lease. It inserts the three metrics and changes the store to succeeded in the same transaction. The composite primary key on `store_enrichments` supplies a second duplicate defense. Failure persistence applies the same ownership fence.

Retryable failure moves the owned row to `retry_wait`, stores its typed error and database-time `next_attempt_at`, and clears the lease. Full jitter selects an integer delay from zero through `min(RETRY_CAP_MS, RETRY_BASE_MS * 2^(attempt-1))`, so the final jitter value cannot exceed the configured cap. A valid `Retry-After` is a lower bound up to `MAX_UPSTREAM_COOLDOWN_MS`. The coordinator asks PostgreSQL for the earliest due time and schedules one wakeup; worker loops are free to claim other eligible rows.

Each HTTP operation races the complete transport promise against an independent `ENRICHMENT_TIMEOUT_MS=8000` deadline. The deadline requests abort but does not assume cancellation stopped remote work. The abandoned promise stays observed to prevent unhandled rejection. Once timeout persistence invalidates token A and retry claim B assigns a new token, any success or failure write using A returns stale without changing metrics or state.

## Watchdog and terminal lifecycle

Every `LEASE_REAPER_INTERVAL_MS`, the coordinator uses database time to find an expired processing lease. A short job-before-store transaction conditionally revokes its token and either schedules a full-jitter retry or records final `RETRY_EXHAUSTED`. A completion racing the watchdog can make only one valid state transition. Startup discovers the active job, and the same watchdog eventually recovers processing rows abandoned by a prior process.

Accepted 429, 5xx, network, timeout, invalid-response, and lease-expiry outcomes increment `jobs.provider_failure_streak`; accepted success resets it. Store-local permanent failures neither increment nor reset the streak. HTTP 401/403/404/405 stop immediately as likely integration failures. Reaching `SYSTEMIC_FAILURE_STREAK=30` atomically fails the job, records `SYSTEMIC_PROVIDER_FAILURE`, changes unfinished rows to skipped with a clear reason, revokes their leases, and preserves existing metrics.

Normal completion is `completed` when every store succeeded, `completed_with_errors` when successes coexist with terminal store failures, and `failed` when no store succeeded. A systemic stop is always failed even when it preserves earlier successes. Progress percentage is `(succeeded + failed + skipped) / total_stores * 100`; `pending`, `processing`, and `retry_wait` remain unfinished.

## Remaining operational limits

The implementation does not preserve a separate per-attempt history table. It coordinates rate limits and work ownership across multiple API processes through PostgreSQL. A hard stop is recovered after process restart and lease expiry. Exactly-once upstream HTTP delivery is impossible without provider idempotency, but committed successful work is never claimed again and stale responses cannot write.

The coordinator owns one bounded shared pool per process rather than one pool per job. Global claims select the least-recently-served eligible job and enforce the configured valid-lease cap across the database. Startup and periodic discovery scan all active jobs; valid leases owned by other processes are respected, while expired work is reclaimed.
