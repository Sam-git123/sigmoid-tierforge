# TierForge final requirement audit

Audit date: 2026-10-09  
Authority: `docs/requirements/tierforge-requirements.md` and the supplied simulator README  
Scope: complete repository review, targeted fixes, automated verification, and a live local integration smoke test

## A. Executive summary

TierForge implements the complete mandatory workflow and both Section 6.2 bonuses: concurrent enrichment jobs, database-coordinated global rate admission across processes, restart continuation, independent scoring/rescoring, and the database-backed React dashboard. The final verdict is **READY WITH DOCUMENTED LIMITATIONS**.

- Critical issues discovered (P0): **0**.
- High-priority issues discovered (P1): **2**, both fixed.
- Medium-priority issues discovered (P2): **1**, fixed.
- Confirmed implementation issues fixed: **3**.
- Unresolved mandatory implementation defects: **0**.
- Unresolved supplied-artifact gap: **1** — the assignment refers to a sample generator, but no generator was present in the received repository or attachments.
- Automated result: **217 tests passed, 0 failed, 0 skipped** on the final complete run, including **101 real PostgreSQL tests**.
- Live result: the unchanged simulator and two compiled backend processes passed concurrent-job, shared-rate, forced-restart, committed-success preservation, lease recovery, and per-job scoring checks.

The remaining risks are documented and bounded: coordination requires one shared PostgreSQL database and compatible process settings; an interrupted uncommitted external request may execute again; Docker was unavailable in this Windows environment; the 5,000-row workflow used deterministic persisted enrichment fixtures rather than 5,000 live simulator calls; and the missing sample generator cannot be restored without the original supplied file.

## B. Original requirement compliance matrix

