# Decisions and assumptions — Phase 0

These record implementation choices, not original assignment requirements. Phases 1–3 implement the foundation, queued CSV ingestion, and basic enrichment engine; [current schema](database-schema.md), [CSV policy](csv-ingestion.md), [enrichment policy](enrichment-engine.md), and verification reports record evidence. Remaining resilience/scoring/UI policies are proposals. Sources are the [assignment](requirements/tierforge-requirements.md), [supplied simulator README](../enrichment_simulator/README.md), and the user's phase briefs.

## Authority and repository placement

**D01 — Repository root and requirements path.** The Git root is `sigmoid-tierforge/`, one level below the opened workspace. Existing guidance was named `AGENTS.MD`; Phase 0 normalizes it to `AGENTS.md`, preserving its source-of-truth, phase-reporting, and no-automatic-commit instructions. The assignment was found at `enrichment_simulator/docs/requirements/tierforge-requirements.md`, while the brief and guidance referenced root `docs/requirements/tierforge-requirements.md`. Copy it byte-for-byte to the expected path; retain the original nested file and supplied assets. Root copy is the implementation reference; never diverge or edit either copy to redefine scope.

**D02 — Fixed implementation stack.** The assignment allows alternatives, but the user explicitly selected React/TypeScript/Vite, Tailwind, TanStack Query, Node/TypeScript/Express, PostgreSQL/pg, Zod, Vitest/Supertest, pnpm workspaces, and Compose for PostgreSQL. Follow those choices. No ORM, queue broker, or other infrastructure is needed. Select supported compatible package versions during Phase 1; none are installed or pinned in Phase 0.

## Worker and resilience defaults

**D03 — Process topology and concurrency.** One Node process hosts API and background workers, with `WORKER_CONCURRENCY=6` logical loops and one limiter shared by every attempt. The monotonic limiter spaces starts by 220 ms, so concurrency does not redefine the five-request/second ceiling. Development reload must not leave duplicate worker processes; the guarantee is process-wide, matching the core single-process design.

**D04 — Rate admission.** `ENRICHMENT_MAX_RPS=5` (validate at most five; lowering is allowed), `MIN_DISPATCH_INTERVAL_MS=210` at the default ceiling, plus a trailing-window admission check and no burst accumulation. Derive a larger interval when lowering max RPS. Admission occurs immediately before each HTTP dispatch, including retries; reevaluate after scheduler pauses. Use monotonic elapsed time. The core guarantee covers this application's one process. Other simulator clients can consume quota; handle 429 without assuming the local limiter controls them.

**D05 — Timeout.** `ENRICHMENT_TIMEOUT_MS=8000`, from dispatch until the entire response is consumed. It is shorter than the documented 45–60-second delay, forcing the required recovery path. Race the complete transport promise against an independent deadline, request abort as resource cleanup, and keep a rejection observer on the abandoned promise. Fencing remains authoritative if the underlying transport ignores cancellation.

**D06 — Maximum attempts.** `MAX_ATTEMPTS=5`, counting the initial claim and four possible retries. The counter increments on claim. No client-library automatic retries exist outside this budget; the fifth retryable failure persists `RETRY_EXHAUSTED` with its last typed cause.

**D07 — Leases and reaping.** `LEASE_DURATION_MS=20000`; each claim receives a new UUID token and no heartbeat. The lease exceeds the 8-second HTTP deadline plus limiter/DB margin. Phase 4 timeout handling invalidates its owned lease and schedules a retry. `LEASE_REAPER_INTERVAL_MS=1000` remains reserved configuration for the next phase's general expired-processing reaper; Phase 4 does not claim crash/watchdog recovery.

**D08 — Backoff.** `RETRY_BASE_MS=1000`, `RETRY_CAP_MS=30000`, full jitter over `[0, min(cap, base * 2^(attempt-1))]`; the jittered value itself never exceeds the cap. Persist the selected database-time due timestamp and use the shared limiter when due. A valid 429 or transient-5xx `Retry-After` is a lower bound for both that row and a process-wide cooldown, even when longer than the normal backoff cap. `MAX_UPSTREAM_COOLDOWN_MS` remains reserved for the next phase's systemic-failure policy.

**D09 — Systemic-failure cutoff.** `SYSTEMIC_FAILURE_STREAK=30` consecutive accepted dependency-failure outcomes (429, 5xx, network, timeout, expired lease, malformed response), reset by success, serialized through the job lock. Store-local permanent errors do not reset or increment it. Immediate stop on 401/403/404/405 because these indicate broken integration/configuration. Mark unfinished rows terminal and invalidate leases on stop. Small jobs may finish through per-store exhaustion before reaching 30. Intermittent successes can postpone the heuristic, but a finite input and six-claim cap still bound all work; no infinite retries. This may abort a recoverable outage, deliberately favoring a clear bounded outcome over a complex circuit breaker.

