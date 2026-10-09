# TierForge interview notes

## Q1: Why PostgreSQL-backed jobs instead of Redis or BullMQ?

The assignment already needs SQL persistence, and its core permits one active job. Keeping workflow state in `job_stores` gives the implementation durable retries, row locks, transactions, constraints, and result data in one system. Redis or BullMQ would add another runtime and a consistency boundary without solving a requirement that PostgreSQL cannot handle at this scale. For higher throughput or multiple independent services, a dedicated queue could become worthwhile.

## Q2: Why is concurrency different from request rate?

Concurrency is the number of operations that may be in flight; rate is the number that may start during a time window. TierForge uses six worker loops so other stores can progress while requests wait, but all loops and retries share one limiter that spaces starts by 220 ms. Increasing concurrency therefore does not allow the core process to exceed five request starts per rolling second.

## Q3: How does `FOR UPDATE SKIP LOCKED` work?

Inside a short claim transaction, a worker selects one eligible `job_stores` row with `FOR UPDATE SKIP LOCKED`. PostgreSQL locks the selected row until the transaction finishes. Another connection skips that locked row and can claim a different one instead of waiting. TierForge updates status, attempt count, token, and lease before committing, so selection and ownership transfer are atomic.

## Q4: What happens when a worker crashes or becomes silent?

A claimed row has a database-time lease expiry. The independent watchdog scans processing rows whose leases expired, locks one, revokes its token, and either schedules a retry or records final exhaustion. On process startup the coordinator discovers the single active job, and the watchdog eventually reclaims abandoned processing rows.

## Q5: How are late responses handled safely?

Every completion and failure write checks that the job is running, the store is still processing, the lease token matches, and the lease remains unexpired. A retry owns a new token. A response from an older request therefore fails the fence and cannot update metrics, errors, counts, or terminal status.

## Q6: What is a fencing token?

It is the random UUID assigned to one claim and stored in `job_stores.lease_token`. The worker must present that exact token when persisting the attempt outcome. Reclaiming or retrying work replaces or clears the token, making every earlier worker stale even if it is still running.

## Q7: Why can the HTTP request happen more than once?

PostgreSQL and the simulator do not share a distributed transaction. If the application times out, it cannot know whether the simulator stopped, will answer later, or completed while the response was lost. Retrying provides at-least-once delivery. The system makes repeated calls safe at the persistence boundary rather than claiming exactly-once transport.

## Q8: How do we prevent duplicate committed results?

The lease fence admits only the current attempt. The success transaction verifies ownership, inserts enrichment metrics, and marks the work succeeded together. The `(job_id, store_id)` primary key on `store_enrichments` is an additional duplicate defense. Job completion is derived from persisted states and can be reconciled repeatedly.

## Q9: How is a systemically broken run detected?

The job stores a consecutive provider-failure streak. Accepted 429, 5xx, network, timeout, invalid-response, and expired-lease outcomes increment it; accepted success resets it. Reaching the configured threshold fails the job and skips unfinished work atomically. HTTP 401, 403, 404, and 405 stop immediately because they usually indicate an integration or configuration error. Per-store attempt caps still guarantee termination for smaller jobs.

## Q10: Why is scoring completely separate from enrichment?

Enrichment is slow and unreliable; scoring is deterministic over stored metrics. The scoring service has no enrichment-client dependency. It locks a terminal job, writes a new immutable configuration revision, and calculates all successful stores with set-based SQL in one transaction. Users can change bars or weights repeatedly without another network call.

## Q11: How would this architecture support multiple concurrent jobs?

That bonus is not implemented. It would require removing or changing the active-job partial unique index, scheduling fairly across job IDs, and replacing the process-local limiter with one shared across all workers and API replicas. Job-scoped keys and repository methods already isolate data, but rate admission and coordinator ownership would need an explicit distributed design.

## Q12: How would you add full process-restart resumability?

The current database already persists pending work, retry times, attempts, and leases, and startup discovers the active job. To meet the full bonus guarantee, I would add durable attempt history and dispatch metadata, make coordinator leadership explicit, test kill/restart at every transition, and define how shutdown and abandoned network calls affect leases. External delivery would still be at least once unless the provider supported idempotency keys.

## Q13: What would you change for one million stores?

I would stream CSV validation into a staging table, use PostgreSQL `COPY`, validate and promote data set-wise, and avoid keeping the full upload in application memory. Workers would claim batches, database partitions and indexes would be measured with production-like plans, dashboard reads might use maintained aggregates, and scoring would run in bounded chunks or a dedicated database job. Horizontal workers would require distributed rate admission and coordinator leadership.

## Q14: What shortcuts were chosen for the 2–3 day time box?

The core uses one API process, one active job, a process-local limiter, bounded in-memory CSV parsing, polling instead of push updates, and PostgreSQL instead of a separate queue. It stores only current attempt state and accepted metrics, retains scoring revisions without cleanup, and omits authentication, deployment infrastructure, raw payload archives, and attempt history. These choices preserve the assignment’s concurrency and failure guarantees while keeping the system small enough to explain and run locally.
