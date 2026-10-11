# TierForge interview notes

## Q1: Why PostgreSQL-backed jobs instead of Redis or BullMQ?

The assignment already needs SQL persistence. Keeping workflow state in `job_stores` gives TierForge durable retries, row locks, transactions, constraints, results, fair multi-job claims, and cross-process coordination in one system. Redis or BullMQ would add another runtime and a consistency boundary without solving a requirement PostgreSQL cannot handle at this scale.

## Q2: Why is concurrency different from request rate?

Concurrency is the number of operations that may be in flight; rate is the number that may start during a time window. Each process runs a bounded worker pool, while a PostgreSQL reservation row coordinates every process and spaces starts by 220 ms. Increasing concurrency or adding a process therefore does not allow participating workers to exceed five request starts per rolling second.

## Q3: How does `FOR UPDATE SKIP LOCKED` work?

Inside a short claim transaction, a worker selects one eligible `job_stores` row with `FOR UPDATE SKIP LOCKED`. PostgreSQL locks the selected row until the transaction finishes. Another connection skips that locked row and can claim a different one instead of waiting. TierForge updates status, attempt count, token, and lease before committing, so selection and ownership transfer are atomic.

## Q4: What happens when a worker crashes or becomes silent?

A claimed row has a database-time lease expiry. The watchdog scans processing rows whose leases expired, revokes their token, and either schedules a retry or records final exhaustion. On process startup the coordinator discovers all active jobs, restores persisted retry wakeups, and eventually reclaims abandoned processing rows. Committed successes stay succeeded and are never claimed again.

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

The bonus is implemented with fair cross-job claims ordered by a persisted scheduler timestamp, a database-wide processing cap, and a database-coordinated request limiter. The frontend can create and revisit multiple jobs. Job-scoped keys keep enrichment, scoring, failures, and dashboard reads isolated.

## Q12: How would you add full process-restart resumability?

The bonus is implemented. Pending work, retry times, attempts, leases, and accepted successes are durable. Startup discovers all active jobs, and expired leases recover work abandoned by a killed process. The live harness kills and relaunches the backend during simulator traffic, verifies committed successes are unchanged and not called again, and confirms the interrupted store is retried. External delivery remains at least once for an uncommitted in-flight request.

## Q13: What would you change for one million stores?

I would stream CSV validation into a staging table, use PostgreSQL `COPY`, validate and promote data set-wise, and avoid keeping the full upload in application memory. Workers would claim batches, database partitions and indexes would be measured with production-like plans, dashboard reads might use maintained aggregates, and scoring would run in bounded chunks or a dedicated database job. Horizontal workers would require distributed rate admission and coordinator leadership.

## Q14: What shortcuts were chosen for the 2–3 day time box?

The implementation uses PostgreSQL instead of a separate queue, bounded in-memory CSV parsing, polling instead of push updates, and a small shared worker pool. It stores current attempt state and accepted metrics but not raw payload archives or attempt history; scoring revisions have no cleanup policy. Database coordination assumes every worker uses the same database and compatible worker/rate configuration.