| Requirement ID | Original Requirement                                                                           | Status       | Evidence                                                                                     | Test Evidence                                                                               | Notes                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| E01            | Section 2: separate slow, unreliable enrichment from fast deterministic scoring                | PASS         | `apps/api/src/workers/`, `services/scoring.service.ts`, `repositories/scoring-repository.ts` | Scoring and database suites; live rescore                                                   | Scoring has no enrichment-client dependency.                                       |
| E02            | Section 2: resilient handling of timeout, transient, silent-worker, and systemic failure modes | PASS         | Enrichment client, worker, coordinator, retry policy, lease SQL                              | Client, worker, retry, and PostgreSQL enrichment tests                                      | Retry and cooldown values are bounded.                                             |
| E03            | Section 2: concurrency correctness without lost or duplicated work                             | PASS         | Fair cross-job claims, DB-wide cap, distributed limiter, lease tokens, conditional writes    | Concurrent claims, two-process rate, restart, stale result, scoring concurrency tests       | Multiple processes coordinate through one PostgreSQL database.                     |
| E04            | Section 2: readable, consistent code and error handling                                        | PASS         | Strict TypeScript, Zod boundaries, centralized API errors, ESLint/Prettier                   | Lint, typecheck, format check, build                                                        | No broad refactor was needed.                                                      |
| E05            | Section 2: appropriate SQL data model for jobs, work, raw results, configs, and scores         | PASS         | Migrations 001–003 and five job-domain tables plus limiter infrastructure                    | Foundation constraints and feature database suites                                          | Domain data remains separate from coordination state.                              |
| E06            | Section 2: tests are optional but a positive signal                                            | PASS         | `apps/api/tests/`, `apps/web/tests/`                                                         | 217/217 final run plus dedicated live process harness                                       | One documented root command runs the deterministic suite.                          |
| E07            | Section 2: 2–3 day effort time box                                                             | NOT VERIFIED | Repository history cannot prove elapsed human effort                                         | Not testable                                                                                | This is an evaluation constraint, not runtime behavior.                            |
| F01            | Section 4 Step 1: upload a store CSV                                                           | PASS         | Multipart route, Multer middleware, CSV service, upload UI                                   | CSV, job-service, PostgreSQL job, and frontend tests; live upload                           | Upload is bounded in memory by configured size.                                    |
| F02            | Section 4 Step 1: validate all six required headers with clear errors                          | PASS         | `services/csv-service.ts`, `docs/csv-ingestion.md`                                           | Missing/duplicate headers, malformed rows, empty data, quoted commas, UTF-8 tests; live 422 | Headers are trimmed and case-sensitive by policy.                                  |
| F03            | Section 4 Step 2: create a job and enrich every accepted store                                 | PASS         | Atomic job repository, coordinator, worker, client                                           | Job and enrichment database suites; live 3-store job                                        | Every store receives a durable work row.                                           |
| F04            | Section 4 Step 2: persist footfall, revenue, and store-size metrics                            | PASS         | `store_enrichments` schema and fenced success transaction                                    | Constraint and enrichment database tests; live dashboard                                    | Metrics remain null when enrichment did not succeed.                               |
| F05            | Section 4 Step 2: expose progress and final failure reasons                                    | PASS         | Job, store, failure, and dashboard read APIs; progress/dashboard UI                          | Job/dashboard database and frontend workflow tests                                          | Final dashboard now shows pending work and failure details directly.               |
| F06            | Section 4 Step 3: configure one bar and 0–100% weight per metric; weights total 100%           | PASS         | Scoring Zod schema, form validation, service normalization                                   | Scoring unit/database and frontend tests                                                    | Values support at most two decimal places.                                         |
| F07            | Section 4 Step 3: configure Large and Medium thresholds                                        | PASS         | Scoring schema, service, repository, UI form                                                 | Boundary and invalid-config tests                                                           | `largeThreshold >= mediumThreshold` is enforced.                                   |
| F08            | Section 4 Step 3: exact additive formula with inclusive bar comparisons                        | PASS         | Set-based scoring SQL and domain scoring helper                                              | Worked A/B/C examples, equality, zero, all-pass/all-fail, decimal tests                     | No normalization, percentile, or relative ranking.                                 |
| F09            | Section 4 Step 3: score stored data quickly and rerun without enrichment                       | PASS         | Atomic scoring revision transaction over persisted successful enrichment                     | Rescore/no-upstream-call, rollback, concurrency, live revision 1→2                          | Previous revisions remain immutable.                                               |
| F10            | Section 4 Step 4: show enriched, failed, and pending counts and failure reasons                | PASS         | Dashboard summary, `DashboardStats`, `FailureTable`                                          | Dashboard DB and frontend rendering tests; live dashboard                                   | This was partially implemented before this audit and is now fixed.                 |
| F11            | Section 4 Step 4: show Large, Medium, and Small counts                                         | PASS         | Current-revision dashboard aggregation                                                       | Dashboard/scoring/5,000-row database tests                                                  | Unscored rows are excluded from all tiers.                                         |
| F12            | Section 4 Step 4: show identity, three metrics, computed score, and tier                       | PASS         | Paginated store join API and results table                                                   | Dashboard DB, client schema, frontend tests                                                 | Missing values remain null instead of fabricated zeroes.                           |
| F13            | Section 4 Step 4: filter stores by tier                                                        | PASS         | SQL tier predicate and frontend filter                                                       | Filter/count/pagination tests; live filter                                                  | Filtering and totals occur before pagination in SQL.                               |
| P01            | Section 5.1: supplied sample generator                                                         | PARTIAL      | No generator exists in received files                                                        | Repository inspection                                                                       | Cannot reconstruct an absent supplied artifact without changing provenance.        |
| P02            | Section 5.1: supplied 5,000-row CSV                                                            | PASS         | `stores_5000.csv`                                                                            | 5,000-row PostgreSQL workflow test                                                          | Full live 5,000-call simulator run was not performed.                              |
| P03            | Section 5.2: run supplied simulator locally without account/API key                            | PASS         | Unchanged `enrichment_simulator/`, configurable base URL                                     | Fresh live simulator smoke                                                                  | Existing local virtual environment was used.                                       |
| P04            | Section 5.2: global five requests/second                                                       | PASS         | Database-coordinated 220 ms request-start reservations and shared cooldown                   | Deterministic two-pool DB test and live two-process rolling-window evidence                 | All participating workers must use the same database and compatible configuration. |
| P05            | Section 5.2: transient HTTP 500 behavior is retried                                            | PASS         | Typed client error, persisted retry state, jitter policy                                     | Client/worker/repository tests; live smoke observed 500 then success                        | Attempts are capped per store.                                                     |
| P06            | Section 5.2: delayed 45–60 second success cannot corrupt data                                  | PASS         | Logical timeout, observed abandoned promise, token/lease fences                              | Ignored-abort test plus real ownership-change late-success and late-failure DB tests        | Correctness does not depend on AbortController stopping transport.                 |
| P07            | Section 5.2: deterministic results for one store ID                                            | PASS         | Property verified in unchanged supplied simulator source/README                              | Fencing tests use distinguishable old/new values                                            | Live duplicate-success calls were not separately executed.                         |
| P08            | Section 5: treat simulator as an uncontrolled dependency                                       | PASS         | Generic HTTP boundary, validation, timeout, retry, cooldown, and permanent error handling    | Client and worker suites                                                                    | No simulator-specific success shortcut exists.                                     |
| S01            | Section 6.1: Steps 1–4 end to end                                                              | PASS         | Full API/UI flow remains job-scoped                                                          | Core regression suite and live bonus harness                                                | Historical completed jobs are retained.                                            |
| S02            | Section 6.1 A: retry transient failures with a cap                                             | PASS         | Persisted attempt count/max, retry policy, terminal exhaustion                               | 500/429/network/timeout/max-attempt tests                                                   | Retry-After is capped by `MAX_UPSTREAM_COOLDOWN_MS`.                               |
| S03            | Section 6.1 B: reclaim unreasonable calls elsewhere without double count                       | PASS         | Lease expiry watchdog and fenced attempt writes                                              | Silent worker, reclaim, exhausted lease, stale success/failure tests                        | A final ownership check also avoids dispatching already revoked claims.            |
| S04            | Section 6.1 C: stop systemically broken runs with a clear terminal state                       | PASS         | Persisted failure streak and atomic unfinished-row settlement                                | Sustained provider failure and late-result fencing database tests                           | Prior successful rows are preserved.                                               |
| B01            | Section 6.2 Bonus 1: multiple concurrent jobs with one global limit                            | PASS         | Migration 003, fair cross-job claims, DB-wide processing cap, distributed limiter, job list  | Multi-job DB tests and two independent backend-process live harness                         | Coordination boundary is the shared PostgreSQL database.                           |
| B02            | Section 6.2 Bonus 2: full restart resumability                                                 | PASS         | Durable retries/leases, startup discovery, fenced writes, idempotent committed success       | Retry/startup DB tests and forced process kill/relaunch against unchanged simulator         | Interrupted uncommitted external calls may repeat after lease expiry.              |
| S05            | Section 6: preserve scope discipline                                                           | PASS         | Bonus implementation adds only PostgreSQL coordination and job navigation                    | Repository and dependency inspection                                                        | No Redis, queue broker, microservices, or auth added.                              |
| D01            | Section 7.1: Git repository contains backend and frontend                                      | PASS         | `apps/api/`, `apps/web/`, workspace configuration                                            | Build and typecheck                                                                         | User will choose ZIP or repository link.                                           |
| D02            | Section 7.2: README setup/run instructions                                                     | PASS         | `README.md`, `.env.example`                                                                  | Commands exercised except Docker Compose                                                    | Native PostgreSQL path was exercised.                                              |
| D03            | Section 7.2: simulator instructions alongside application                                      | PASS         | README simulator and terminal instructions                                                   | Fresh live smoke                                                                            | Simulator files were not modified.                                                 |
| D04            | Section 7.2: architecture decision note                                                        | PASS         | README architecture section and `docs/architecture.md`                                       | Code-to-doc inspection                                                                      | Documents concurrent, restart-capable implementation.                              |
| D05            | Section 7.2: known limitations and shortcuts                                                   | PASS         | README limitations and this report                                                           | Inspection                                                                                  | Separates core limits from bonus scope.                                            |
| D06            | Section 7.3: include supplied sample data files                                                | PARTIAL      | 5,000 CSV, RTF, and simulator are present                                                    | Git diff and repository inspection                                                          | Referenced generator was not supplied.                                             |
| D07            | Section 7.4: included tests run with one documented command                                    | PASS         | Root `pnpm test`; README test section                                                        | 208/208 final run                                                                           | `TEST_DATABASE_URL` enables mandatory real-DB execution.                           |

