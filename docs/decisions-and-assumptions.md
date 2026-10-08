# Decisions and assumptions — Phase 0

These are proposed implementation choices, not original assignment requirements or evidence of working software. Sources are the [assignment](requirements/tierforge-requirements.md), [supplied simulator README](../enrichment_simulator/README.md), and the user's Phase 0 brief. The assignment's exact score formula, five-request/second global limit, required resilience, and core/bonus boundary are not configurable product reinterpretations.

## Authority and repository placement

**D01 — Repository root and requirements path.** The Git root is `sigmoid-tierforge/`, one level below the opened workspace. Existing guidance was named `AGENTS.MD`; Phase 0 normalizes it to `AGENTS.md`, preserving its source-of-truth, phase-reporting, and no-automatic-commit instructions. The assignment was found at `enrichment_simulator/docs/requirements/tierforge-requirements.md`, while the brief and guidance referenced root `docs/requirements/tierforge-requirements.md`. Copy it byte-for-byte to the expected path; retain the original nested file and supplied assets. Root copy is the implementation reference; never diverge or edit either copy to redefine scope.

**D02 — Fixed implementation stack.** The assignment allows alternatives, but the user explicitly selected React/TypeScript/Vite, Tailwind, TanStack Query, Node/TypeScript/Express, PostgreSQL/pg, Zod, Vitest/Supertest, pnpm workspaces, and Compose for PostgreSQL. Follow those choices. No ORM, queue broker, or other infrastructure is needed. Select supported compatible package versions during Phase 1; none are installed or pinned in Phase 0.

## Worker and resilience defaults

**D03 — Process topology and concurrency.** One Node process hosts API and background worker, with `WORKER_CONCURRENCY=5` logical request slots and one limiter shared by every attempt. This permits useful overlap without tying concurrency to the much larger store count. Increasing slots is possible after latency measurements, but never raises the five-request/second ceiling. Development reload must not leave duplicate worker processes. Five slots may underutilize the request budget when latency is high; correctness takes priority over peak throughput.

**D04 — Rate admission.** `ENRICHMENT_MAX_RPS=5` (validate at most five; lowering is allowed), `MIN_DISPATCH_INTERVAL_MS=210` at the default ceiling, plus a trailing-window admission check and no burst accumulation. Derive a larger interval when lowering max RPS. Admission occurs immediately before each HTTP dispatch, including retries; reevaluate after scheduler pauses. Use monotonic elapsed time. The core guarantee covers this application's one process. Other simulator clients can consume quota; handle 429 without assuming the local limiter controls them.

**D05 — Timeout.** `ENRICHMENT_TIMEOUT_MS=10000`, from dispatch until the entire response is consumed. It is shorter than the documented 45–60-second delay, forcing the required recovery path. Use abort plus a settled logical timeout; fencing remains authoritative if the underlying transport ignores cancellation. Ordinary latency percentiles are not documented, so tune only after measuring the unmodified simulator.

**D06 — Maximum attempts.** `MAX_ATTEMPTS=6`, counting the initial claim and five possible retries. The counter increments on claim, even if dispatch never happens, to bound silent-worker failures. No client-library automatic retries outside this budget. Six attempts balance transient-failure tolerance against slow outage loops; independent-error probability estimates must not be treated as a guarantee of eventual success.

**D07 — Leases and reaping.** `LEASE_DURATION_MS=20000`, `LEASE_REAPER_INTERVAL_MS=1000`; new UUID token per claim, no heartbeats. The lease exceeds the HTTP deadline and short limiter/DB overhead; validate `lease > timeout` with an explicit safety margin in startup settings. Admission waiting and heavy scoring can consume that margin, so recheck leases before dispatch and result writes. Reaper operates independently of individual attempt promises, marks lost attempts, and permits another task to claim a fresh token. It cannot repair a completely frozen Node event loop without process intervention.

**D08 — Backoff.** `RETRY_BASE_MS=1000`, `RETRY_CAP_MS=30000`, full jitter over `[0, min(cap, base * 2^(attempt-1))]`. Persist retry due times and use the shared limiter when due. For valid 429 `Retry-After`, use it as a lower bound and a process-wide cooldown; fall back for absent/malformed headers. `MAX_UPSTREAM_COOLDOWN_MS=120000`: a larger requested delay terminates the job with a clear reason instead of violating the requested delay or waiting indefinitely. This early termination is a conservative policy, not a simulator promise.

**D09 — Systemic-failure cutoff.** `SYSTEMIC_FAILURE_STREAK=30` consecutive accepted dependency-failure outcomes (429, 5xx, network, timeout, expired lease, malformed response), reset by success, serialized through the job lock. Store-local permanent errors do not reset or increment it. Immediate stop on 401/403/404/405 because these indicate broken integration/configuration. Mark unfinished rows terminal and invalidate leases on stop. Small jobs may finish through per-store exhaustion before reaching 30. Intermittent successes can postpone the heuristic, but a finite input and six-claim cap still bound all work; no infinite retries. This may abort a recoverable outage, deliberately favoring a clear bounded outcome over a complex circuit breaker.

**D10 — Restart semantics.** Core lease reclamation covers stuck attempts while the scheduler/reaper remains alive. On server startup, mark abandoned running jobs failed with `SERVER_RESTARTED`, close/fail unfinished work, invalidate leases, and preserve completed results. Do not claim automatic resume. Support a fresh sequential upload afterward. Full restart continuation is assignment Bonus 2 and receives no core implementation budget.

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
5. **Transport/base URL:** README command suggests local port 8000. Propose configurable `ENRICHMENT_BASE_URL=http://127.0.0.1:8000` for host-run Node. Container-to-host naming and any future proxy configuration need explicit setup verification. The browser calls Express, not the simulator, so upstream CORS is irrelevant to the intended flow.
6. **Sample generator:** `stores_5000.csv` and `tierforge-use-case.rtf` are present; the separately mentioned generator script was not found in the supplied repository. Preserve available assets; request the original if needed for final submission, and disclose its absence if unavailable. Do not author a substitute and label it Sigmoid-provided.
7. **Runtime compatibility:** No simulator, database, Node application, dependencies, or test suite was started in Phase 0. Documented behavior is not execution evidence. Package versions and exact future startup/test scripts remain Phase 1/5 work.

These gaps do not block the requested planning deliverables. They must be checked or explicitly disclosed before claiming complete integration.
