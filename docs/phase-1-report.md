# Phase 1 handoff and verification

Date: 8 October 2026 (Asia/Calcutta). Scope: project foundation and database schema only. No commits, staging, pushes, deployment, or later-phase functionality.

## Delivered

- pnpm workspace with apps/web and apps/api, strict TypeScript, supported ESLint 10, Prettier, LF source conventions, lockfile, and root development/build/test/migration commands.
- React/Vite/Tailwind shell with React Router, TanStack Query provider, placeholder TierForge page, and configurable frontend fetch client.
- Express application factory separate from startup, request IDs, structured Pino logging, safe standardized error responses, Zod environment/request validation, health route/controller/service/repository, pg pool, and transaction helper.
- Five requested domain tables and migration ledger, active-job uniqueness across queued/running, composite store/config FKs, exact NUMERIC values, valid-state/lease/retry checks, and queue/lease/status/tier indexes.
- Forward-only transactional migrations, advisory-lock serialization, applied-file checksums, and isolated real-PostgreSQL tests.
- PostgreSQL Compose configuration, ignored root .env, documented environment defaults, and a README covering startup/test commands and limitations.

User's Phase 1 schema takes precedence over the earlier proposal. Current schema details: [database-schema.md](database-schema.md). Phase 0 guidance was updated to authorize Phase 1 only. The original requirements, simulator, sample CSV, and original RTF were not edited.

## Actual verification results

Environment: Windows PowerShell, Node 24.18.1, pnpm 12.10.1, installed native PostgreSQL 18. pnpm was installed globally for this task; its executable directory needed adding to the current shell PATH.

- `pnpm install`: passed; all three workspace projects installed. `pnpm install --frozen-lockfile`: passed after final dependency updates.
- `pnpm typecheck`: passed for both apps.
- `pnpm lint`: passed, zero warnings, using ESLint 10.
- `pnpm format:check`: passed.
- `pnpm build`: passed for API compilation and Vite production build.
- `pnpm db:migrate`: applied 001_foundation.sql successfully to native PostgreSQL. Second invocation reported no pending migrations.
- `pnpm test` with TEST_DATABASE_URL configured: **60 passed, zero failed, zero skipped**, across five test files. API: 56 passed (34 real database tests, 22 other foundation tests). Web API client: four passed.
- `pnpm test:db`: **34 passed**, including schema constraints, a concurrent active-job insertion race, rollback, migration idempotency, migration DDL rollback, and checksum tampering rejection.
- Initial tests without TEST_DATABASE_URL reported 26 passes and 34 explicit skips; this was followed by the full real-database run above, not reported as complete database verification.
- `pnpm dev`: frontend started at 127.0.0.1:5173 and backend at 127.0.0.1:3001.
- HTTP smoke checks: frontend document 200/title TierForge; transformed React module 200; generated Tailwind utility present; API health 200 with {"status":"ok","database":"up"} and request ID; Vite-proxied health also 200.
- `git diff --check`: passed. Git ignore checks confirmed .env and .local database files are ignored. Requirements copies retained the original identical SHA-256: 628AA66D3C38906A6E925002BC7B3C73909CA0A4A5BCA3091861AAA3DE83DF36.
- Fixed issues found during verification: Express request-ID declaration resolution and Windows shell quoting in the root development script.

**Not verified:** Docker Compose runtime/startup. No Docker executable/service was available. The YAML is present and formatting-valid, but native PostgreSQL success is not proof of container startup. Browser rendering was not automated; frontend checks covered startup, HTTP/module/CSS delivery, and production compilation.

Temporary frontend/backend processes and the native verification database were stopped after checks. The ignored .local cluster and .env remain available for restarting; no application records were populated (test fixtures lived in isolated schemas that were removed).

## Start commands

Run from the repository root. Detailed instructions and the native Windows fallback are in [README.md](../README.md).

For a fresh checkout with Docker:

```powershell
Copy-Item .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm dev
```

Preserve an existing .env instead of copying over it. Start independently with `pnpm dev:web` and `pnpm dev:api`. Standard database command: `docker compose up -d --wait postgres`.

For this existing workspace without Docker:

```powershell
$env:PATH = "$env:APPDATA\npm;$env:PATH"
& 'C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe' -D "$PWD\.local\postgres-phase1" -l "$PWD\.local\postgres-phase1.log" -o '-h 127.0.0.1 -p 55432' -w start
pnpm db:migrate
pnpm dev
```

The current ignored .env points to that cluster on port 55432 and enables database tests. Run `pnpm test` after starting it. Stop the native cluster with `pg_ctl.exe -D "$PWD\.local\postgres-phase1" -m fast -w stop` using the full executable path above. Do not run native PostgreSQL and Compose on the same configured port at once.

## Scope and remaining gaps

Phase 1 implements persistence structures only. There are no upload/job endpoints, enrichment calls, claim/retry/reaper workers, scoring formula/execution, or dashboard screens. Worker settings are validated reserved configuration. Deferred schema extensions and revision-publication semantics are recorded in the schema document rather than silently implemented.

The missing supplied generator and simulator contract uncertainties remain as documented in Phase 0. Docker runtime acceptance remains pending an environment with Docker. No later phase is authorized by this handoff.

## Final source directory structure

