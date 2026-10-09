# TierForge requirement verification

This final checklist uses the requirement IDs established in `implementation-plan.md`. “Verified” means the behavior has automated evidence or direct inspection from the Phase 9 reliability audit, Phase 10 submission review, and final production-readiness audit. Current command results and limitations are in `final-requirement-audit.md`.

## Context, evaluation, and stack

### R01 — Process a large store list through enrichment and configurable scoring

- **Status:** Implemented and verified.
- **Source:** `apps/api/src/services/job-service.ts`, `apps/api/src/workers/`, `apps/api/src/services/scoring.service.ts`, `apps/api/src/services/dashboard-service.ts`, and `apps/web/src/`.
- **Tests:** `large-dataset.database.test.ts`, `enrichment.database.test.ts`, `scoring.database.test.ts`, and `workflow.test.tsx`.
- **Limitation:** The 5,000-row test uses set-based deterministic enrichment fixtures; 5,000 simulator HTTP calls were not run.

### R02 — Keep core scope appropriate for the assignment

- **Status:** Implemented; verified by repository and requirement inspection.
- **Source:** `AGENTS.md`, `docs/architecture.md`, and the complete application source.
- **Tests:** The complete 208-test suite verifies the delivered core; scope itself is inspection evidence.
- **Limitation:** Historical development duration cannot be reconstructed from the repository.

### R03 — Integrate the provided simulator without replacing it

- **Status:** Implemented and live-verified.
- **Source:** `apps/api/src/clients/enrichment-client.ts`, `apps/api/src/config/env.ts`, and unchanged `enrichment_simulator/main.py`.
- **Tests:** `enrichment-client.test.ts`, `enrichment.database.test.ts`, plus the Phase 9 live smoke run.
- **Limitation:** The live run used three stores.

## Upload

### R04 — Upload a store CSV

- **Status:** Implemented and verified.
- **Source:** `csv-upload.ts`, `csv-service.ts`, `job-controller.ts`, `job-service.ts`, and `file-upload.tsx`.
- **Tests:** `csv.test.ts`, `job-service.test.ts`, `jobs.database.test.ts`, and `workflow.test.tsx`.
- **Limitation:** Uploads are intentionally bounded to the configured in-memory size and row limits.

### R05 — Validate all required headers

- **Status:** Implemented and verified.
- **Source:** `apps/api/src/services/csv-service.ts` and `docs/csv-ingestion.md`.
- **Tests:** `csv.test.ts`, `job-service.test.ts`, and the invalid-CSV live smoke request.
- **Limitation:** Headers are case-sensitive after trimming by documented policy; extra columns are accepted and ignored with a warning.

### R06 — Use the provided sample assets

- **Status:** Partially implemented and inspected; not fully verified.
- **Source:** `stores_5000.csv`, `tierforge-use-case.rtf`, and the unchanged `enrichment_simulator/` directory.
- **Tests:** `large-dataset.database.test.ts` reads the supplied 5,000-row CSV.
- **Limitation:** The CSV generator referenced by the brief was absent from the supplied assets.

## Enrichment

### R07 — Enrich every accepted store through `POST /enrich`

- **Status:** Implemented and verified.
- **Source:** `enrichment-client.ts`, `coordinator.ts`, `worker.ts`, and `enrichment-repository.ts`.
- **Tests:** `enrichment-client.test.ts`, `worker.test.ts`, and `enrichment.database.test.ts`.
- **Limitation:** Core operation is intentionally one active job and one API process.

### R08 — Persist the three enrichment metrics

- **Status:** Implemented and verified.
- **Source:** `enrichment-client.ts`, `enrichment-repository.ts`, and migration `001_foundation.sql`.
- **Tests:** `enrichment-client.test.ts`, `enrichment.database.test.ts`, and `database.test.ts`.
- **Limitation:** Raw upstream response payloads and attempt-history rows are not separately retained.

### R09 — Track work states, progress, and failure reasons

- **Status:** Implemented and verified.
- **Source:** `enrichment-repository.ts`, `job-repository.ts`, `dashboard-repository.ts`, and the job/failure controllers.
- **Tests:** `enrichment.database.test.ts`, `jobs.database.test.ts`, and `dashboard.database.test.ts`.
- **Limitation:** Progress is queried from persisted work rows rather than cached counters, appropriate for 5,000 stores.

## Scoring

### R10 — Configure one bar and 0–100% weight per metric, totaling 100%

- **Status:** Implemented and verified.
- **Source:** `scoring-schema.ts`, `scoring.service.ts`, `scoring-repository.ts`, and `scoring-form.tsx`.
- **Tests:** `scoring.test.ts`, `scoring.database.test.ts`, and `workflow.test.tsx`.
- **Limitation:** Inputs are limited to two decimal places by policy.

### R11 — Apply inclusive Large and Medium thresholds

- **Status:** Implemented and verified.
- **Source:** `scoring.service.ts` and `scoring-repository.ts`.
- **Tests:** `scoring.test.ts` explicitly verifies exact 40 → Medium and 70 → Large; database tests verify persisted tiers.
- **Limitation:** None identified.

