# Phase 3 enrichment engine

Phase 3 adds basic asynchronous enrichment to the durable jobs created by `POST /api/jobs`. It uses the unchanged Sigmoid simulator contract and the existing Phase 1 schema. Scoring, dashboard behavior, retry scheduling, lease reclamation, and systemic-failure handling are outside this phase.

## Simulator contract

The client calls `POST /enrich` at `ENRICHMENT_API_BASE_URL` with JSON fields `store_id`, `store_name`, `address`, `city`, and `state`. The CSV `country` value remains in `job_stores` but is omitted upstream because the simulator README does not include it.

A `200` response is accepted only when it contains the matching `store_id` and finite, nonnegative numeric values for `estimated_monthly_footfall`, `estimated_monthly_revenue`, and `store_size_sqft`. Non-2xx responses remain distinguishable by HTTP status. Invalid JSON, invalid metrics, identity mismatch, transport errors, and the configured request timeout use safe internal error codes.

## Coordinator and worker lifecycle

`server.ts` creates exactly one coordinator and one rate limiter for the process. At startup the coordinator looks for the single queued or running job. After a new upload commits, the job service sends a non-blocking notification; `setImmediate` starts the coordinator after the request path can return its `202` response.

The coordinator changes queued to running and starts `WORKER_CONCURRENCY=6` logical loops. Each loop claims at most one store, waits for limiter admission, calls the client, persists its result, and repeats. It never creates one promise per uploaded row. When no loop can claim more pending work, the coordinator finalizes the job if no nonterminal rows remain.

Jobs finish as `completed` when all stores succeeded, `completed_with_errors` when successes and failures coexist, or `failed` when none succeeded. In this basic phase, an HTTP, transport, timeout, or response-contract error marks that store failed. This bounded behavior prevents a crash or infinite loop while leaving retry classification and scheduling to a later phase.

## Rate and transaction boundaries

Every request start passes through one process-wide limiter. Admission is serialized using a monotonic clock, with `MIN_DISPATCH_INTERVAL_MS=220`. No burst capacity accumulates. Five starts span 880 ms and the sixth cannot start until 1,100 ms after the first, satisfying the rolling one-second maximum of five for this process.

Claims use a short transaction and consistent job-before-store lock order:

1. Lock the running job.
2. Select one pending row with `FOR UPDATE SKIP LOCKED`.
3. Change it to processing, increment `attempt_count`, assign a UUID token and database-time lease expiry.
4. Commit before limiter waiting or network I/O.

Successful persistence uses another short transaction. It locks and verifies the running job, then requires the exact job/store identity, processing state, current lease token, and an unexpired database-time lease. It inserts the three metrics and changes the store to succeeded in the same transaction. The composite primary key on `store_enrichments` supplies a second duplicate defense. Failure persistence applies the same ownership fence.

## Deferred resilience

Phase 3 does not move failures to `retry_wait`, compute backoff, honor `Retry-After`, reclaim expired processing rows, preserve per-attempt history, or stop a systemically broken run early. A hard process stop can therefore leave processing rows that startup discovery cannot reclaim. These are explicit later-phase tasks, not implicit behavior of the basic engine.

The limiter is process-wide. Running multiple API processes or other callers against the same simulator would require a shared cross-process limiter to preserve a truly global guarantee; multiple application processes are outside the core topology.
