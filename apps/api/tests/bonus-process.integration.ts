import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvironmentFile } from '../src/config/load-env.js';
import { runMigrations } from '../src/db/migrate.js';

interface RequestStart {
  at: number;
  storeId: string;
}

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  output(): string;
}

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '../../..');
const apiDist = join(repositoryRoot, 'apps/api/dist/server.js');
const simulatorDirectory = join(repositoryRoot, 'enrichment_simulator');
const terminalStatuses = new Set(['completed', 'completed_with_errors', 'failed']);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitUntil(
  check: () => Promise<boolean>,
  message: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(message);
}

function startProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-200_000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  return { child, output: () => output } satisfies ManagedProcess;
}

async function stopProcess(
  process: ManagedProcess | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
) {
  if (!process || process.child.exitCode !== null) return;
  const exited = once(process.child, 'exit');
  process.child.kill(signal);
  await Promise.race([exited, new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000))]);
  if (process.child.exitCode === null) {
    const forceExited = once(process.child, 'exit');
    process.child.kill('SIGKILL');
    await Promise.race([
      forceExited,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)),
    ]);
  }
}

function pythonExecutable(): string {
  const candidates = [
    join(simulatorDirectory, '.venv/Scripts/python.exe'),
    join(simulatorDirectory, '.venv/bin/python'),
  ];
  const existing = candidates.find(existsSync);
  if (existing) return existing;
  throw new Error(
    'Simulator Python environment not found. Create enrichment_simulator/.venv before running test:bonus.',
  );
}

async function waitForHttp(url: string, process: ManagedProcess, label: string) {
  await waitUntil(
    async () => {
      if (process.child.exitCode !== null) {
        throw new Error(`${label} exited during startup: ${process.output()}`);
      }
      try {
        return (await fetch(url)).ok;
      } catch {
        return false;
      }
    },
    `${label} did not become ready`,
    30_000,
  );
}

function apiEnvironment(databaseUrl: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    API_PORT: String(port),
    LOG_LEVEL: 'info',
    ENRICHMENT_API_BASE_URL: 'http://127.0.0.1:8001',
    WORKER_CONCURRENCY: '6',
    ENRICHMENT_MAX_RPS: '5',
    MIN_DISPATCH_INTERVAL_MS: '220',
    ENRICHMENT_TIMEOUT_MS: '5000',
    MAX_ATTEMPTS: '5',
    LEASE_DURATION_MS: '10000',
    LEASE_REAPER_INTERVAL_MS: '100',
    RETRY_BASE_MS: '100',
    RETRY_CAP_MS: '500',
    SYSTEMIC_FAILURE_STREAK: '100',
    MAX_UPSTREAM_COOLDOWN_MS: '2000',
  };
}

function startApi(databaseUrl: string, port: number): ManagedProcess {
  return startProcess(process.execPath, [apiDist], {
    cwd: repositoryRoot,
    env: apiEnvironment(databaseUrl, port),
  });
}

function csv(prefix: string, count: number, firstStoreId?: string): string {
  const rows = ['store_id,store_name,address,city,state,country'];
  if (firstStoreId) rows.push(`${firstStoreId},Held Store,1 Main,City,State,Country`);
  const remaining = count - (firstStoreId ? 1 : 0);
  for (let index = 1; index <= remaining; index += 1) {
    const id = `${prefix}-${String(index).padStart(3, '0')}`;
    rows.push(`${id},Store ${id},${index} Main,City,State,Country`);
  }
  return rows.join('\n');
}

async function upload(baseUrl: string, contents: string) {
  const body = new FormData();
  body.set('file', new Blob([contents], { type: 'text/csv' }), 'stores.csv');
  const response = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', body });
  const payload = (await response.json()) as { jobId?: string; error?: unknown };
  assert(response.status === 202 && payload.jobId, `Upload failed: ${response.status}`);
  return payload.jobId;
}

async function readJob(baseUrl: string, jobId: string) {
  const response = await fetch(`${baseUrl}/api/jobs/${jobId}`);
  assert(response.ok, `Job status failed: ${response.status}`);
  return (await response.json()) as {
    status: string;
    unfinishedStores: number;
    counts: { succeeded: number; failed: number; skipped: number; processing: number };
  };
}

const scoringConfiguration = {
  footfallBar: 15_000,
  revenueBar: 150_000,
  sizeBar: 8_000,
  footfallWeight: 50,
  revenueWeight: 30,
  sizeWeight: 20,
  largeThreshold: 70,
  mediumThreshold: 40,
};

