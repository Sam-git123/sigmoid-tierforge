# TierForge implementation plan — Phase 0

Phases 0–6 are implemented through configurable scoring and tiering over terminal enrichment jobs. The frontend dashboard remains planned for a later request. See the phase verification reports and [current schema](database-schema.md). Checkboxes remain unchecked until the complete requirement has implementation evidence.

Sources: [complete original assignment](requirements/tierforge-requirements.md), [simulator README](../enrichment_simulator/README.md), and the user's Phase 0 brief. See [architecture](architecture.md) for flow/transaction details and [decisions](decisions-and-assumptions.md) for chosen defaults. `R` identifies assignment core requirements, `Q` evaluation/quality criteria, `U` user-directed constraints, `B` assignment bonuses, and `D` implementation choices. Phase references connect each item to planned acceptance evidence.

## Assignment traceability checklist

### Context, evaluation, and stack — Sections 1–3

- [ ] **R01 — §1:** Process a large store list through enrichment and user-configurable scoring/tiering. Evidence: Phase 5 full 5,000-row exercise and dashboard; Phases 2–4 provide constituent flows.
- [x] **Q01 — §2 architecture/data modeling:** Separate unreliable enrichment, persisted raw data, work units, and deterministic calculated scores. Evidence: Phases 1–6 boundaries, schema review, and zero-network scoring test.
- [x] **Q02 — §2 resilience/concurrency:** Phases 4–5 cover bounded retries, timeouts, fencing, expired-lease recovery, completion races, and systemic termination.
- [ ] **Q03 — §2 code quality:** Readable names, consistent error handling, understandable code that can be defended in review. Evidence: each phase's focused review and final architecture walkthrough.
- [ ] **Q04 — §2 tests:** Tests are optional in the assignment, encouraged for retry/backoff/formula/boundaries; this project's user-specified stack and plan adopt them. Evidence: Phases 3–5, single documented test command.
- [ ] **R02 — §2/§6 scope:** Respect 2–3 days of effort and deliver core before bonuses. Evidence: phased time budget, explicit deferred scope, honest final limitations.
- [ ] **R03 — §3/§5.2:** Integrate the provided simulator; do not build or modify a replacement. React/Node/PostgreSQL are assignment preferences; this project's exact stack is fixed by the user. Evidence: Phase 3 real-simulator smoke run, unchanged supplied files.

### Upload — Section 4, Step 1

- [x] **R04:** Upload a store CSV. Evidence: Phase 2 multipart API and durable queued job/store integration tests. A frontend upload screen is outside this phase.
- [x] **R05:** Validate required headers before acceptance: `store_id`, `store_name`, `address`, `city`, `state`, `country`. Evidence: Phase 2 parser/API tests cover missing/duplicate headers, malformed structure, understandable errors, and no partial job.
- [ ] **R06:** Use provided sample assets. Evidence: Phase 2 parse acceptance and Phase 5 preserved sample CSV; missing generator tracked, not silently recreated.

### Enrichment — Section 4, Step 2

- [x] **R07:** Submission creates a job that enriches each store using the external `POST /enrich` contract. Evidence: Phases 2/3; one persisted work row per accepted store, asynchronous `202` response, and coordinator integration test.
- [x] **R08:** Persist `estimated_monthly_footfall`, `estimated_monthly_revenue`, and `store_size_sqft` for accepted successes. Evidence: Phase 3 response validation and fenced PostgreSQL persistence tests.
- [x] **R09:** Track succeeded, failed, and pending work; expose job progress and final per-store reasons. Evidence: Phases 3/5 count invariants and Phase 7 persisted progress/failure APIs.

### Scoring — Section 4, Step 3