Generated node_modules, dist, .git, .local, and secret/local .env files are excluded. Source files and supplied assets:

```text
sigmoid-tierforge/
├── apps/
│   ├── api/
│   │   ├── migrations/
│   │   │   └── 001_foundation.sql
│   │   ├── src/
│   │   │   ├── config/
│   │   │   │   ├── env.ts
│   │   │   │   └── load-env.ts
│   │   │   ├── controllers/
│   │   │   │   └── health-controller.ts
│   │   │   ├── db/
│   │   │   │   ├── migrate-cli.ts
│   │   │   │   ├── migrate.ts
│   │   │   │   ├── pool.ts
│   │   │   │   └── transaction.ts
│   │   │   ├── errors/
│   │   │   │   └── api-error.ts
│   │   │   ├── logging/
│   │   │   │   └── logger.ts
│   │   │   ├── middleware/
│   │   │   │   ├── error-handler.ts
│   │   │   │   ├── request-context.ts
│   │   │   │   └── validate-request.ts
│   │   │   ├── repositories/
│   │   │   │   └── health-repository.ts
│   │   │   ├── routes/
│   │   │   │   └── health-routes.ts
│   │   │   ├── services/
│   │   │   │   └── health-service.ts
│   │   │   ├── types/
│   │   │   │   └── express.d.ts
│   │   │   ├── workers/
│   │   │   │   └── README.md
│   │   │   ├── app.ts
│   │   │   └── server.ts
│   │   ├── tests/
│   │   │   ├── database.test.ts
│   │   │   ├── env.test.ts
│   │   │   ├── health.test.ts
│   │   │   ├── require-test-database.ts
│   │   │   └── validation.test.ts
│   │   ├── package.json
│   │   ├── tsconfig.build.json
│   │   ├── tsconfig.json
│   │   └── vitest.config.ts
│   └── web/
│       ├── src/
│       │   ├── api/
│       │   │   └── client.ts
│       │   ├── App.tsx
│       │   ├── main.tsx
│       │   └── styles.css
│       ├── tests/
│       │   └── client.test.ts
│       ├── index.html
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       └── vitest.config.ts
├── docs/
│   ├── requirements/
│   │   └── tierforge-requirements.md
│   ├── architecture.md
│   ├── database-schema.md
│   ├── decisions-and-assumptions.md
│   ├── implementation-plan.md
│   └── phase-1-report.md
├── enrichment_simulator/
│   ├── docs/
│   │   └── requirements/
│   │       └── tierforge-requirements.md
│   ├── main.py
│   ├── README.md
│   └── requirements.txt
├── .editorconfig
├── .env.example
├── .gitattributes
├── .gitignore
├── .prettierignore
├── .prettierrc.json
├── AGENTS.md
├── docker-compose.yml
├── eslint.config.mjs
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── README.md
├── stores_5000.csv
├── tierforge-use-case.rtf
└── tsconfig.base.json
```

## Created files (54)

- `.editorconfig`
- `.env.example`
- `.gitattributes`
- `.gitignore`
- `.prettierignore`
- `.prettierrc.json`
- `README.md`
- `apps/api/migrations/001_foundation.sql`
- `apps/api/package.json`
- `apps/api/src/app.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/config/load-env.ts`
- `apps/api/src/controllers/health-controller.ts`
- `apps/api/src/db/migrate-cli.ts`
- `apps/api/src/db/migrate.ts`
- `apps/api/src/db/pool.ts`
- `apps/api/src/db/transaction.ts`
- `apps/api/src/errors/api-error.ts`
- `apps/api/src/logging/logger.ts`
- `apps/api/src/middleware/error-handler.ts`
- `apps/api/src/middleware/request-context.ts`
- `apps/api/src/middleware/validate-request.ts`
- `apps/api/src/repositories/health-repository.ts`
- `apps/api/src/routes/health-routes.ts`
- `apps/api/src/server.ts`
- `apps/api/src/services/health-service.ts`
- `apps/api/src/types/express.d.ts`
- `apps/api/src/workers/README.md`
- `apps/api/tests/database.test.ts`
- `apps/api/tests/env.test.ts`
- `apps/api/tests/health.test.ts`
- `apps/api/tests/require-test-database.ts`
- `apps/api/tests/validation.test.ts`
- `apps/api/tsconfig.build.json`
- `apps/api/tsconfig.json`
- `apps/api/vitest.config.ts`
- `apps/web/index.html`
- `apps/web/package.json`
- `apps/web/src/App.tsx`
- `apps/web/src/api/client.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/styles.css`
- `apps/web/tests/client.test.ts`
- `apps/web/tsconfig.json`
- `apps/web/vite.config.ts`
- `apps/web/vitest.config.ts`
- `docker-compose.yml`
- `docs/database-schema.md`
- `docs/phase-1-report.md`
- `eslint.config.mjs`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `tsconfig.base.json`

Local-only artifacts: ignored root .env, .local/postgres-phase1 cluster and log, dependency directories, and build output. No local credentials are included in this report.

## Modified files (4)

- `AGENTS.md`
- `docs/architecture.md`
- `docs/decisions-and-assumptions.md`
- `docs/implementation-plan.md`

Optional commit message suggestion: `feat: establish TierForge workspace and PostgreSQL foundation`. No commit was created.