## C. Missing requirements from the original assignment

### C1. Dashboard pending count and failure reasons were only partially present before the audit

1. **Exact requirement:** Section 4 Step 4 requires enriched/failed/pending counts and, for failures, the reason.
2. **Location:** `docs/requirements/tierforge-requirements.md`, Section 4, Step 4.
3. **Before audit:** PARTIAL. The progress page showed work-state counts and failure details, but the dedicated dashboard showed no pending count and no failure detail table.
4. **Why it matters:** An evaluator following the four-step workflow could reach the final dashboard and lose direct visibility into unfinished or failed work.
5. **Severity:** P1.
6. **Relevant files:** `apps/web/src/components/dashboard.tsx`, `apps/web/src/pages/dashboard-page.tsx`, `apps/web/tests/workflow.test.tsx`.
7. **Fix:** Added a pending summary derived from pending + processing + retry-wait, a separate skipped count, paginated persisted failure details, and terminal-aware polling for the active dashboard summary, store page, and failure page.
8. **After audit:** PASS; nothing remains.

### C2. The sample generator referenced by Sigmoid was absent

1. **Exact requirement:** Section 5.1 says Sigmoid provides a generator and ready-made 5,000-row CSV; Section 7.3 says to include supplied sample files.
2. **Location:** Original requirements Sections 5.1 and 7.3.
3. **Before audit:** PARTIAL. The CSV, RTF, and simulator were present; no generator existed in the received materials.
4. **Why it matters:** A reviewer may expect every supplied artifact to remain in the submission.
5. **Severity:** P2 artifact/provenance gap, not an application defect.
6. **Relevant paths:** `stores_5000.csv`, `tierforge-use-case.rtf`, `enrichment_simulator/`.
7. **Fix:** None. Creating a substitute would misrepresent it as Sigmoid's supplied generator.
8. **After audit:** PARTIAL. Obtain and add the original generator if it exists in the assignment package.