- [ ] **R10:** Backend configuration has one bar and one 0–100% weight for each metric, with an exact 100% sum. Phase 6 API validation is complete; the UI remains Phase 7.
- [ ] **R11:** Backend accepts validated Large and Medium thresholds with inclusive tiering. Phase 6 API/formula coverage is complete; the UI remains Phase 7.
- [x] **R12:** Score equals the sum of weights for metrics meeting their bars; no normalization or ranges. Evidence: Phase 6 SQL and pure formula tests cover equality boundaries and 0/100 scores.
- [x] **R13:** Reproduce worked example: bars 15000/150000/8000, weights 50/30/20, thresholds 70/40; A(40000,400000,18000)=100/Large, B(20000,100000,5000)=50/Medium, C(2000,20000,9000)=20/Small. Evidence: Phase 6 unit and PostgreSQL fixtures use those exact values.
- [x] **R14:** Score every successful enrichment from stored data, never call enrichment to recalculate, and support safe reruns after configuration changes. Evidence: Phase 6 zero-call, atomic rollback, failed-store exclusion, and concurrent revision tests.

### Dashboard — Section 4, Step 4

- [ ] **R15:** Show enriched, failed, and pending counts and visible failure reasons. Phase 7 backend APIs are complete; React presentation remains future work.
- [ ] **R16:** Show Large, Medium, and Small counts. Phase 7 returns current-revision database counts; React presentation remains future work.
- [ ] **R17:** Show store name, category-equivalent metrics, score, and tier. Phase 7 returns these fields with correct null handling; React presentation remains future work.
- [ ] **R18:** Filter the store list by tier. Phase 7 performs filtering/counting in SQL; React controls remain future work.

### Supplied service and data — Section 5

- [ ] **R19 — §5.1:** Include supplied sample files, including ready-made 5,000-row CSV and generator if provided. CSV is present; generator was not found. Evidence: Phase 5 asset inventory and documented missing file or user-provided recovery.
- [ ] **R20 — §5.2:** Run the unchanged local simulator without an internet dependency, account, or API key for enrichment. Evidence: Phase 3 local run and Phase 5 README setup instructions.
- [x] **R21 — §5.2 mode 1:** Respect global 5 requests/second; handle 429. Evidence: Phase 3/4 paced-limiter, shared cooldown, and 429-then-success tests; all retries use the same limiter.
- [x] **R22 — §5.2 mode 2:** Handle approximately 10% transient 500 responses using bounded retry. Evidence: Phase 4 controlled 500-then-success and exhaustion tests with persisted attempts.
- [x] **R23 — §5.2 mode 3:** Handle 45–60-second delayed successes without stale results corrupting newer accepted work. Evidence: Phase 4 independent deadline, ignored-abort late response, old-token success/failure, and one-result tests.
- [ ] **R24 — §5.2 mode 4:** Recognize deterministic metrics for a store ID; correctness must still rely on fencing, not determinism. Evidence: Phase 3 repeated-ID contract smoke check and deliberately different old/new test responses to reveal overwrites.

### Required scope/resilience — Section 6.1

- [ ] **R25:** End-to-end Steps 1–4 for a single job at a time. Evidence: Phases 2–5 active-job conflict test and complete core walkthrough.
- [x] **R26 — A:** Retry transient failures with a cap. Evidence: Phase 4 uses at most five attempts, persists jittered due times, and ends with `RETRY_EXHAUSTED`.
- [x] **R27 — B:** Phase 4 handles ignored-abort HTTP calls and stale callbacks; Phase 5 conditionally reclaims expired leases and retries with new tokens.
- [x] **R28 — C:** Phase 5 bounds a systemically broken run using a persisted consecutive provider-failure streak and exposes a clear terminal failure.

### Final deliverables — Section 7 (planned, not produced in Phase 0)

- [ ] **R29 — §7.1:** Repository or ZIP contains backend and frontend. Evidence: Phase 5 package inventory. The user prohibits automatic commits; delivery preparation does not imply a commit or push.
- [ ] **R30 — §7.2.1:** README setup/run instructions. Evidence: Phase 5 clean setup rehearsal.
- [ ] **R31 — §7.2.2:** README explains running provided simulator alongside app. Evidence: Phase 5 documented working directory, Python install/run commands, configurable base URL, and DB/app startup.
- [ ] **R32 — §7.2.3:** README briefly explains architecture choices. Evidence: Phase 5 summary linked to architecture documentation.
- [ ] **R33 — §7.2.4:** README states known limitations/shortcuts. Evidence: Phase 5 concrete single-process/restart/validation limits and observed results.
- [ ] **R34 — §7.3:** Preserve/include provided sample files. Evidence: Phase 5 sample CSV and original attachment inventory, with missing generator explicitly disclosed.
- [ ] **R35 — §7.4:** If tests are included, one documented command runs them. Evidence: Phase 5 `pnpm test` from repo root with PostgreSQL test prerequisite documented. No test scripts exist in Phase 0.

