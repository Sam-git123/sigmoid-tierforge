import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { queryKeys } from '../api/query-keys';
import { tierForgeApi, type StoreTier } from '../api/tierforge';
import { ErrorNotice, LoadingPanel, PageHeading } from '../components/app-shell';
import { StatCard, StoreResultsTable, TierBreakdown } from '../components/dashboard';
import { JobStatus } from '../components/job-progress';
import { errorMessage } from '../utils/format';

export function DashboardPage() {
  const { jobId = '' } = useParams();
  const location = useLocation();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [tier, setTier] = useState<StoreTier>();
  const dashboard = useQuery({
    queryKey: queryKeys.dashboard(jobId),
    queryFn: () => tierForgeApi.getDashboard(jobId),
    enabled: Boolean(jobId),
  });
  const stores = useQuery({
    queryKey: queryKeys.stores(jobId, page, pageSize, tier),
    queryFn: () => tierForgeApi.getStores(jobId, { page, pageSize, ...(tier ? { tier } : {}) }),
    enabled: Boolean(jobId),
  });
  const recalculated = Boolean((location.state as { recalculated?: boolean } | null)?.recalculated);

  return (
    <>
      <PageHeading
        eyebrow="Step 4 of 4"
        title="Store performance dashboard"
        description="Review enrichment outcomes and the tier distribution from the latest committed scoring configuration."
        action={
          <div className="flex gap-2">
            <Link
              to={`/jobs/${jobId}/progress`}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Job details
            </Link>
            <Link
              to={`/jobs/${jobId}/scoring`}
              className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Edit scoring
            </Link>
          </div>
        }
      />
      {recalculated && (
        <div
          role="status"
          className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          <strong>Scores updated.</strong> The dashboard now shows the latest scoring revision.
        </div>
      )}
      {dashboard.isPending ? (
        <LoadingPanel label="Loading dashboard…" />
      ) : dashboard.error ? (
        <ErrorNotice message={errorMessage(dashboard.error)} />
      ) : dashboard.data ? (
        <div className="space-y-8">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
            <span className="text-slate-500">
              Job <span className="font-mono text-xs text-slate-700">{jobId}</span>
            </span>
            <div className="flex items-center gap-2">
              <span className="text-slate-500">Status</span>
              <JobStatus status={dashboard.data.job.status} />
            </div>
          </div>
          <section
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
            aria-label="Dashboard summary"
          >
            <StatCard
              label="Total stores"
              value={dashboard.data.job.totalStores}
              helper="Stores in this upload"
              tone="slate"
            />
            <StatCard
              label="Enriched"
              value={dashboard.data.successfullyEnrichedStores}
              helper="Successful enrichment results"
              tone="emerald"
            />
            <StatCard
              label="Failed"
              value={dashboard.data.failedStores}
              helper={`${dashboard.data.skippedStores.toLocaleString()} additionally skipped`}
              tone="rose"
            />
            <StatCard
              label="Scored"
              value={dashboard.data.scoredStores}
              helper={
                dashboard.data.currentScoringRevision
                  ? `Revision ${dashboard.data.currentScoringRevision}`
                  : 'No configuration yet'
              }
              tone="cyan"
            />
          </section>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <TierBreakdown {...dashboard.data.tierCounts} />
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-semibold text-slate-950">Scoring configuration</h2>
              {dashboard.data.currentScoringConfiguration ? (
                <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt className="text-slate-500">Footfall bar</dt>
                    <dd className="font-semibold">
                      {dashboard.data.currentScoringConfiguration.footfallBar}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Weight</dt>
                    <dd className="font-semibold">
                      {dashboard.data.currentScoringConfiguration.footfallWeight}%
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Revenue bar</dt>
                    <dd className="font-semibold">
                      {dashboard.data.currentScoringConfiguration.revenueBar}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Weight</dt>
                    <dd className="font-semibold">
                      {dashboard.data.currentScoringConfiguration.revenueWeight}%
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Size bar</dt>
                    <dd className="font-semibold">
                      {dashboard.data.currentScoringConfiguration.sizeBar}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Weight</dt>
                    <dd className="font-semibold">
                      {dashboard.data.currentScoringConfiguration.sizeWeight}%
                    </dd>
                  </div>
                </dl>
              ) : (
                <div className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
                  No scoring configuration exists.{' '}
                  <Link to={`/jobs/${jobId}/scoring`} className="font-semibold underline">
                    Configure scoring
                  </Link>
                  .
                </div>
              )}
            </section>
          </div>
          <StoreResultsTable
            data={stores.data}
            loading={stores.isPending}
            error={stores.error ? errorMessage(stores.error) : undefined}
            tier={tier}
            pageSize={pageSize}
            onTierChange={(value) => {
              setTier(value);
              setPage(1);
            }}
            onPageChange={setPage}
            onPageSizeChange={(value) => {
              setPageSize(value);
              setPage(1);
            }}
          />
        </div>
      ) : null}
    </>
  );
}