### R12 — Sum weights for metrics meeting their bars

- **Status:** Implemented and verified.
- **Source:** `scoring.service.ts` and the set-based SQL in `scoring-repository.ts`.
- **Tests:** `scoring.test.ts` covers bar equality, 0, 100, and exact decimal arithmetic.
- **Limitation:** None identified.

### R13 — Reproduce the three worked examples

- **Status:** Implemented and verified.
- **Source:** `scoring.service.ts` and `scoring-repository.ts`.
- **Tests:** `scoring.test.ts` and `scoring.database.test.ts` use the assignment’s A/B/C values and 50/30/20 weights.
- **Limitation:** None identified.

### R14 — Score stored successes and rescore without enrichment

- **Status:** Implemented and verified.
- **Source:** `scoring.service.ts` and `scoring-repository.ts`; neither depends on the enrichment client.
- **Tests:** `scoring.database.test.ts` verifies partial success, repeated revisions, rollback, concurrency, and an unchanged enrichment-call count.
- **Limitation:** Historical scoring revisions are retained without a cleanup policy.

## Dashboard

### R15 — Show enriched, failed, and pending counts with reasons

- **Status:** Implemented and verified.
- **Source:** `job-repository.ts`, `dashboard-repository.ts`, `dashboard-page.tsx`, `job-progress.tsx`, and `failure-table.tsx`.
- **Tests:** `jobs.database.test.ts`, `dashboard.database.test.ts`, and `workflow.test.tsx`.
- **Limitation:** The UI reports persisted counts and does not estimate completion time.

### R16 — Show Large, Medium, and Small counts

- **Status:** Implemented and verified.
- **Source:** `dashboard-repository.ts`, `dashboard-service.ts`, and `dashboard.tsx`.
- **Tests:** `dashboard.database.test.ts`, `scoring.database.test.ts`, and `large-dataset.database.test.ts`.
- **Limitation:** Unscored stores are intentionally excluded from every tier.

### R17 — Show store identity, metrics, score, and tier

- **Status:** Implemented and verified.
- **Source:** `dashboard-repository.ts`, `dashboard-controller.ts`, and `dashboard.tsx`.
- **Tests:** `dashboard.database.test.ts`, `client.test.ts`, and `workflow.test.tsx`.
- **Limitation:** Missing enrichment and score fields display as null/empty rather than invented zeros.

### R18 — Filter stores by tier

- **Status:** Implemented and verified.
- **Source:** `dashboard-schema.ts`, `dashboard-repository.ts`, and `dashboard.tsx`.
- **Tests:** `dashboard.database.test.ts`, `large-dataset.database.test.ts`, and `workflow.test.tsx`.
- **Limitation:** The allowed filter values are exactly Large, Medium, and Small.

## Supplied service and data

### R19 — Include the supplied CSV and generator

- **Status:** Partially implemented and inspected; not fully verified.
- **Source:** `stores_5000.csv` and supplied documentation assets.
- **Tests:** `large-dataset.database.test.ts` verifies the CSV contains and ingests exactly 5,000 records.
- **Limitation:** No generator file was present in the supplied materials.

### R20 — Run the unchanged simulator locally

- **Status:** Implemented and live-verified.
- **Source:** `enrichment_simulator/main.py`, its README, `enrichment-client.ts`, and `.env.example`.
- **Tests:** Phase 9 ran the simulator on port 8000 with the live API; `enrichment-client.test.ts` covers its contract deterministically.
- **Limitation:** Python is provided by the simulator’s local virtual environment rather than a project-managed runtime.

### R21 — Respect five requests/second and handle 429

- **Status:** Implemented and verified.
- **Source:** `rate-limiter.ts`, `worker.ts`, `coordinator.ts`, and `enrichment-client.ts`.
- **Tests:** `rate-limiter.test.ts`, `worker.test.ts`, and `enrichment-client.test.ts` cover 20 simultaneous callers, shared retry admission, and `Retry-After` cooldown changes while waiting.
- **Limitation:** The limiter is process-wide; multiple API processes would require a distributed limiter.

### R22 — Retry transient HTTP 500 failures with a bound

- **Status:** Implemented and verified.
- **Source:** `enrichment-client.ts`, `retry-policy.ts`, `worker.ts`, and persisted repository transitions.
- **Tests:** `enrichment-client.test.ts`, `retry-policy.test.ts`, `worker.test.ts`, `enrichment.database.test.ts`, and the live smoke run.
- **Limitation:** At most five attempts are made; exhausted rows fail as designed.

### R23 — Handle delayed responses without stale corruption

- **Status:** Implemented and verified.
- **Source:** timeout handling in `enrichment-client.ts` and token/lease fences in `enrichment-repository.ts`.
- **Tests:** `enrichment-client.test.ts` covers ignored abort; `enrichment.database.test.ts` covers late success and late failure after retry success.
- **Limitation:** A timed-out upstream call may continue consuming resources until it settles, but its stale result cannot write.

### R24 — Recognize deterministic metrics while relying on fencing

