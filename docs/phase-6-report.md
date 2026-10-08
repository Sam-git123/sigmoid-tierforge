# Phase 6 handoff and verification

Date: 8 October 2026 (Asia/Calcutta). Scope: configurable scoring and tiering for terminal jobs, exact decimal validation, immutable revisions, set-based PostgreSQL calculation, atomic recalculation, and current-configuration APIs. No frontend dashboard, commit, or push was created.

## Delivered

- `POST /api/jobs/:jobId/scoring` validates and publishes a new immutable scoring revision for a terminal job.
- `GET /api/jobs/:jobId/scoring` returns the highest committed configuration, revision, scored-store count, and Large/Medium/Small counts. Before the first submission it returns a null configuration and zero counts.
- Inputs may be JSON numbers or decimal strings. Bars, weights, and thresholds support at most two decimal places and are normalized to two-place strings.
- Weight totals are checked as integer hundredths, avoiding direct floating-point equality. Each weight and threshold is between 0 and 100, bars are nonnegative, and Large must be greater than Medium.
- The exact assignment formula is implemented with inclusive metric bars and inclusive tier thresholds. No normalization, percentile, ranking, or cross-store comparison exists.
- Scoring is available only for `completed`, `completed_with_errors`, and `failed` jobs. Only persisted enrichment rows whose work state is `succeeded` are scored.
- Each submission locks the job row, allocates `max(revision) + 1`, inserts the configuration, and calculates all scores with one `INSERT ... SELECT` statement using SQL `CASE` expressions.
- Recalculation makes no enrichment request and imports no enrichment client. Historical configuration and score revisions remain stored.

## Atomicity

The scoring repository owns one PostgreSQL transaction. It locks the job before reading the current maximum revision, inserts the next configuration, and upserts that revision's scores before commit. Concurrent submissions serialize on the job lock and receive distinct revisions. A statement or constraint failure rolls back both configuration and scores, leaving the previous highest committed revision current. A GET statement therefore observes either the complete earlier revision or the complete new revision.

## Example revision change

Revision 1 uses bars `15000 / 150000 / 8000`, weights `50 / 30 / 20`, and thresholds `70 / 40`. The Sigmoid examples produce A `100/Large`, B `50/Medium`, and C `20/Small`, giving counts `1/1/1`.

Revision 2 raises the bars to `30000 / 300000 / 16000` with the same weights and thresholds. A remains `100/Large`; B and C become `0/Small`, giving counts `1/0/2`. Revision 1 remains queryable in the database while revision 2 becomes current.

## Files added

- `apps/api/src/controllers/scoring-controller.ts`
- `apps/api/src/domain/scoring.ts`
- `apps/api/src/repositories/scoring-repository.ts`
- `apps/api/src/routes/scoring-routes.ts`
- `apps/api/src/schemas/scoring-schema.ts`
- `apps/api/src/services/scoring.service.ts`
- `apps/api/tests/scoring.test.ts`
- `apps/api/tests/scoring.database.test.ts`
- `docs/phase-6-report.md`

## Files modified

- `AGENTS.md`
- `README.md`
- `apps/api/package.json`
- `apps/api/src/app.ts`
- `apps/api/src/server.ts`
- `docs/architecture.md`
- `docs/database-schema.md`
- `docs/decisions-and-assumptions.md`
- `docs/implementation-plan.md`

No database migration was needed because `scoring_configs` and revisioned `store_scores` already support the required transaction. The enrichment worker/client and supplied simulator were not modified.

## Verification

- API TypeScript check passed.
- Scoring formula and validation tests passed: **9 tests in 1 file**.
- PostgreSQL scoring/API tests passed: **5 tests in 1 file**.
- Database coverage includes exact A/B/C results, failed-store exclusion, zero upstream calls, recalculation, historical revisions, forced rollback, terminal-state gating, invalid input, and concurrent revision allocation.
- Per the requested lean workflow, the full test, lint, build, frontend, and 5,000-row timing suites were not run.

## Remaining limitations

- Scoring is API-only until the Phase 7 dashboard.
- The current revision is the highest committed revision rather than a separate pointer column; this is atomic because configuration and scores share one transaction.
- Historical revisions are retained without deletion or pagination policy.
- A full 5,000-row scoring timing measurement remains for final integration.