### Bonus only — Section 6.2

- [ ] **B01:** Multiple concurrent enrichment jobs sharing the global request budget. Deferred until core passes; revisit the single-active-job constraint and fairness. Multiple processes additionally require a shared limiter, not separate process-local buckets.
- [ ] **B02:** Full process-restart resumability without losing in-flight work or redoing successes. Deferred; core terminates interrupted jobs honestly. Lease recovery inside a live process remains mandatory R27.

## User-directed constraints and non-functional requirements

- [ ] **U01:** React/TypeScript/Vite, Tailwind, TanStack Query, Node/TypeScript/Express, PostgreSQL/`pg`, Zod, Vitest/Supertest, pnpm workspaces, Docker Compose PostgreSQL. Phase 1 scaffold/build acceptance.
- [x] **U02:** One store per persisted work unit; asynchronous enrichment; durable processing, retry, success, and failure states. Phases 2–4 state and persistence tests.
- [x] **U03:** Phases 4–5 cover atomic claims, fencing, bounded jittered retries, timeout/network handling, and the general lease reaper.
- [x] **U04:** One process-wide limiter used by the background worker module without extra queue infrastructure. Phase 4 proves initial and retry attempts share it, including provider cooldown.
- [x] **U05:** Separate raw enrichment from scores and enrichment module from scoring; Phase 6 uses set-based SQL and proves zero upstream calls.
- [ ] **U06:** Polling dashboard; no authentication or infrastructure expansion. Phase 5 behavior/scope review.
- [ ] **U07:** Phase 0 creates project guidance, architecture with three Mermaid diagrams, traceable plan, and explicit decisions/assumptions; no application implementation, package installation, or commits. Phase 0 document verification.
- [x] **Q05:** Progress remains responsive while enrichment runs; upload HTTP request does not wait on remote work. Phase 3 controlled-client integration test holds enrichment open after the `202` response.
- [ ] **Q06:** Bounded memory, no whole-job fan-out, bounded connection usage, no network waits inside DB transactions. Phases 2/3 limits and concurrency review.
- [x] **Q07:** Exact numeric scoring and atomic revision visibility. Phase 6 validates integer-hundredth inputs and tests rollback/concurrent publication.
- [ ] **Q08:** Configurable operational defaults, structured actionable errors/logs, no false success reports. Phases 1/3/5 environment validation and failure walkthrough.
- [ ] **Q09:** Responsive accessible forms, labels, keyboard operation, visible validation/loading/error states. Phase 5 manual checks; these are chosen quality goals, not additional assignment features.

## Database schema proposal (historical Phase 0 design)

The following is retained as the historical Phase 0 proposal, not the implemented schema. The later user request takes precedence: [current Phase 1 schema](database-schema.md) documents the implemented five tables and deliberate deferrals. Use generated UUID internal IDs, `timestamptz` timestamps, `text` plus check constraints for small status sets, and exact `numeric` for business values. Prefix external store identity with its job in all uniqueness rules.

### `jobs`

Columns: `id uuid PK`, `status` (`running`, `completed`, `completed_with_errors`, `failed`), `total_stores integer`, `created_at`, `finished_at nullable`, `failure_code/message nullable`, `consecutive_dependency_failures integer default 0`, `max_attempts integer`, `run_settings jsonb`, `current_scoring_config_id uuid nullable`.

Constraints/indexes: `total_stores > 0`; nonnegative failure streak; snapshot validated retry/lease/concurrency settings at creation; terminal state requires finish time. Partial unique index on constant `(1)` where status is `running` ensures one active job across competing requests. Composite foreign key `(id, current_scoring_config_id)` references config `(job_id, id)` (nullable pointer permits job creation before config). Add the circular foreign key after both tables exist. Timestamp/latest-job index supports current-or-latest lookup. Progress counts are computed, not independently incremented cached fields.

