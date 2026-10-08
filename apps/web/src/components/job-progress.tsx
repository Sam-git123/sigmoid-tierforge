import type { JobProgress } from '../api/tierforge';
import { formatDate } from '../utils/format';

const labels: Record<JobProgress['status'], string> = {
  queued: 'Queued',
  running: 'Enrichment in progress',
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  failed: 'Failed',
};

export function JobStatus({ status }: { status: JobProgress['status'] }) {
  const tone =
    status === 'completed'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'completed_with_errors'
        ? 'bg-amber-100 text-amber-800'
        : status === 'failed'
          ? 'bg-rose-100 text-rose-800'
          : 'bg-cyan-100 text-cyan-800';
  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${tone}`}>
      {labels[status]}
    </span>
  );
}

export function ProgressBar({ value }: { value: number }) {
  const bounded = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-medium text-slate-700">Overall progress</span>
        <span className="font-bold text-slate-950">{bounded.toFixed(1)}%</span>
      </div>
      <div
        className="h-3 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={bounded}
        aria-label="Enrichment progress"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-[width] duration-500"
          style={{ width: `${bounded}%` }}
        />
      </div>
    </div>
  );
}

function Count({
  label,
  value,
  tone = 'text-slate-950',
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone}`}>{value.toLocaleString()}</p>
    </div>
  );
}

export function JobProgressPanel({ job }: { job: JobProgress }) {
  const waiting = job.counts.pending + job.counts.processing + job.counts.retryWait;
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"
      aria-label="Job progress"
    >
      <div className="flex flex-col justify-between gap-3 border-b border-slate-100 pb-5 sm:flex-row sm:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold text-slate-950">Enrichment job</h2>
            <JobStatus status={job.status} />
          </div>
          <p className="mt-1 font-mono text-xs text-slate-500">{job.jobId}</p>
        </div>
        <div className="text-sm text-slate-500">
          <p>Started: {formatDate(job.startedAt)}</p>
          {job.finishedAt && <p>Finished: {formatDate(job.finishedAt)}</p>}
        </div>
      </div>

      <div className="py-6">
        <ProgressBar value={job.progressPercentage} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Count label="Total stores" value={job.totalStores} />
        <Count label="Successfully enriched" value={job.counts.succeeded} tone="text-emerald-700" />
        <Count label="Permanently failed" value={job.counts.failed} tone="text-rose-700" />
        <Count label="Still pending" value={waiting} tone="text-cyan-700" />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Count label="Pending" value={job.counts.pending} />
        <Count label="Processing" value={job.counts.processing} />
        <Count label="Waiting for retry" value={job.counts.retryWait} />
      </div>

      {job.counts.skipped > 0 && (
        <p className="mt-4 text-sm text-slate-600">
          Skipped after job termination: <strong>{job.counts.skipped.toLocaleString()}</strong>
        </p>
      )}
      {job.failureReason && (
        <div
          role="alert"
          className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          <p className="font-semibold">{job.failureCode ?? 'Job failure'}</p>
          <p className="mt-1">{job.failureReason}</p>
        </div>
      )}
    </section>
  );
}