async function scoreJob(baseUrl: string, jobId: string) {
  const response = await fetch(`${baseUrl}/api/jobs/${jobId}/scoring`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scoringConfiguration),
  });
  const payload = (await response.json()) as {
    jobId?: string;
    revision?: number;
    storesScored?: number;
  };
  assert(response.status === 201, `Scoring failed for ${jobId}: ${response.status}`);
  assert(payload.jobId === jobId, `Scoring response crossed job boundaries for ${jobId}`);
  assert(payload.revision === 1, `Unexpected scoring revision for ${jobId}`);
  assert((payload.storesScored ?? 0) > 0, `No successful stores were scored for ${jobId}`);
  return payload;
}

function assertFivePerSecond(starts: RequestStart[]) {
  const ordered = [...starts].sort((left, right) => left.at - right.at);
  for (let index = 5; index < ordered.length; index += 1) {
    assert(
      ordered[index]!.at - ordered[index - 5]!.at > 1000,
      `Global rate exceeded: six starts occurred within ${
        ordered[index]!.at - ordered[index - 5]!.at
      }ms`,
    );
  }
}

async function closeServer(server: Server | undefined, controllers: Set<AbortController>) {
  if (!server) return;
  for (const controller of controllers) controller.abort();
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await Promise.race([closed, new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))]);
}