### `store_work`

Columns: `id uuid PK`, `job_id FK`, `source_row_number integer`, `store_id`, `store_name`, `address`, `city`, `state`, `country` as text; `status` (`pending`, `processing`, `retry_wait`, `succeeded`, `failed`); `attempt_count integer default 0`; `next_attempt_at nullable`; `lease_token uuid nullable`; `lease_expires_at nullable`; `last_error_code/message/http_status nullable`; `final_error_code/message nullable`; `created_at`, `updated_at`, `finished_at nullable`.

Constraints/indexes: unique `(job_id, store_id)` and `(job_id, id)`; nonnegative attempt count; processing requires token and expiry, all other states require both null; retry_wait requires next-attempt time; terminal rows require finish time. Index pending/due work by `(job_id, next_attempt_at, id)` with a status predicate; separate `(job_id, lease_expires_at, id)` processing index for reaping; `(job_id, status)` for aggregation. Pending selection treats creation time as eligibility time when next-attempt is null. Update state, timestamps, and error information together.

### `enrichment_attempts`

Columns: `id uuid PK`, `work_id FK`, `attempt_number integer`, `lease_token uuid`, `claimed_at`, `dispatched_at nullable`, `finished_at nullable`, `outcome` (`in_flight`, `succeeded`, `retryable_failure`, `permanent_failure`, `lease_expired`, `cancelled`), `error_code/message nullable`, `http_status nullable`, `duration_ms nullable`, `next_attempt_at nullable`.

Constraints/indexes: unique `(work_id, attempt_number)` and token; attempt number positive; partial unique work ID for in-flight attempts to guard one current attempt. Claim and attempt insertion are atomic; every release/reap/termination closes that attempt. Record dispatch only while the fence is current and recheck before sending; there is no transactional coupling between PostgreSQL and an external HTTP send, so delivery remains at least once. Index `(work_id, attempt_number)` supports detail history. No separate network retries hidden within the HTTP library.

### `enrichment_results`

Columns: `work_id uuid PK`, `job_id uuid`, `accepted_attempt_id FK`, `raw_payload jsonb`, `estimated_monthly_footfall numeric`, `estimated_monthly_revenue numeric`, `store_size_sqft numeric`, `enriched_at`.

Constraints/indexes: composite FK `(job_id, work_id)` to work; same-work accepted attempt via a composite FK using a unique `(work_id, id)` on attempts. Metrics nonnegative; application response validation also rejects nonfinite values. Unique `(job_id, work_id)` supports score FKs. Only current fenced success creates a row. Raw payload preserves upstream values; typed columns are validated projections, not scores.

### `scoring_configs`

Columns: `id uuid PK`, `job_id FK`, `revision integer`, three metric bars as `numeric`, three weights as `numeric`, `large_min numeric`, `medium_min numeric`, `created_at`.

Constraints/indexes: unique `(job_id, revision)` and `(job_id, id)`; revision positive; bars nonnegative; weights each between 0 and 100, sum exactly 100; `0 <= medium_min < large_min <= 100`. Reject input precision beyond two decimal places before insertion. Allocate revision while holding the job lock. Config rows are immutable.

### `store_scores`

Columns: `job_id uuid`, `config_id uuid`, `work_id uuid`, `score numeric`, `tier text`, `calculated_at`; PK `(config_id, work_id)`.

Constraints/indexes: composite FK `(job_id, config_id)` to configs and `(job_id, work_id)` to results; score 0–100; tier in `Large`, `Medium`, `Small`. Index `(config_id, tier, work_id)` supports filter and counts. Published pointer joins determine current results. No cascade-deletion UI/retention feature in core; restrict deletes to avoid accidental data loss. Historical rows can grow with reruns, acceptable for a local take-home and documented as a limit.

## API endpoints and response rules

