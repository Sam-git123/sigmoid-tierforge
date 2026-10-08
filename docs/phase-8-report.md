# Phase 8 verification report

## Scope delivered

Phase 8 completes the React frontend against the real TierForge backend. Production application paths contain no mock data.

- A responsive application shell presents the four-step workflow: Upload Stores, Enrichment Progress, Configure Scoring, and Dashboard.
- CSV upload supports file selection and drag/drop, selected-file feedback, required-column guidance, basic UTF-8 header checks, multipart submission, backend validation errors, and active-job conflict recovery.
- Progress polls `GET /api/jobs/:jobId` about every two seconds only while queued/running. It shows all persisted work-state counts, the backend percentage, terminal reason, scoring eligibility, and paginated failed/skipped details.
- Scoring uses the assignment example as its initial configuration, loads persisted values when present, validates bars/weights/thresholds, shows the live weight total, submits exact values, invalidates related query caches, and supports later recalculation.
- Dashboard cards, tier distribution, configuration summary, and store results use Phase 7 APIs. Tier changes and page changes issue server-side requests. Null values render as unscored/missing rather than zero.
- API payloads are typed and runtime-validated with Zod. Structured backend errors, validation details, network errors, missing jobs, partial failures, no-success jobs, and missing configurations have explicit states.

## Frontend routes

- `/` — CSV upload.
- `/jobs/:jobId/progress` — active polling, terminal outcome, and failure inspection.
- `/jobs/:jobId/scoring` — initial configuration or recalculation.
- `/jobs/:jobId/dashboard` — analytics summary and paginated store results.

## Files

Created:

- `apps/web/src/api/query-keys.ts`
- `apps/web/src/api/tierforge.ts`
- `apps/web/src/components/app-shell.tsx`
- `apps/web/src/components/dashboard.tsx`
- `apps/web/src/components/failure-table.tsx`
- `apps/web/src/components/file-upload.tsx`
- `apps/web/src/components/job-progress.tsx`
- `apps/web/src/components/pagination.tsx`
- `apps/web/src/components/scoring-form.tsx`
- `apps/web/src/pages/dashboard-page.tsx`
- `apps/web/src/pages/progress-page.tsx`
- `apps/web/src/pages/scoring-page.tsx`
- `apps/web/src/pages/upload-page.tsx`
- `apps/web/src/utils/csv.ts`
- `apps/web/src/utils/format.ts`
- `apps/web/src/utils/job.ts`
- `apps/web/src/utils/scoring.ts`
- `apps/web/tests/workflow.test.tsx`
- `docs/phase-8-report.md`

Modified for Phase 8:

- `apps/web/src/App.tsx`
- `apps/web/src/api/client.ts`
- `apps/web/src/styles.css`
- `apps/web/vitest.config.ts`
- `apps/web/package.json`
- `pnpm-lock.yaml`
- `apps/api/src/services/scoring.service.ts` (lint-only unused-variable cleanup)
- `apps/api/tests/database.test.ts` (migration fixture updated to include the existing second migration)
- `AGENTS.md`
- `README.md`
- `docs/architecture.md`
- `docs/decisions-and-assumptions.md`
- `docs/implementation-plan.md`

## Commands and results

- `pnpm lint`: passed with zero warnings.
- `pnpm typecheck`: passed for API and web.
- `pnpm test` with the ignored local `TEST_DATABASE_URL`: passed, API 188/188 and web 10/10 (198 total).
- `pnpm build`: passed for API and web; Vite produced the production bundle.
- `pnpm format:check`: passed.

The first complete test run exposed a stale foundation migration fixture that copied only migration 001 while the database correctly recorded migrations 001 and 002. The fixture now copies both real migrations before adding its deliberately broken migration; the focused rollback test and complete suite pass.

## Run locally

From the repository root, after configuring `.env`:

```powershell
pnpm db:up
pnpm db:migrate
pnpm dev
```

This starts the React app at `http://127.0.0.1:5173` and the API at `http://127.0.0.1:3001`. Run the supplied simulator separately from `enrichment_simulator/` before uploading:

```powershell
python -m pip install -r requirements.txt
python -m uvicorn main:app --port 8000
```

## Known limitations

- The deliberately unreliable simulator was not used for a full live 5,000-store browser walkthrough in this verification pass; deterministic API/database and isolated frontend suites passed.
- Port 5173 was already occupied during an attempted manual preview, so no existing user process was stopped. Production bundling and server-rendered component tests completed successfully, but the available browser automation surface failed to initialize for screenshot-based visual inspection.
- The frontend formats large numeric values using the browser locale but does not assume a currency code because the backend does not provide one.