### C3. Historical effort time box cannot be verified from the repository

1. **Exact requirement:** Section 2 states a 2–3 day effort time box.
2. **Location:** Original requirements Section 2.
3. **Status:** NOT VERIFIED before and after the audit.
4. **Why it matters:** It is an evaluation constraint, but repository behavior cannot establish elapsed human effort.
5. **Severity:** P3 verification limitation.
6. **Relevant paths:** original requirements and Git history.
7. **Fix:** None appropriate.
8. **Remaining work:** Candidate should describe actual effort honestly if asked.

No other mandatory original requirement was found missing or partial after tracing the complete workflow and executing the evidence listed above.

## D. Bugs and edge cases discovered

| Severity | Issue                                                                                                       | Reproduction                                                        | Root Cause                                                                                       | Fix                                                                                                                                                                      | Verification                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| P1       | A database failure during the post-limiter ownership check was misclassified as an upstream network failure | Make `isClaimCurrent` reject after a worker claims a row            | Rate wait and repository ownership check were inside the catch intended only for `client.enrich` | Moved limiter/ownership operations outside the provider-error catch; operational DB failures now propagate to coordinator error handling and do not mutate attempt state | New worker test proves no client call and no `recordAttemptFailure`; focused and full suites pass |
| P1       | Final dashboard omitted pending work and persisted failure reasons                                          | Open `/jobs/:jobId/dashboard` for an active or partially failed job | Dashboard page rendered total/enriched/failed/scored only and never queried the failure API      | Added pending/skipped cards, terminal-aware summary/store/failure polling, and paginated `FailureTable`                                                                  | New frontend render test plus full frontend suite; backend failure pagination was already covered |
| P2       | A valid but extreme `Retry-After` could leave a job dormant for an operationally unbounded period           | Return `Retry-After: 3000000` with HTTP 429/5xx                     | Header value was trusted as an unlimited lower bound for row schedule and shared cooldown        | Added validated `MAX_UPSTREAM_COOLDOWN_MS` (default 120,000 ms, maximum 86,400,000 ms) and cap both numeric/date header forms                                            | New deterministic client and environment tests; focused and full suites pass                      |

