# Phase 3–4 enrichment engine

Phase 3 adds asynchronous enrichment to durable jobs; Phase 4 adds bounded resilient attempts. The engine uses the unchanged Sigmoid simulator contract and existing Phase 1 schema. Scoring, dashboard behavior, general expired-lease reclamation, and job-wide systemic-failure handling remain outside the implemented scope.

## Simulator contract

The client calls `POST /enrich` at `ENRICHMENT_API_BASE_URL` with JSON fields `store_id`, `store_name`, `address`, `city`, and `state`. The CSV `country` value remains in `job_stores` but is omitted upstream because the simulator README does not include it.

A `200` response is accepted only when it contains the matching `store_id` and finite, nonnegative numeric values for `estimated_monthly_footfall`, `estimated_monthly_revenue`, and `store_size_sqft`. Non-2xx responses remain distinguishable by HTTP status. Invalid JSON, invalid metrics, identity mismatch, transport errors, and the configured request timeout use safe internal error codes.

## Coordinator and worker lifecycle

`server.ts` creates exactly one coordinator and one rate limiter for the process. At startup the coordinator looks for the single queued or running job. After a new upload commits, the job service sends a non-blocking notification; `setImmediate` starts the coordinator after the request path can return its `202` response.

The coordinator changes queued to running and starts `WORKER_CONCURRENCY=6` logical loops. Each loop claims at most one store, waits for limiter admission, calls the client, persists its result, and repeats. It never creates one promise per uploaded row. When no loop can claim more pending work, the coordinator finalizes the job if no nonterminal rows remain.

Jobs finish as `completed` when all stores succeeded, `completed_with_errors` when successes and failures coexist, or `failed` when none succeeded. HTTP 429, transient 5xx, network errors, and timeouts retry while attempt budget remains. Invalid successful payloads and other HTTP failures are permanent. The fifth retryable failure becomes `RETRY_EXHAUSTED` and preserves its last typed cause.

## Rate and transaction boundaries

Every initial or retry request start passes through one process-wide limiter. Admission is serialized using a monotonic clock, with `MIN_DISPATCH_INTERVAL_MS=220`. No burst capacity accumulates. Five starts span 880 ms and the sixth cannot start until 1,100 ms after the first, satisfying the rolling one-second maximum of five for this process. Valid `Retry-After` values also defer shared admission.

Claims use a short transaction and consistent job-before-store lock order:

1. Lock the running job.
2. Select one pending row or due retry row with `FOR UPDATE SKIP LOCKED`.
3. Change it to processing, increment `attempt_count`, assign a UUID token and database-time lease expiry.
4. Commit before limiter waiting or network I/O.

Successful persistence uses another short transaction. It locks and verifies the running job, then requires the exact job/store identity, processing state, current lease token, and an unexpired database-time lease. It inserts the three metrics and changes the store to succeeded in the same transaction. The composite primary key on `store_enrichments` supplies a second duplicate defense. Failure persistence applies the same ownership fence.

Retryable failure moves the owned row to `retry_wait`, stores its typed error and database-time `next_attempt_at`, and clears the lease. Full jitter selects an integer delay from zero through `min(RETRY_CAP_MS, RETRY_BASE_MS * 2^(attempt-1))`, so the final jitter value cannot exceed the configured cap. A valid `Retry-After` is a lower bound and may be longer. The coordinator asks PostgreSQL for the earliest due time and schedules one wakeup; worker loops are free to claim other eligible rows.

Each HTTP operation races the complete transport promise against an independent `ENRICHMENT_TIMEOUT_MS=8000` deadline. The deadline requests abort but does not assume cancellation stopped remote work. The abandoned promise stays observed to prevent unhandled rejection. Once timeout persistence invalidates token A and retry claim B assigns a new token, any success or failure write using A returns stale without changing metrics or state.

## Deferred resilience

Phase 4 does not run a general expired-processing reaper, preserve a separate per-attempt history table, or stop a systemically broken run early. A hard process stop can therefore leave processing rows that startup discovery cannot reclaim. These are explicit next-phase watchdog tasks, not implicit behavior of bounded per-attempt retries.

The limiter is process-wide. Running multiple API processes or other callers against the same simulator would require a shared cross-process limiter to preserve a truly global guarantee; multiple application processes are outside the core topology.