- `POST /api/jobs`: multipart `file`; `202 {jobId, status, totalStores, statusUrl}` after transaction commit. Whole-file validation errors include row/field details. `409` returns existing active job ID.
- `GET /api/jobs/current`: `{job: summary|null}` for active or latest job.
- `GET /api/jobs/:jobId`: status, persisted progress counts/substates, timestamps, job reason, current config revision, and tier breakdown.
- `GET /api/jobs/:jobId/stores`: optional `tier`, `status`, `configRevision`; page defaults 1, page size 50/max 100. Return effective revision, total matching rows, and store fields/metrics/score/tier/error. Validate filters; parameterize SQL.
- `GET /api/jobs/:jobId/stores/:workId`: store detail and attempt history. Reject cross-job work IDs with `404`.
- `POST /api/jobs/:jobId/scoring`: flat camel-case bars, weights, and tier thresholds as numbers or decimal strings. `201` returns revision, configuration, stores scored, and tier counts. Invalid weights/bars/thresholds: `422`.
- `GET /api/jobs/:jobId/scoring`: highest committed configuration plus revision and tier summary, or a null configuration before scoring.
- `GET /api/health`: DB readiness, `503` if unavailable; do not couple DB readiness to a flaky upstream.

Error envelope: `{error: {code, message, details?, requestId}}`. Invalid multipart/CSV syntax `400`; unsupported content type `415`; file limits `413`; semantic validation `422`; unknown resources `404`; DB outage `503`; unexpected internal error `500` with safe message. A persisted job/store failure is represented in a successful GET response, not an HTTP 500. A scoring statement timeout returns a safe transient error and keeps the previous revision.

## Proposed folder structure

This tree began as the Phase 0 target layout. The foundation, ingestion, resilient worker lifecycle, and scoring modules through Phase 6 now exist; the frontend dashboard remains planned.

```text
sigmoid-tierforge/
  AGENTS.md
  README.md                         # Phase 5 runbook/delivery notes
  package.json                      # workspace scripts
  pnpm-workspace.yaml
  pnpm-lock.yaml
  compose.yaml                      # PostgreSQL only
  .env.example
  apps/
    api/
      src/
        app.ts                      # Express construction, no listener on import
        server.ts                   # startup/shutdown and worker lifecycle
        config/
        db/                         # pg pool, transactions, migrations
        modules/
          jobs/                     # upload, progress, repositories, routes
          enrichment/               # external client and response validation
          worker/                   # claim, limiter, backoff, lease reaper
          scoring/                  # config, formula SQL, bulk publication
        middleware/                 # error handling/request IDs
      test/                         # DB concurrency and HTTP integration tests
    web/
      src/
        api/
        features/upload/
        features/jobs/
        features/scoring/
        components/
  packages/contracts/               # shared Zod API schemas/types, no DB/client code
  docs/
    requirements/tierforge-requirements.md
    architecture.md
    implementation-plan.md
    decisions-and-assumptions.md
  enrichment_simulator/             # supplied, unchanged
  stores_5000.csv                    # supplied, unchanged
  tierforge-use-case.rtf             # supplied original, preserved
```

Avoid speculative repositories/framework layers: small repositories for transactional SQL and services for orchestration are enough. A test-only scripted transport is allowed to inject failures; it is not a replacement simulator and must never back the production flow.

## Phases and acceptance criteria

Proposed effort is 22 focused hours (roughly 2–3 working days); it is a planning estimate, not a completion promise. Full-sample network runs can proceed while final documentation is prepared. Finish each phase with evidence and known gaps. Do not automatically continue from Phase 0 into implementation.

### Phase 0 — Analysis and documentation (1.5 hours; completed)

Deliver root guidance, architecture, implementation plan, and decision register; read the full assignment and simulator README; reconcile the requirements path without rewriting its contents.

Acceptance:

- All assignment sections, failure modes, scoring examples, core/bonus distinctions, and final deliverables have traceable IDs above.
- Three Mermaid diagrams describe architecture, lifecycle, and store state machine.
- Defaults and assumptions are identified as decisions, simulator uncertainties are explicit, and provided assets are preserved.
- Verify requirements copy hash, relative documentation links, file inventory, required sections, and documentation-only change scope. No application tests/build can be claimed before code exists.
- No app implementation, package installation, commits, or pushes. Stop after the documentation handoff.