**D10 — Restart semantics.** The planned lease reaper will cover stuck attempts while the process remains alive. A later startup policy should mark an abandoned running job failed with `SERVER_RESTARTED`, close unfinished work, invalidate leases, and preserve completed results. Phase 4 does not implement or claim this watchdog behavior. Full restart continuation remains assignment Bonus 2.

**D11 — Transaction strategy.** All mutations lock job before work rows. Atomic `FOR UPDATE SKIP LOCKED` claims, fence-checked completion, reaping, systemic stop, and scoring publication use short transactions. Serializing job mutations is intentionally conservative at five requests/second and avoids complicated counters/publication races. HTTP, backoff, and limiter waits must remain outside transactions. Derive aggregate progress from rows, so discarded callbacks cannot double-count. Persist immutable job settings to explain a run even if environment defaults later change.

## Input, scoring, and UI choices

**D12 — Duplicate store IDs and upload validation.** Trim surrounding field whitespace; preserve case. Reject duplicate IDs within one file, report offending row numbers, and reject the entire upload. IDs may recur in different jobs. Reject blank required fields, duplicate headers, inconsistent row widths, invalid quoting, and zero data rows. Headers are case-sensitive after trimming/BOM handling; required header order is free. Extra columns are ignored with an explicit warning. These go beyond mandatory basic header validation to avoid ambiguous work identity and invalid requests.

**D13 — Upload limits.** `CSV_MAX_BYTES=10485760` (10 MiB), `CSV_MAX_ROWS=10000`, error-detail cap 100 entries. These admit the supplied 5,000-row file and bound memory/transaction size. Parse under limits before committing a job; do not silently drop rows or split one upload into jobs. Stream input accounting even if validated bounded rows are retained for batch insertion. A maintained CSV parser is a justified future dependency; manual comma splitting is not.

**D14 — Decimal precision and tier validation.** Store raw metrics and calculation values as PostgreSQL numeric. Accept config decimals as strings with up to two fractional digits; bars nonnegative, weights each 0–100 summing exactly to 100; `0 <= mediumMin < largeMin <= 100`. The precision and strictly ordered boundaries are implementation policies. No formula changes: each `metric >= bar` contributes exactly its weight; test Large before Medium using inclusive comparisons. The assignment's example is a useful initial form suggestion, not a mandatory default config. No scores exist until the user submits a config.

**D15 — Scoring revision strategy.** Allocate immutable per-job integer revisions under the job lock. Publish the new config pointer and all successful-store scores in one set-based transaction; preserve prior revision on failure. New enrichment successes are scored with the current revision in their completion transaction through the scoring module's same SQL formula. Prior revisions remain historical snapshots, while the current one stays complete. No queue or network call in recalculation. Repeated identical submissions may create distinct revisions in core; idempotency/deduplication and history-management UI are not required.

**D16 — Performance guardrails.** Target a sub-two-second 5,000-store recalculation on the documented development machine, with `SCORING_STATEMENT_TIMEOUT_MS=5000` and bounded lock wait. This is an unverified project target, not an assignment SLA. Short bulk SQL operations avoid one-query-per-store recalculation. A failed/timeout transaction leaves the previous scores visible. If measurement exceeds the target, inspect query plans/indexes before adding infrastructure.

**D17 — Dashboard semantics.** Poll active progress every 2 seconds; pause when the tab is hidden; invalidate after scoring and stop polling terminal jobs. Paginate stores at 50/default, 100/max. Pending includes queued, processing, and retry waiting. Null score/tier means unscored, never Small. Pin list queries to the published scoring revision to avoid mixing old scores with new tier counts. Failure details remain available separately from tier-filtered successful rows. Accessibility and clear states take priority over animations.

**D18 — Job outcome vocabulary.** `completed` means every store succeeded; `completed_with_errors` means normal exhaustion/permanent failures left some successes and some failures; `failed` means no successes at normal completion, systemic abort, or interrupted process. Terminal jobs have no nonterminal work. A failed job can retain partial successful results and allow scoring them. No manual retry/reopen/cancel UI is necessary for core; another upload creates a new job.

**D19 — Retention and API shape.** Keep raw payloads separate from typed accepted metrics and calculated scores; preserve attempt history and config revisions for explanation. API paths, pagination, safe structured errors, current/latest job discovery, and transactionally consistent response snapshots are application choices. No global store master, upload idempotency keys, export facility, deletion UI, or retention scheduler in core. Score history grows with reruns; document this local-use trade-off.

## Confirmed simulator documentation

The README is available and was read in full. The following are **documented**, not runtime-verified in Phase 0:

- Run from `enrichment_simulator/` with `pip install -r requirements.txt`, then `uvicorn main:app --port 8000`.
- `POST /enrich` request example contains `store_id`, `store_name`, `address`, `city`, and `state`.
- Successful `200` example contains matching `store_id` and the three named metrics; metrics are deterministic per store ID.
- Global quota is five requests/second across all callers of that simulator process; excess calls receive 429.
- About 10% of rate-admitted calls return 500; about 2% are delayed 45–60 seconds before successful response.
- `GET /health` returns `{"status":"ok"}` and is not rate-limited.
- It runs locally with no account, internet dependency for enrichment, or API key. Initial package installation may of course need package access.
- Do not modify the service; no inspection of its implementation is required to special-case its behavior.

## Unresolved integration details and missing assets

The README supplies example payloads but does not fully specify all validation/error/transport behavior. Keep these uncertainties visible; verify only what integration needs against the unchanged supplied service in Phase 3.

1. **Country field:** CSV requires `country`; the API request example omits it. Preserve country locally and send exactly the five documented fields by default. Acceptance of an extra country field is unverified; do not assume it is required upstream.
2. **Validation contract:** required-vs-optional fields, nullability, field length restrictions, strict numeric ranges/types, unknown-field behavior, validation response status/body, and content-type errors are not fully stated. Use boundary validation and handle unexpected non-429 4xx explicitly; do not invent an error schema.
3. **429 details:** `Retry-After` presence/format, response body, and exact quota-window algorithm/boundaries are undocumented. Design independent conservative request admission and generic header handling; verify with a modest integration smoke test.
4. **Error and latency details:** 500 body, non-delayed latency distribution, connection behavior after client abort, and whether a delayed request continues after disconnect are unverified. A late-result test must not rely solely on abort cancelling the server.
5. **Transport/base URL:** README command uses local port 8000. Phase 3 uses configurable `ENRICHMENT_API_BASE_URL=http://127.0.0.1:8000` for host-run Node. Container-to-host naming and any future proxy configuration need explicit setup verification. The browser calls Express, not the simulator, so upstream CORS is irrelevant to the intended flow.
6. **Sample generator:** `stores_5000.csv` and `tierforge-use-case.rtf` are present; the separately mentioned generator script was not found in the supplied repository. Preserve available assets; request the original if needed for final submission, and disclose its absence if unavailable. Do not author a substitute and label it Sigmoid-provided.
7. **Runtime compatibility:** No simulator, database, Node application, dependencies, or test suite was started in Phase 0. Documented behavior is not execution evidence. Package versions and exact future startup/test scripts remain Phase 1/5 work.

These gaps do not block the requested planning deliverables. They must be checked or explicitly disclosed before claiming complete integration.

## Phase 1 amendments

The latest user request selects composite store keys and the five domain tables in [database-schema.md](database-schema.md), including queued/running active jobs and skipped stores. Only schema support is implemented. Configuration is named `ENRICHMENT_API_BASE_URL` as requested in Phase 1. React Router is included. Native PostgreSQL 18 was available for verification; Docker was not available. All original assignment and simulator files remain unchanged.

## Phase 2 amendments

Phase 2 implements D12 and D13 through `csv-parse` and Multer. All six assignment columns are required and nonblank because each maps to a nonnullable persisted field and later enrichment input. Extra columns are ignored with an explicit warning; their header positions still count when validating row width. Files are UTF-8, at most 10 MiB and 10,000 records by default, with 65,536 characters per CSV record and at most 100 returned validation details. The entire bounded file is validated before database work, then inserted in 500-row batches within one transaction. The database partial unique index remains authoritative for simultaneous active-job submissions.

## Phase 3 amendments

Phase 3 implements the documented five-field simulator request, validated successful responses, a six-loop worker pool, a shared 220 ms monotonic limiter, job-before-store locking, `SKIP LOCKED` claims, UUID leases, and fenced atomic success persistence. Upload notification uses `setImmediate`, so the `202` response never waits for enrichment. At startup the coordinator detects one queued or running job, but full restart recovery is not claimed. To avoid crashes or infinite loops before retry design is authorized, HTTP, transport, timeout, and contract errors become terminal per-store failures with safe codes; retry wait, lease reaping, backoff, and systemic failure are deferred.

## Phase 4 amendments

Phase 4 replaces the temporary terminal-error behavior with typed bounded retries. Retryable categories are rate limiting, provider 5xx, network errors, and logical timeouts; invalid successful payloads and other HTTP errors are permanent. Full-jitter delays and safe failure details persist in `job_stores`. The coordinator derives the next wake delay from PostgreSQL time and owns one timer rather than sleeping worker loops. Every retry uses a new token and the same process-wide limiter. Late promises remain observed but cannot invoke persistence after timeout; repository fencing independently rejects old-token success or failure writes.