- **Status:** Implemented and verified by inspection and controlled integration evidence.
- **Source:** unchanged `enrichment_simulator/main.py` and fencing in `enrichment-repository.ts`.
- **Tests:** Late-response database tests deliberately use different old/new metrics so an overwrite would be visible.
- **Limitation:** Phase 9 did not separately call the live simulator twice with the same successful store ID.

## Required scope and resilience

### R25 — Complete Steps 1–4 for one job at a time

- **Status:** Implemented and live-verified.
- **Source:** complete API and React workflow; active-job uniqueness in migration `001_foundation.sql`.
- **Tests:** `jobs.database.test.ts`, `workflow.test.tsx`, and the Phase 9 live upload → enrich → score → dashboard → rescore smoke flow.
- **Limitation:** The live smoke interacted through HTTP and verified the served frontend root; browser clicks were not repeated with automation.

### R26 — Retry transient failures with a cap

- **Status:** Implemented and verified.
- **Source:** `enrichment-client.ts`, `retry-policy.ts`, `worker.ts`, and `enrichment-repository.ts`.
- **Tests:** Client/worker/retry-policy tests cover 500, 429, network error, timeout, permanent error, exponential full jitter, and maximum attempts; database tests verify persisted due times.
- **Limitation:** Retry policy is configured per process/job defaults rather than editable through the UI.

### R27 — Recover unresponsive work and reject late callbacks

- **Status:** Implemented and verified.
- **Source:** lease claim/recovery methods in `enrichment-repository.ts`, coordinator watchdog code, and the post-limiter `isClaimCurrent` check in `worker.ts`.
- **Tests:** `enrichment.database.test.ts` covers lease expiry, watchdog reclaim, retry success, exhausted lease attempts, and stale callbacks; `worker.test.ts` covers expiry during rate admission.
- **Limitation:** An ownership change immediately after the pre-dispatch check can cause an unnecessary upstream call; final database fencing still prevents corruption.

### R28 — Terminate systemic provider failure clearly

- **Status:** Implemented and verified.
- **Source:** failure-streak and settlement transactions in `enrichment-repository.ts` and coordinator lifecycle code.
- **Tests:** `enrichment.database.test.ts` covers bounded systemic termination, settlement of unfinished rows, preservation of successes, late-result fencing, and exposed reasons.
- **Limitation:** The threshold is process configuration, not a user-facing setting.

## Submission requirements

### R29 — Include backend and frontend source

- **Status:** Implemented and inspected.
- **Source:** `apps/api/`, `apps/web/`, root workspace configuration, and lockfile.
- **Tests:** `pnpm build`, `pnpm typecheck`, and the full suite passed.
- **Limitation:** No commit or archive was created because the user explicitly prohibited committing.

### R30 — Document setup and run instructions

- **Status:** Implemented and inspected.
- **Source:** `README.md`, `.env.example`, and workspace scripts in `package.json`.
- **Tests:** Commands were exercised during Phase 9; migrations and services started successfully.
- **Limitation:** Docker was unavailable in this environment, so the live run used local PostgreSQL.

### R31 — Explain how to run the simulator with the app

- **Status:** Implemented and live-verified.
- **Source:** `README.md`, `enrichment_simulator/README.md`, and `.env.example`.
- **Tests:** Phase 9 ran the simulator, API, and frontend concurrently.
- **Limitation:** Users without Python must install it or use the existing project virtual environment.

### R32 — Explain architecture choices

- **Status:** Implemented and inspected.
- **Source:** `README.md`, `docs/architecture.md`, `docs/database-schema.md`, and `docs/enrichment-engine.md`.
- **Tests:** Architecture invariants are exercised by the database, worker, scoring, and dashboard suites.
- **Limitation:** Documentation describes a single-process deployment by design.

### R33 — State limitations and shortcuts

- **Status:** Implemented and inspected.
- **Source:** `README.md`, this checklist, and `phase-9-report.md`.
- **Tests:** Not applicable; limitations are checked against the code and executed evidence.
- **Limitation:** The reported limitations remain open by definition.

### R34 — Preserve all supplied sample files

- **Status:** Partially implemented and inspected; not fully verified.
- **Source:** `stores_5000.csv`, `tierforge-use-case.rtf`, and `enrichment_simulator/`.
- **Tests:** The CSV is parsed by `large-dataset.database.test.ts`; the simulator was run unchanged.
- **Limitation:** The referenced generator was not among the supplied files.

### R35 — Run tests with one documented command

- **Status:** Implemented and verified.
- **Source:** root and workspace `package.json` scripts plus the database-test instructions in `README.md`.
- **Tests:** `pnpm test` completed with 208 passing tests, no failures, and no skips in the final audit.
- **Limitation:** `TEST_DATABASE_URL` must point to a disposable PostgreSQL database or an account allowed to create isolated schemas.

## Bonus scope

- **B01 — Multiple active jobs:** Not implemented. The mandatory one-active-job database constraint remains intentional.
- **B02 — Full live process-restart demonstration:** Partially verified through persisted retry/lease/startup-recovery integration tests; Phase 9 did not kill and relaunch the complete live stack mid-job.
