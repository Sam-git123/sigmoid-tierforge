# Phase 9 verification report

## Scope

Phase 9 audited the completed TierForge application against the original Sigmoid brief, added missing reliability coverage, corrected two worker concurrency issues, and verified the integrated application. It did not add product functionality outside the assignment.

The per-requirement result is in [`requirements-verification.md`](requirements-verification.md).

## Correctness fixes

1. **Rate-limit cooldown recheck.** A queued caller previously calculated its delay once. If another request received `Retry-After` while that caller slept, the caller could start before the extended cooldown ended. The limiter now rechecks its schedule after each sleep. A deterministic test moves the cooldown while a request is waiting.
2. **Lease validation after rate-limit admission.** A worker could claim a row, wait long enough for the lease to expire, and still send the upstream request. The worker now checks that the job is running and its claim token is current and unexpired immediately after limiter admission. Persisted fencing still protects the final write if ownership changes after that check.

## Added verification

- A late failed response after the retry has already succeeded cannot change terminal state, overwrite metrics, or create a second enrichment row.
- A late successful response leaves the completed job unchanged and creates only one enrichment row.
- Rescoring the same job twice does not call the enrichment API again.
- Scores exactly 40 and 70 classify as Medium and Large respectively.
- The supplied 5,000-row CSV is ingested into PostgreSQL, enriched with set-based deterministic test fixtures, completed, scored, summarized, tier-filtered, and paginated without duplicates.
- Twenty competing requests and retry traffic remain inside the shared five-starts-per-rolling-second limit.

## Live end-to-end smoke test

The live smoke test used:

- PostgreSQL on `127.0.0.1:55432` with an isolated `tierforge_phase9_smoke` schema
- the supplied FastAPI enrichment simulator on port `8000`
- the Express API on port `3001`
- the Vite frontend on port `5173`

It verified that the frontend root was served, an invalid CSV returned `422 MISSING_CSV_HEADER`, and a valid three-store CSV returned `202`. The simulator produced one transient HTTP 500; the worker retried it and the job completed with three successes and no failures. The test then scored the job, read dashboard/store/failure endpoints, changed the scoring configuration, and rescored without enrichment.

Observed final response values:

```json
{
  "status": "completed",
  "counts": {
    "pending": 0,
    "processing": 0,
    "retryWait": 0,
    "succeeded": 3,
    "failed": 0,
    "skipped": 0
  },
  "failures": 0,
  "revision": 2,
  "scoredStores": 3,
  "tierCounts": {
    "large": 0,
    "medium": 1,
    "small": 2
  },
  "elapsedMs": 1791
}
```

The smoke schema was dropped and all three application processes were stopped afterward.

## Commands

PowerShell setup for commands in this report:

```powershell
$env:PATH = "$env:APPDATA\npm;$env:PATH"
```

Run the complete automated suite:

```powershell
# TEST_DATABASE_URL must identify a disposable PostgreSQL database or isolated schema.
pnpm test
```

Run the static and build checks:

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm format:check
```

Run only the focused Phase 9 reliability tests:

```powershell
pnpm --filter @tierforge/api exec vitest run tests/rate-limiter.test.ts tests/worker.test.ts tests/scoring.test.ts
pnpm --filter @tierforge/api exec vitest run tests/enrichment.database.test.ts tests/scoring.database.test.ts tests/large-dataset.database.test.ts
```

## Automated results

- Focused deterministic tests: **20 passed, 0 failed** across 3 files.
- Focused PostgreSQL tests: **25 passed, 0 failed** across 3 files; combined duration 6.93 seconds.
- Full `pnpm test`: **204 passed, 0 failed** across 18 files — API **194** tests in 16 files (6.37 seconds), web **10** tests in 2 files (4.87 seconds).
- `pnpm lint`: passed after correcting one `prefer-const` finding in a new test.
- `pnpm typecheck`: passed for API and web.
- `pnpm build`: passed; the API compiled and Vite built 250 frontend modules.
- `pnpm format:check`: passed.
- The corrected rate-limiter test was rerun separately: **3 passed, 0 failed**.

## 5,000-store evidence

The large-data database test reads the supplied `stores_5000.csv`, creates exactly 5,000 pending work rows, inserts deterministic enrichment results in a set-based fixture transaction, settles the job, computes exactly 5,000 scores, validates dashboard totals and tier totals, and reads a filtered second page with stable ordering and no duplicate stores. Scoring and filtered pagination each have a five-second regression guard. Both passed during the focused PostgreSQL run.

This is representative database and application processing evidence, not a claim that 5,000 real HTTP calls were made to the simulator. A full simulator run would take at least about 1,000 seconds at the mandatory five starts per second, before retries, so it was intentionally not repeated in this phase.

## Known limitations

- The repository does not contain the CSV generator referenced by the original brief; the supplied 5,000-row CSV itself is present and verified.
- The live Phase 9 flow used three stores. The 5,000-store verification used the real parser, repositories, PostgreSQL, scoring, dashboard, and pagination, with deterministic set-based enrichment fixtures.
- The limiter is shared within one API process. Multiple independent API processes would need a distributed limiter; multi-process deployment is outside the single-job assignment scope.
- Persisted schedules and recovery behavior are integration-tested, but Phase 9 did not terminate and relaunch the entire live process stack midway through a job.
- A lease can change in the narrow interval after the pre-dispatch ownership check. Database fencing prevents stale responses from mutating state, although that upstream call may still occur.
- PostgreSQL prerequisites are required for `pnpm test`. Docker was unavailable in this environment, so verification used the existing local PostgreSQL installation and an isolated test cluster/schema.