No confirmed unresolved P0, P1, or P2 implementation bug remains from this audit.

## E. Code changes made

### E1. Preserve the provider/operational failure boundary

- **Files:** `apps/api/src/workers/worker.ts`, `apps/api/tests/worker.test.ts`.
- **Change:** Only `client.enrich` is translated into a provider attempt error. Limiter or database ownership failures escape the worker rather than being persisted as provider outcomes.
- **Reason:** Prevent false store failures and false systemic-failure streak increments during database outages.
- **Requirement/scenario:** Enrichment reliability, accurate failure reasons, bounded systemic handling.
- **Verification:** New ownership-check rejection test and all worker/database tests pass.

### E2. Complete final dashboard observability

- **Files:** `apps/web/src/components/dashboard.tsx`, `apps/web/src/pages/dashboard-page.tsx`, `apps/web/tests/workflow.test.tsx`.
- **Change:** Added total, enriched, pending, failed, skipped, and scored cards; failure details; and two-second summary/store/failure polling until terminal state.
- **Reason:** Meet the original dashboard requirement at the dashboard itself and avoid stale active summaries.
- **Requirement/scenario:** Section 4 Step 4, partial/systemic failure visibility, frontend/backend integration.
- **Verification:** Frontend workflow tests render pending totals and stored error code/message; 11/11 web tests pass.

### E3. Bound upstream cooldown instructions

- **Files:** `.env.example`, `apps/api/src/config/env.ts`, `apps/api/src/server.ts`, `apps/api/src/clients/enrichment-client.ts`, client/environment tests, and architecture/runbook documentation.
- **Change:** Parse and cap `Retry-After` at a validated configurable duration.
- **Reason:** A dependency-controlled header must not keep a finite job dormant for days or overflow practical timers.
- **Requirement/scenario:** Capped retry behavior and clear bounded completion.
- **Verification:** Extreme header returns 120,000 ms; invalid configuration above one day is rejected; complete suite passes.

### E4. Keep repository guidance and evidence current

- **Files:** `AGENTS.md`, `README.md`, `docs/architecture.md`, `docs/decisions-and-assumptions.md`, `docs/enrichment-engine.md`, `docs/phase-10-report.md`, `docs/requirements-verification.md`, this report.
- **Change:** Documented the completed bonuses, distributed coordination boundary, current 217-test result, live restart evidence, dashboard evidence, findings, and limitations.
- **Reason:** The submitted explanation must match actual behavior.
- **Verification:** Prettier and final diff review pass.

No dependency, original requirement, simulator, sample CSV, or sample RTF file was changed. Migration 003 is additive except for dropping the single-active-job index and preserves all existing records.

## F. Test results

### Final passing commands

