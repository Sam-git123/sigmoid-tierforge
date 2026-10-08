import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { queryKeys } from '../api/query-keys';
import { tierForgeApi } from '../api/tierforge';
import { ErrorNotice, LoadingPanel, PageHeading } from '../components/app-shell';
import { FailureTable } from '../components/failure-table';
import { JobProgressPanel } from '../components/job-progress';
import { errorMessage } from '../utils/format';
import { isTerminalStatus } from '../utils/job';

export function ProgressPage() {
  const { jobId = '' } = useParams();
  const location = useLocation();
  const [failurePage, setFailurePage] = useState(1);
  const job = useQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: () => tierForgeApi.getJob(jobId),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && !isTerminalStatus(status) ? 2_000 : false;
    },
  });
  const terminal = job.data ? isTerminalStatus(job.data.status) : false;
  const hasFailures = Boolean(job.data && job.data.counts.failed + job.data.counts.skipped > 0);
  const failures = useQuery({
    queryKey: queryKeys.failures(jobId, failurePage),
    queryFn: () => tierForgeApi.getFailures(jobId, failurePage, 20),
    enabled: terminal && hasFailures,
  });
  const warnings = (location.state as { warnings?: { message: string }[] } | null)?.warnings;

  return (
    <>
      <PageHeading
        eyebrow="Step 2 of 4"
        title="Enrichment progress"
        description="Follow persisted job states as TierForge enriches each store. Updates arrive without reloading the page."
        action={
          job.data && (
            <Link
              to="/"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Upload another file
            </Link>
          )
        }
      />
      {warnings?.length ? (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {warnings.map((warning) => warning.message).join(' ')}
        </div>
      ) : null}
      {job.isPending ? (
        <LoadingPanel label="Loading job progress…" />
      ) : job.error ? (
        <ErrorNotice message={errorMessage(job.error)} />
      ) : job.data ? (
        <div className="space-y-6">
          <JobProgressPanel job={job.data} />
          {!terminal && (
            <div className="rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-3 text-sm leading-6 text-cyan-900">
              <strong>Why processing takes time:</strong> the external enrichment service allows at
              most five requests per second. TierForge also retries temporary service failures
              without showing fake speed or ETA estimates.
            </div>
          )}
          {terminal && (
            <section className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center">
              <div>
                <h2 className="font-semibold text-slate-950">Enrichment is finished</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {job.data.counts.succeeded > 0
                    ? `${job.data.counts.succeeded.toLocaleString()} stores are ready for scoring.`
                    : 'No stores were successfully enriched, so scoring is unavailable.'}
                </p>
              </div>
              {job.data.counts.succeeded > 0 && (
                <Link
                  to={`/jobs/${jobId}/scoring`}
                  className="rounded-lg bg-slate-950 px-5 py-3 text-center text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Configure scoring
                </Link>
              )}
            </section>
          )}
          {terminal && (
            <section aria-labelledby="failure-heading">
              <div className="mb-4">
                <h2 id="failure-heading" className="text-xl font-semibold text-slate-950">
                  Failure details
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Final failed and skipped stores remain visible for review.
                </p>
              </div>
              <FailureTable
                data={failures.data}
                loading={failures.isPending && hasFailures}
                error={failures.error ? errorMessage(failures.error) : undefined}
                onPageChange={setFailurePage}
              />
            </section>
          )}
        </div>
      ) : null}
    </>
  );
}