### Phase 1 — Workspace and persistence foundations (completed)

Create the fixed-stack workspace, environment validation, PostgreSQL Compose service/migrations, shared schemas, minimal health route, and test harness. Implement tables/constraints/indexes from this proposal; validate lock-order design in a focused DB test.

Acceptance:

- Fresh documented install and migration command succeeds against a disposable DB; application boot requires valid configuration and DB connection.
- Workspace lint/typecheck/build succeed; one root test command can run Vitest and Supertest suites with documented DB prerequisite.
- Constraints reject duplicate store IDs per job, second active job, cross-job score links, invalid weights, and invalid lease/state combinations.
- Modules import cleanly; server startup is separate from constructing the Express app for tests; simulator remains unchanged. Covers U01 and Q01 foundations.

### Phase 2 — CSV intake and durable job API (implemented)

Implement bounded CSV parser, whole-file validation, transactional job/work creation, progress/store queries, and a basic upload UI.

Acceptance:

- Supplied CSV parses to the expected 5,000 stores with all required fields. Valid upload returns promptly after commit without calling enrichment inside the request.
- Missing/duplicate headers, empty data, malformed quotes, duplicate IDs, oversized files, and blank required fields produce useful errors and no partial accepted jobs. Quoted fields, BOM, reordered columns, and extra-column warning behave as documented.
- Two simultaneous valid submissions yield one active job and one `409`; every accepted store has exactly one persisted pending row.
- Progress obeys count invariants. DB errors roll back import. Covers R04–R07, R25, U02, Q05/Q06.

### Phase 3 — Basic enrichment engine (implemented)

Implemented the documented simulator client, validated success payloads, one process-wide 220 ms paced limiter, six fixed worker loops, atomic pending claims, UUID leases, fenced metric persistence, queued-job notification, startup discovery, and terminal placeholder failure handling.

Evidence:

- Controlled-client tests cover documented request fields, response validation, HTTP/transport classification, fixed-loop processing, and prompt upload response.
- A 20-caller deterministic limiter test proves every adjacent start is at least 220 ms apart and every sixth start is more than one second after the first.
- PostgreSQL tests prove two concurrent claims cannot own one row, stale/expired tokens cannot write, success and metrics commit together, and duplicate completion creates one result.
- No transaction spans limiter waiting or HTTP work. The existing schema supports Phase 3, so no migration was added.
- The supplied simulator remains unchanged. Its smoke test was unavailable because this environment has no Python interpreter; this is reported rather than simulated.

Advanced 429/500 retry, persisted backoff, lease reaping, late-response races, attempt history, and systemic-failure termination remain unchecked requirements for the next resilience phase.

### Phase 4 — Resilient enrichment attempts (implemented)

Implemented typed transient/permanent errors, at most five attempts, pure capped exponential full jitter, database-time retry scheduling, due retry claims, coordinator wakeups, `Retry-After` lower bounds, independent 8-second deadlines, abandoned-promise rejection handling, and token-fenced failure paths.

Evidence:

- Deterministic 500, 429, network, timeout, permanent-error, and retry-exhaustion tests.
- PostgreSQL due-time, new-token retry, stale success/failure, simultaneous completion, and no-duplicate-result tests.
- A controlled transport ignores abort and resolves after retry success; accepted metrics remain those from the current token.
- No worker loop sleeps through backoff and no transaction spans a rate-limit wait, backoff wait, or HTTP call.

Job-wide systemic-failure termination and general expired-processing reclamation are implemented in Phase 5.

### Phase 5 — Systemic watchdog and lease recovery (implemented)

Implemented the independent expired-lease reaper, periodic coordinator watchdog, bounded job-wide systemic-failure policy, persistent progress percentage, and terminalization of all unfinished work. The watchdog is separate from Phase 4's per-attempt logical timeout. Focused PostgreSQL tests cover lease recovery, final-attempt expiry, completion races, lifecycle states, systemic stop, late-result fencing, progress invariants, and active-slot release.

### Phase 6 — Scoring configuration and recalculation (implemented)

