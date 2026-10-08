# Phase 7 verification report

## Scope delivered

Phase 7 adds database-backed read APIs only. No React dashboard, enrichment behavior, scoring formula, or schema migration changed.

- `GET /api/jobs/:jobId` retains its persisted six-state progress counts and lifecycle/failure fields.
- `GET /api/jobs/:jobId/stores` returns stable `store_id` pages, optional SQL tier filtering, nullable enrichment/score data, and current error fields.
- `GET /api/jobs/:jobId/failures` returns paginated failed and skipped work with distinguishable final states and reasons.
- `GET /api/jobs/:jobId/dashboard` returns the job summary, succeeded/failed/skipped/scored totals, current-revision tier totals, and current scoring configuration.
- Query validation defaults to page 1/page size 50, caps page size at 100, accepts only `Large`, `Medium`, or `Small`, validates UUIDs, and uses the standard error envelope.

Store list counts and records run in one repeatable-read transaction. Tier predicates execute in PostgreSQL, not after pagination. Score joins use only the highest committed configuration revision, preventing historical scoring rows from duplicating stores or changing current totals. The existing `(job_id, store_id)`, `(job_id, status, store_id)`, and `(job_id, config_revision, tier, store_id)` indexes support stable pages, failure selection, and tier filters for the 5,000-store target.

## Example responses

`GET /api/jobs/JOB_ID/stores?page=1&pageSize=2&tier=Large`:

```json
{
  "records": [
    {
      "storeId": "A",
      "storeName": "Store A",
      "address": "A Main Street",
      "city": "City",
      "state": "State",
      "country": "Country",
      "status": "succeeded",
      "estimatedMonthlyFootfall": "40000.00",
      "estimatedMonthlyRevenue": "400000.00",
      "storeSizeSqft": "18000.00",
      "score": "100.00",
      "tier": "Large",
      "lastErrorCode": null,
      "lastErrorMessage": null
    }
  ],
  "page": 1,
  "pageSize": 2,
  "totalRecords": 1,
  "totalPages": 1
}
```

`GET /api/jobs/JOB_ID/failures?page=1&pageSize=50`:

```json
{
  "records": [
    {
      "storeId": "F",
      "storeName": "Store F",
      "attemptCount": 5,
      "lastErrorCode": "MAX_ATTEMPTS",
      "lastErrorMessage": "Provider remained unavailable.",
      "finalStatus": "failed"
    }
  ],
  "page": 1,
  "pageSize": 50,
  "totalRecords": 1,
  "totalPages": 1
}
```

`GET /api/jobs/JOB_ID/dashboard` includes this summary shape:

```json
{
  "successfullyEnrichedStores": 3,
  "failedStores": 1,
  "skippedStores": 1,
  "scoredStores": 3,
  "tierCounts": { "large": 1, "medium": 1, "small": 1 },
  "currentScoringRevision": 1,
  "currentScoringConfiguration": {
    "footfallBar": "15000.00",
    "revenueBar": "150000.00",
    "sizeBar": "8000.00",
    "footfallWeight": "50.00",
    "revenueWeight": "30.00",
    "sizeWeight": "20.00",
    "largeThreshold": "70.00",
    "mediumThreshold": "40.00"
  }
}
```

The real response also includes `job` with identity, lifecycle timestamps, failure fields, and all six state counts.

## Files

Created:

- `apps/api/src/controllers/dashboard-controller.ts`
- `apps/api/src/domain/dashboard.ts`
- `apps/api/src/repositories/dashboard-repository.ts`
- `apps/api/src/routes/dashboard-routes.ts`
- `apps/api/src/schemas/dashboard-schema.ts`
- `apps/api/src/services/dashboard-service.ts`
- `apps/api/tests/dashboard.database.test.ts`
- `docs/phase-7-report.md`

Modified:

- `AGENTS.md`
- `README.md`
- `apps/api/package.json`
- `apps/api/src/app.ts`
- `apps/api/src/server.ts`
- `docs/architecture.md`
- `docs/decisions-and-assumptions.md`
- `docs/implementation-plan.md`

## Verification

- `pnpm --filter @tierforge/api typecheck`: passed.
- `pnpm --filter @tierforge/api exec vitest run tests/dashboard.database.test.ts` with the ignored local `TEST_DATABASE_URL`: 1 file passed, 4 tests passed, 0 failed, 0 skipped.
- `git diff --check`: passed.

The focused PostgreSQL suite covers empty filtered/failure results, missing jobs, invalid UUID/tier/page/page size, pagination boundaries, unscored and unenriched nulls, partial failures, failure reasons, current tier filters, dashboard counts, rescoring, and absence of duplicate rows across historical revisions.

## Deferred by scope

The React dashboard and a full 5,000-row end-to-end simulator walkthrough remain for a later phase. The read queries are designed for the stated 5,000-store job and use the existing supporting indexes, but no separate 5,000-row query timing benchmark was run in this lean verification pass.
