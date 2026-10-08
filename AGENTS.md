# TierForge contributor instructions

## Project and source of truth

TierForge is Sigmoid's 2–3 day take-home exercise: upload stores, asynchronously enrich them through the supplied unreliable API, then score and tier persisted metrics independently.
Read **all** of `docs/requirements/tierforge-requirements.md` before each implementation phase, especially Sections 4–7. It is the authoritative assignment; never edit it to fit the implementation.
Read `enrichment_simulator/README.md` before integration. Treat the supplied simulator as an external black box; do not modify it or implement a replacement.
`docs/architecture.md`, `docs/implementation-plan.md`, and `docs/decisions-and-assumptions.md` distinguish assignment requirements, user-directed constraints, and proposed choices. Report conflicts and unverified requirements explicitly.
The requirements were copied unchanged from `enrichment_simulator/docs/requirements/tierforge-requirements.md` to repair the expected root-relative path; do not maintain divergent versions.

## Phase and scope

Implement **only the phase explicitly requested by the user**. The current authorized phase is **Phase 3: basic enrichment engine, simulator client, shared rate limiter, and worker pool**. Implement asynchronous queued-job startup, atomic pending-work claims, fenced success persistence, and safe terminal placeholder failure handling. Do not implement retry scheduling, lease reclamation, systemic-failure policy, scoring calculations, or dashboard functionality; later phases require a subsequent request.
Prioritize one active enrichment job and the complete core workflow. Multiple concurrent jobs and full restart resumability are assignment bonuses. Do not add authentication, microservices, Redis, BullMQ, Kafka, Kubernetes, or distributed rate limiting to core scope.
Never automatically stage, commit, push, or publish changes. A suggested commit message is informational only.

## Technology and conventions

Use a pnpm workspace: React, TypeScript, Vite, Tailwind CSS, and TanStack Query in `apps/web`; Node.js, TypeScript, Express, PostgreSQL, `pg`, and Zod in `apps/api`; Vitest and Supertest for tests; Docker Compose for PostgreSQL.
Use strict TypeScript, explicit domain types, small named functions, consistent formatting, parameterized SQL, and versioned migrations. Validate external inputs at boundaries; never use unchecked casts as validation.
Use UTC timestamps and database time for lease validity. Use exact decimal arithmetic for scoring weights and thresholds. Inject clocks, randomness, and HTTP transports where deterministic tests need them.

## Module boundaries

Routes validate HTTP input and translate domain errors. Services coordinate use cases and transaction boundaries. Repositories own SQL and accept an explicit transaction client where needed.
The enrichment client knows only the upstream contract; the worker owns claims, rate admission, retries, timeouts, leases, and recovery. Scoring owns the exact formula and set-based recalculation, with no enrichment-client dependency.
The frontend uses polling and shared API contracts, never database access. Keep raw results, work state, immutable scoring configurations, and calculated results distinct.

## Architecture and concurrency invariants

Use a PostgreSQL-backed queue with atomic `SELECT ... FOR UPDATE SKIP LOCKED` claims in short transactions. Never hold a database transaction during HTTP calls, backoff sleeps, or rate-limit waits.
Run one API/worker process with one process-wide limiter: **all enrichment attempts, including retries, share at most five dispatches per second**. Do not enable clustering or multiple worker replicas under this design.
Fence every attempt-dependent write with the current lease token, processing state, unexpired lease, and active job. Validate the fence and persist raw results/work completion atomically; stale callbacks must not change metrics, scores, or counters.
Use a consistent job-before-work-row lock order. Reclaim expired leases independently of the original worker promise. Bound attempts, HTTP duration, retry backoff, and systemic failure handling; terminal jobs must have no nonterminal work.
Use database uniqueness to enforce one active job and one work row per store per job. Persist retry timing and failure reasons. Derive progress from persisted rows rather than callback counts.
Use exactly the assignment's sum of weights for metrics meeting their bars (`>=`), then inclusive Large/Medium boundaries. No normalization. Recalculation uses persisted successful enrichment only and makes zero upstream calls.
Publish each scoring revision atomically with its scores; serialize it with successful-result persistence so the dashboard cannot mix revisions.

## Verification and handoff

Tests are optional in the assignment but expected by this project's implementation plan: cover exact scores/boundaries, retry limits, shared request admission, concurrent claims, lease expiry, stale completion, systemic termination, and scoring without upstream calls.
Run checks relevant to the requested phase. Use `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, and `pnpm build`; database tests require `TEST_DATABASE_URL` (use `pnpm test:db` to require them explicitly); do not claim nonexistent scripts or unrun checks passed.
Before ending each phase report requirements covered, files created/modified, checks executed and results, known gaps/limitations, and an optional recommended Git commit message. Preserve user work and supplied assets. Do not create commits.

## Phase 1 schema precedence

The user's Phase 1 schema replaces the Phase 0 proposal. Read `docs/database-schema.md` and the migration before changing persistence. Domain tables are jobs, job_stores, store_enrichments, scoring_configs, and store_scores. The active-job constraint covers queued and running. Later-phase architectural invariants above are targets, not claims of implemented behavior.

## Phase 2 ingestion policy

Read `docs/csv-ingestion.md` before changing uploads. CSV headers are case-sensitive after trimming and may be reordered. All six required values must be nonblank. Store IDs are trimmed, case-sensitive, and unique within an upload. Extra columns are ignored with a response warning, while every row must still match the full header width. The upload transaction creates a queued job and performs no enrichment call; the coordinator starts it asynchronously after commit.

## Phase 3 enrichment policy

Read `docs/enrichment-engine.md` and the unchanged simulator README before changing enrichment. Send exactly the documented five request fields; retain CSV `country` locally. One six-loop in-process pool shares one monotonic 220 ms paced limiter. Claims lock the job before a pending store and commit before limiter/network waits. Successes require a running job, current processing state, matching token, and unexpired lease. Phase 3 records API/transport/contract failures as terminal store failures; retry scheduling and expired-lease recovery remain explicitly deferred.