Implemented exact two-decimal API validation, immutable per-job revisions, terminal-job gating, one set-based SQL scoring statement, atomic publication, current-configuration reads, and zero-network recalculation. No schema migration was needed because Phase 1 already created revisioned configuration and score tables.

Acceptance:

- Exact assignment A/B/C fixtures and equality boundaries pass; all-zero/all-cleared metrics and 0/100 weight edges are covered. Invalid totals/order/precision fail without DB mutation.
- Rerunning changes scores/tiers from stored metrics with zero enrichment calls and no raw-data changes.
- Forced mid-calculation failure preserves the previous visible revision. Concurrent submissions serialize; a concurrent accepted success appears under the correct active revision.
- Tier counts/store rows refer to one explicit revision; newly successful stores receive that revision automatically. Failed/pending rows remain unscored.
- Focused unit and PostgreSQL tests cover the assignment examples, inclusive boundaries, zero weights, invalid precision/totals/thresholds, failed-store exclusion, reruns, rollback, and concurrent revision allocation. A full 5,000-row timing run remains for final integration. Covers backend portions of R10–R14/R16, U05, and Q07.

### Phase 7 — Read APIs for dashboard data (implemented)

Implemented database-backed job progress, stable paginated store/failure lists, SQL tier filtering, and a current-revision dashboard summary. The React dashboard is deliberately outside this phase.

Acceptance:

- Unknown and invalid IDs return consistent 404/422 envelopes.
- Store pages use stable ordering, return database nulls for missing metrics/scores, and cap page size at 100.
- Tier filters and totals are applied in SQL against only the highest committed score revision.
- Failure pages distinguish failed from skipped work and retain final reasons.
- Dashboard counts use persisted work/current-revision scores; unscored rows never become Small.
- Focused PostgreSQL tests cover empty results, validation, pagination boundaries, partial failure, rescoring, tier counts, reasons, and duplicate prevention.

### Phase 8 — React dashboard, integration, and submission preparation (future)

Complete polling dashboard, failure detail, scoring UI, tier-filtered list, final checks, and full-sample walkthrough. Prioritize core defect correction over UI polish or bonuses.

### Optional phase — Bonuses (no reserved core budget)

Only after a later explicit request and all core acceptance checks: add concurrent jobs with globally coordinated request admission, or full restart continuation. Each needs dedicated failure/concurrency tests and revised trade-offs. No bonus work is authorized now.

## Testing strategy

Use Vitest for pure rules and service tests; Supertest for HTTP handlers; real disposable PostgreSQL for locking/constraint/transaction behavior. Never substitute mocked SQL for evidence about `SKIP LOCKED`, uniqueness races, or fencing. Use controlled injected clocks/randomness/transport for deterministic timeout/backoff tests; manipulate DB lease timestamps in integration tests instead of assuming JS fake timers change PostgreSQL time.

Test the dispatch boundary and transaction side effects, not just helper return values. Inject a late response that ignores AbortSignal, a worker handler that never settles, a scoring transaction failure, and a competing completion/reaper. Assert raw results, attempt history, published scores, state counts, and future retry eligibility after each race. Measure retries across the same limiter as first attempts.

Keep live-simulator smoke tests separate from deterministic suites because failures/delays are probabilistic. Do not modify the provided service to force outcomes; use a test-only transport for those cases. A clean documented `pnpm test` should run deterministic unit/API/DB integration tests once DB prerequisites are met; a separately documented live smoke command may exercise the simulator. No testing/build dependencies are installed in Phase 0.

## Scope boundary and completion reporting

Mandatory assignment scope: CSV intake, asynchronous resilient enrichment, persisted results/work tracking, exact configurable score/tier reruns without enrichment, and dashboard for one active job. User constraints select the stack and queue/concurrency techniques. Extra validation, pagination, revision history, startup termination policy, and numeric precision are explicit implementation choices in service of core.

Do not claim bonuses, a missing generator, untested runtime behavior, or proposed scripts are complete. Each future handoff lists requirement IDs satisfied, files changed, commands/results, limitations, and an optional commit-message suggestion. Do not create a commit unless the user later explicitly requests one.