| Command                                        | Result                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`               | PASS; all 3 workspace projects, lockfile unchanged                                                                                            |
| `pnpm db:migrate`                              | PASS; applied `003_concurrent_jobs_and_global_rate_limit.sql` to the configured database                                                      |
| Fresh disposable-schema migrations             | PASS; migrations 001, 002, and 003 applied by PostgreSQL integration setup                                                                    |
| `pnpm lint`                                    | PASS; zero warnings/errors                                                                                                                    |
| `pnpm typecheck`                               | PASS; API and web                                                                                                                             |
| `pnpm format:check`                            | PASS                                                                                                                                          |
| `pnpm build`                                   | PASS; API TypeScript and Vite production build                                                                                                |
| Focused API Vitest command                     | PASS; 40 tests                                                                                                                                |
| Focused web Vitest command                     | PASS; 7 tests                                                                                                                                 |
| `pnpm test` with reachable isolated PostgreSQL | PASS; API 205 + web 12 = **217**, 0 failed, 0 skipped                                                                                         |
| `pnpm test:db`                                 | PASS; **101** real PostgreSQL tests, 0 failed                                                                                                 |
| `pnpm test:bonus`                              | PASS; two backend processes, concurrent jobs, forced owner-process restart, 59 globally limited starts, preserved successes, isolated scoring |

The first `pnpm test` attempt in this audit was not hidden: 105 non-database API tests and 11 web tests passed, while six database suites failed setup with `ECONNREFUSED 127.0.0.1:55432` and their 92 cases were skipped. Windows rejected the old isolated-cluster port. The same existing cluster was started on port 55433, the process-only test URL was updated, and the complete command then passed 208/208 with no skips.

### Integration observations

- Live simulator calls: four request starts for three stores; one returned HTTP 500, was persisted as retry-wait, and succeeded on attempt two.
- Final live job: `completed`; 3 succeeded; 0 pending, processing, retry-wait, failed, or skipped.
- Scoring: revisions 1 and 2 both committed; final dashboard tier total equaled scored total.
- Store list: a page size of 2 returned 2 records from total 3; tier-filtered total matched the initial dashboard tier count.
- The supplied 5,000-row CSV was parsed and persisted by the real PostgreSQL large-dataset test. That test completes the workflow with deterministic set-based enrichment fixtures and validates counts, scoring, and page/filter results.

### Checks not executed or only partially executed

- Docker Compose was not executed because `docker` is not installed or available on this machine. Native PostgreSQL 18 migrations and all database tests passed instead.
- A full 5,000-store run through the random-delay simulator was not executed. At five requests/second it has a long minimum runtime, with additional retries and 45–60 second delayed calls. No claim is made that it ran.
- Browser mouse/keyboard automation was not executed. The Vite root was served live, typed API contracts were exercised through HTTP, and frontend component/workflow tests passed.
- A live 5,000-store kill/restart run was not performed; the forced-restart harness used controlled 30- and 20-store jobs to assert exact request IDs, leases, timestamps, and call counts.

## G. Architecture and concurrency review

### Worker claiming

Each process runs six worker loops by default. A short advisory-lock transaction enforces the database-wide processing cap, selects the least-recently-served eligible job, locks one store with `FOR UPDATE SKIP LOCKED`, increments its attempt, and assigns a UUID lease. The transaction commits before rate waiting or network I/O.

### Rate limiting

All initial and retry attempts use a singleton PostgreSQL rate row. Short locking transactions reserve database-time starts at least 220 ms apart and persist provider cooldown; connections are released before waiting. Independent-pool tests and the two-process live harness verify no rolling second exceeds five starts.

### Retry and backoff

HTTP 429, HTTP 5xx, network failures, and logical timeouts are retryable. Full jitter is selected within `min(RETRY_CAP_MS, RETRY_BASE_MS × 2^(attempt-1))`, then persisted as a database due time. `Retry-After` may extend that delay and the global cooldown only through `MAX_UPSTREAM_COOLDOWN_MS`. Claims increment attempts exactly once, exhaustion is terminal, and retry waits hold no database connection or worker promise.

### Timeout handling

The enrichment client races the complete fetch/body-parse promise against an independent timeout. It requests abort but observes the original promise even if transport ignores abort, preventing unhandled rejection. Correctness relies on ownership fencing rather than cancellation behavior.

### Lease recovery and late-response fencing

The watchdog scans expired processing leases with the same job-before-store lock order. It schedules another retry or records exhaustion within the attempt cap. Success and failure persistence require a running job, processing row, matching lease token, and unexpired database-time lease. Metrics insert and status transition occur in one transaction. Tests change ownership and then deliver both late success and late failure; neither can overwrite the newer result or regress state.

### Systemic failure

Accepted provider-related failures update a serialized job failure streak; accepted success resets it. Sustained dependency failure or immediate integration-status errors atomically fail the job, preserve successes, mark unfinished work skipped, clear leases, and expose job/store reasons. Job status and lease fences reject later callbacks. Finite stores plus per-store attempt caps provide an additional hard bound.

### Atomic score recalculation

Scoring accepts terminal jobs only, locks the job, inserts one immutable configuration revision, calculates all succeeded stores with one `INSERT ... SELECT`, and commits configuration plus scores together. Concurrent submissions serialize on the job lock. A failed recalculation rolls back without replacing the prior current revision. Dashboard joins only the highest committed revision, preventing duplicate or mixed results.

### Remaining architecture risks

- Distributed admission coordinates processes that use the same database and compatible rate settings; an external client or separate database is outside the guarantee.
- A timed-out transport that ignores abort can consume a socket until it settles, although it cannot corrupt state.
- The systemic streak is a deliberate heuristic and may stop a recoverable long outage; it favors bounded terminal behavior.
- External requests cannot be exactly once without provider idempotency; a request killed before its result commits may repeat after its lease expires.

## H. Bonus requirements

### Multiple active enrichment jobs — PASS

Migration 003 removes the active-job uniqueness constraint. Workers claim fairly across active jobs, respect a database-wide processing cap, and reserve request starts through one PostgreSQL row. The live harness proved that two independent backend OS processes both dispatched work while their combined actual request starts stayed within the five-per-rolling-second budget.

### Full restart resumability — PASS

Durable pending/retry/processing state, persisted due times, startup discovery, lease expiry, and fencing resume work after graceful or forced restart. A live forced-kill test verified that committed successes were unchanged and never called again, while the interrupted store was reclaimed and the job completed. The transport guarantee is at least once for an uncommitted in-flight request.

## I. Final submission checklist

- [x] Backend works.
- [x] Frontend works.
- [x] PostgreSQL setup and migrations work through native PostgreSQL.
- [ ] Docker Compose startup works in this environment; Docker was unavailable.
- [x] Supplied simulator integration works.
- [x] CSV validation works.
- [x] Job processing works.
- [x] The global rate limit is respected across two independent backend processes.
- [x] Retry and lease recovery work.
- [x] Systemic failure reaches a clear bounded terminal state.
- [x] Scoring formula and boundaries work.
- [x] Rescoring makes no enrichment calls.
- [x] Dashboard reads persisted data and supports failure visibility, filtering, and pagination.
- [x] Tests run through the documented `pnpm test` command.
- [x] README matches the implementation.
- [x] Supplied 5,000-row CSV, RTF, and simulator are included.
- [ ] Referenced sample generator is included; it was absent from supplied materials.
- [x] `.env`, local database files, virtual environments, logs, dependencies, and build outputs are ignored.
- [x] No tracked secret or credential was found in the audited diff.
- [x] Original requirements and simulator files are unchanged.

## J. Final recommendation

**READY WITH DOCUMENTED LIMITATIONS**

There is no remaining mandatory or bonus application-code fix identified by this audit. Before submission, obtain the original sample generator if Sigmoid actually supplied it and exercise Docker Compose on a machine with Docker. Keep the shared-database and at-least-once external-delivery limits explicit, and do not claim a full 5,000-call simulator run.

Recommended commit message after reviewing the diff:

`feat: support concurrent enrichment jobs with global rate limiting`

`feat: support crash-safe enrichment job resumption`