async function main() {
  loadEnvironmentFile();
  const baseConnectionString = process.env.TEST_DATABASE_URL;
  assert(baseConnectionString, 'Set TEST_DATABASE_URL to run the bonus process integration test.');
  assert(existsSync(apiDist), 'Build output is missing. Run the root test:bonus command.');

  const schema = `tierforge_bonus_${randomUUID().replaceAll('-', '')}`;
  assert(/^tierforge_bonus_[a-f0-9]{32}$/.test(schema), 'Generated schema name is invalid');
  const admin = new pg.Pool({
    connectionString: baseConnectionString,
    connectionTimeoutMillis: 3000,
  });
  const scoped = new URL(baseConnectionString);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const databaseUrl = scoped.toString();
  let database: pg.Pool | undefined;
  let simulator: ManagedProcess | undefined;
  let firstApi: ManagedProcess | undefined;
  let secondApi: ManagedProcess | undefined;
  let proxy: Server | undefined;
  const starts: RequestStart[] = [];
  const upstreamControllers = new Set<AbortController>();
  let holdRestartResponse = false;
  let releaseHeld!: () => void;
  let held = new Promise<void>((resolvePromise) => {
    releaseHeld = resolvePromise;
  });

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    database = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    await runMigrations(database);

    simulator = startProcess(
      pythonExecutable(),
      ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000'],
      { cwd: simulatorDirectory, env: process.env },
    );
    await waitForHttp('http://127.0.0.1:8000/docs', simulator, 'simulator');

    proxy = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      let storeId = 'unknown';
      try {
        storeId = String(
          (JSON.parse(body.toString()) as { store_id?: string }).store_id ?? 'unknown',
        );
      } catch {
        // The supplied endpoint receives JSON; malformed bodies remain visible as unknown.
      }
      starts.push({ at: Date.now(), storeId });
      if (holdRestartResponse && storeId === 'A-HOLD') await held;
      const controller = new AbortController();
      upstreamControllers.add(controller);
      try {
        const upstream = await fetch(`http://127.0.0.1:8000${request.url ?? '/enrich'}`, {
          method: request.method ?? 'POST',
          headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
          body,
          signal: controller.signal,
        });
        const responseBody = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
        response.end(responseBody);
      } catch {
        response.writeHead(502).end('Proxy upstream failure');
      } finally {
        upstreamControllers.delete(controller);
      }
    });
    await new Promise<void>((resolvePromise, reject) => {
      proxy!.once('error', reject);
      proxy!.listen(8001, '127.0.0.1', () => resolvePromise());
    });

    firstApi = startApi(databaseUrl, 3101);
    secondApi = startApi(databaseUrl, 3102);
    await Promise.all([
      waitForHttp('http://127.0.0.1:3101/api/health', firstApi, 'API process 1'),
      waitForHttp('http://127.0.0.1:3102/api/health', secondApi, 'API process 2'),
    ]);
    process.stdout.write('Two API processes and the supplied simulator are ready.\n');
    const [firstJob, secondJob] = await Promise.all([
      upload('http://127.0.0.1:3101', csv('MULTI-A', 12)),
      upload('http://127.0.0.1:3102', csv('MULTI-B', 12)),
    ]);
    process.stdout.write(`Concurrent jobs accepted: ${firstJob}, ${secondJob}.\n`);
    try {
      await waitUntil(
        async () => {
          const [first, second] = await Promise.all([
            readJob('http://127.0.0.1:3101', firstJob),
            readJob('http://127.0.0.1:3102', secondJob),
          ]);
          return terminalStatuses.has(first.status) && terminalStatuses.has(second.status);
        },
        'Concurrent jobs did not reach terminal states',
        60_000,
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nAPI 1:\n${firstApi.output()}\nAPI 2:\n${secondApi.output()}`,
        { cause: error },
      );
    }
    process.stdout.write('Both concurrent jobs reached terminal states.\n');
    assert(
      firstApi.output().includes('Enrichment attempt started'),
      'API process 1 dispatched no work',
    );
    assert(
      secondApi.output().includes('Enrichment attempt started'),
      'API process 2 dispatched no work',
    );
    assertFivePerSecond(starts);
    const concurrentResult = {
      jobs: 2,
      process1Dispatched: true,
      process2Dispatched: true,
      requestStarts: starts.length,
    };

    await Promise.all([stopProcess(firstApi), stopProcess(secondApi)]);
    firstApi = undefined;
    secondApi = undefined;
    await database.query(
      'TRUNCATE jobs, job_stores, store_enrichments, scoring_configs, store_scores',
    );
    await database.query(
      `UPDATE enrichment_rate_limit SET next_start_at = '-infinity',
         cooldown_until = '-infinity', updated_at = clock_timestamp()`,
    );
    starts.length = 0;

    holdRestartResponse = true;
    held = new Promise<void>((resolvePromise) => {
      releaseHeld = resolvePromise;
    });
    firstApi = startApi(databaseUrl, 3101);
    secondApi = startApi(databaseUrl, 3102);
    await Promise.all([
      waitForHttp('http://127.0.0.1:3101/api/health', firstApi, 'restart API 1'),
      waitForHttp('http://127.0.0.1:3102/api/health', secondApi, 'restart API 2'),
    ]);
    const restartJob = await upload('http://127.0.0.1:3101', csv('RESTART', 30, 'A-HOLD'));
    const companionJob = await upload('http://127.0.0.1:3102', csv('COMPANION', 20));
    await waitUntil(async () => {
      const [restart, companion] = await Promise.all([
        readJob('http://127.0.0.1:3101', restartJob),
        readJob('http://127.0.0.1:3102', companionJob),
      ]);
      return (
        restart.counts.succeeded >= 3 &&
        restart.counts.processing > 0 &&
        companion.counts.succeeded > 0 &&
        (firstApi!.output().includes('A-HOLD') || secondApi!.output().includes('A-HOLD'))
      );
    }, 'Restart fixture did not reach a mixed succeeded/processing state');
    const successfulBefore = await database.query<{
      storeId: string;
      attemptCount: number;
      footfall: string;
      revenue: string;
      size: string;
      enrichedAt: Date;
    }>(
      `SELECT s.store_id AS "storeId", s.attempt_count AS "attemptCount",
         e.estimated_monthly_footfall AS footfall,
         e.estimated_monthly_revenue AS revenue,
         e.store_size_sqft AS size, e.enriched_at AS "enrichedAt"
       FROM job_stores s JOIN store_enrichments e USING (job_id, store_id)
       WHERE s.job_id = $1 AND s.status = 'succeeded' ORDER BY s.store_id`,
      [restartJob],
    );
    assert(successfulBefore.rows.length >= 3, 'No committed successes captured before termination');
    const callsBefore = new Map<string, number>();
    for (const start of starts)
      callsBefore.set(start.storeId, (callsBefore.get(start.storeId) ?? 0) + 1);
    assert(
      starts.some((start) => start.storeId === 'A-HOLD'),
      'Held in-flight request was not dispatched',
    );

    const firstOwnedHeldRequest = firstApi!.output().includes('A-HOLD');
    const killedPort = firstOwnedHeldRequest ? 3101 : 3102;
    const survivorPort = firstOwnedHeldRequest ? 3102 : 3101;
    const killedApi = firstOwnedHeldRequest ? firstApi! : secondApi!;
    await stopProcess(killedApi, 'SIGKILL');
    if (firstOwnedHeldRequest) firstApi = undefined;
    else secondApi = undefined;
    holdRestartResponse = false;
    releaseHeld();

    const replacementApi = startApi(databaseUrl, killedPort);
    if (firstOwnedHeldRequest) firstApi = replacementApi;
    else secondApi = replacementApi;
    process.stdout.write(
      `Backend on port ${killedPort} was forcibly terminated while port ${survivorPort} remained active, then started again.\n`,
    );
    await waitForHttp(`http://127.0.0.1:${killedPort}/api/health`, replacementApi, 'restarted API');
    let finalJob: Awaited<ReturnType<typeof readJob>> | undefined;
    let finalCompanion: Awaited<ReturnType<typeof readJob>> | undefined;
    await waitUntil(
      async () => {
        [finalJob, finalCompanion] = await Promise.all([
          readJob(`http://127.0.0.1:${survivorPort}`, restartJob),
          readJob(`http://127.0.0.1:${killedPort}`, companionJob),
        ]);
        return terminalStatuses.has(finalJob.status) && terminalStatuses.has(finalCompanion.status);
      },
      'Restarted and companion jobs did not reach terminal states',
      180_000,
    );
    assert(finalJob?.unfinishedStores === 0, 'Restarted job retained unfinished stores');
    assert(finalCompanion?.unfinishedStores === 0, 'Companion job retained unfinished stores');

    const successfulAfter = await database.query(
      `SELECT s.store_id AS "storeId", s.attempt_count AS "attemptCount",
         e.estimated_monthly_footfall AS footfall,
         e.estimated_monthly_revenue AS revenue,
         e.store_size_sqft AS size, e.enriched_at AS "enrichedAt"
       FROM job_stores s JOIN store_enrichments e USING (job_id, store_id)
       WHERE s.job_id = $1 AND s.store_id = ANY($2) ORDER BY s.store_id`,
      [restartJob, successfulBefore.rows.map((row) => row.storeId)],
    );
    assert(
      JSON.stringify(successfulAfter.rows) === JSON.stringify(successfulBefore.rows),
      'A pre-crash successful enrichment changed after restart',
    );
    for (const row of successfulBefore.rows) {
      const afterCalls = starts.filter((start) => start.storeId === row.storeId).length;
      assert(
        afterCalls === (callsBefore.get(row.storeId) ?? 0),
        `Committed store ${row.storeId} was called again after restart`,
      );
    }
    const heldAfter = await database.query<{ attemptCount: number; status: string }>(
      `SELECT attempt_count AS "attemptCount", status FROM job_stores
       WHERE job_id = $1 AND store_id = 'A-HOLD'`,
      [restartJob],
    );
    assert((heldAfter.rows[0]?.attemptCount ?? 0) >= 2, 'In-flight work was not reclaimed');
    assertFivePerSecond(starts);
    const [restartScoring, companionScoring] = await Promise.all([
      scoreJob(`http://127.0.0.1:${killedPort}`, restartJob),
      scoreJob(`http://127.0.0.1:${survivorPort}`, companionJob),
    ]);
    const scoringRows = await database.query<{ jobId: string; revisions: number }>(
      `SELECT job_id AS "jobId", count(DISTINCT revision)::integer AS revisions
       FROM scoring_configs WHERE job_id = ANY($1) GROUP BY job_id ORDER BY job_id`,
      [[restartJob, companionJob]],
    );
    assert(scoringRows.rows.length === 2, 'Scoring configurations were not isolated by job');
    assert(
      scoringRows.rows.every((row) => row.revisions === 1),
      'Unexpected cross-job scoring revision state',
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          concurrentProcesses: concurrentResult,
          restart: {
            preCrashSuccessesPreserved: successfulBefore.rows.length,
            heldStoreAttempts: heldAfter.rows[0]?.attemptCount,
            finalStatus: finalJob?.status,
            finalCounts: finalJob?.counts,
            companionStatus: finalCompanion?.status,
            survivorPort,
            restartedPort: killedPort,
          },
          scoring: {
            restartJobStores: restartScoring.storesScored,
            companionJobStores: companionScoring.storesScored,
            isolatedConfigurations: scoringRows.rows.length,
          },
          globalRate: { requestStarts: starts.length, rollingLimit: 5 },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    releaseHeld?.();
    await Promise.all([stopProcess(firstApi), stopProcess(secondApi)]);
    await closeServer(proxy, upstreamControllers);
    await stopProcess(simulator, 'SIGKILL');
    await database?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
