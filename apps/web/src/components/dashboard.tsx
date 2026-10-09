import type { DashboardSummary, Paginated, StoreRecord, StoreTier } from '../api/tierforge';
import { formatNumber } from '../utils/format';
import { ErrorNotice, LoadingPanel } from './app-shell';
import { Pagination } from './pagination';

export function StatCard({
  label,
  value,
  helper,
  tone = 'slate',
}: {
  label: string;
  value: number;
  helper: string;
  tone?: 'slate' | 'cyan' | 'emerald' | 'amber' | 'rose';
}) {
  const tones = {
    slate: 'bg-slate-950 text-white',
    cyan: 'bg-cyan-50 text-cyan-950 border border-cyan-100',
    emerald: 'bg-emerald-50 text-emerald-950 border border-emerald-100',
    amber: 'bg-amber-50 text-amber-950 border border-amber-100',
    rose: 'bg-rose-50 text-rose-950 border border-rose-100',
  };
  return (
    <div className={`rounded-2xl p-5 shadow-sm ${tones[tone]}`}>
      <p
        className={`text-xs font-bold uppercase tracking-wider ${tone === 'slate' ? 'text-slate-400' : 'opacity-60'}`}
      >
        {label}
      </p>
      <p className="mt-2 text-3xl font-semibold tracking-tight">{value.toLocaleString()}</p>
      <p className={`mt-2 text-xs ${tone === 'slate' ? 'text-slate-400' : 'opacity-70'}`}>
        {helper}
      </p>
    </div>
  );
}

export function DashboardStats({ dashboard }: { dashboard: DashboardSummary }) {
  const pending =
    dashboard.job.counts.pending + dashboard.job.counts.processing + dashboard.job.counts.retryWait;
  return (
    <section
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
      aria-label="Dashboard summary"
    >
      <StatCard
        label="Total stores"
        value={dashboard.job.totalStores}
        helper="Stores in this upload"
        tone="slate"
      />
      <StatCard
        label="Enriched"
        value={dashboard.successfullyEnrichedStores}
        helper="Successful enrichment results"
        tone="emerald"
      />
      <StatCard
        label="Pending"
        value={pending}
        helper="Pending, processing, or retrying"
        tone="cyan"
      />
      <StatCard
        label="Failed"
        value={dashboard.failedStores}
        helper="Permanently failed stores"
        tone="rose"
      />
      <StatCard
        label="Skipped"
        value={dashboard.skippedStores}
        helper="Settled by job termination"
        tone="amber"
      />
      <StatCard
        label="Scored"
        value={dashboard.scoredStores}
        helper={
          dashboard.currentScoringRevision
            ? `Revision ${dashboard.currentScoringRevision}`
            : 'No configuration yet'
        }
        tone="cyan"
      />
    </section>
  );
}

export function TierBreakdown({
  large,
  medium,
  small,
}: {
  large: number;
  medium: number;
  small: number;
}) {
  const total = large + medium + small;
  const tiers = [
    { label: 'Large', count: large, color: 'bg-indigo-500' },
    { label: 'Medium', count: medium, color: 'bg-cyan-500' },
    { label: 'Small', count: small, color: 'bg-amber-400' },
  ];
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
      aria-labelledby="tier-breakdown-title"
    >
      <div className="flex items-start justify-between">
        <div>
          <h2 id="tier-breakdown-title" className="text-lg font-semibold text-slate-950">
            Tier distribution
          </h2>
          <p className="mt-1 text-sm text-slate-500">Current scoring revision</p>
        </div>
        <span className="text-sm font-semibold text-slate-600">
          {total.toLocaleString()} scored
        </span>
      </div>
      <div
        className="mt-7 flex h-3 overflow-hidden rounded-full bg-slate-100"
        aria-label={`${large} Large, ${medium} Medium, ${small} Small`}
      >
        {tiers.map((tier) => (
          <span
            key={tier.label}
            className={tier.color}
            style={{ width: `${total ? (tier.count / total) * 100 : 0}%` }}
          />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-3 gap-3">
        {tiers.map((tier) => (
          <div key={tier.label} className="rounded-xl bg-slate-50 p-3">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${tier.color}`} />
              <span className="text-xs font-semibold text-slate-600">{tier.label}</span>
            </div>
            <p className="mt-2 text-xl font-semibold text-slate-950">
              {tier.count.toLocaleString()}
            </p>
            <p className="text-xs text-slate-500">
              {total ? ((tier.count / total) * 100).toFixed(1) : '0.0'}%
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function TierBadge({ tier }: { tier: StoreRecord['tier'] }) {
  if (!tier) return <span className="text-slate-400">Unscored</span>;
  const tone =
    tier === 'Large'
      ? 'bg-indigo-100 text-indigo-800'
      : tier === 'Medium'
        ? 'bg-cyan-100 text-cyan-800'
        : 'bg-amber-100 text-amber-800';
  return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${tone}`}>{tier}</span>;
}

function selectedTier(value: string): StoreTier | undefined {
  return value === 'Large' || value === 'Medium' || value === 'Small' ? value : undefined;
}

interface StoreResultsTableProps {
  data?: Paginated<StoreRecord> | undefined;
  loading: boolean;
  error?: string | undefined;
  tier?: StoreTier | undefined;
  pageSize: number;
  onTierChange(tier?: StoreTier | undefined): void;
  onPageChange(page: number): void;
  onPageSizeChange(pageSize: number): void;
}

export function StoreResultsTable({
  data,
  loading,
  error,
  tier,
  pageSize,
  onTierChange,
  onPageChange,
  onPageSizeChange,
}: StoreResultsTableProps) {
  return (
    <section aria-labelledby="store-results-title">
      <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 id="store-results-title" className="text-xl font-semibold text-slate-950">
            Store results
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Metrics and scores from the current scoring revision.
          </p>
        </div>
        <div className="flex gap-3">
          <label className="text-xs font-semibold text-slate-600">
            Tier filter
            <select
              aria-label="Filter by tier"
              value={tier ?? ''}
              onChange={(event) => onTierChange(selectedTier(event.target.value))}
              className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            >
              <option value="">All tiers</option>
              <option value="Large">Large</option>
              <option value="Medium">Medium</option>
              <option value="Small">Small</option>
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Rows
            <select
              aria-label="Rows per page"
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
        </div>
      </div>

      {loading ? (
        <LoadingPanel label="Loading store results…" />
      ) : error ? (
        <ErrorNotice message={error} />
      ) : !data?.records.length ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
          <p className="font-semibold text-slate-800">No store results found</p>
          <p className="mt-1 text-sm text-slate-500">
            {tier
              ? `No stores are currently scored as ${tier}.`
              : 'Results will appear after stores are enriched and scored.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-[900px] divide-y divide-slate-200 text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-semibold">Store ID</th>
                  <th className="px-5 py-3 font-semibold">Store name</th>
                  <th className="px-5 py-3 text-right font-semibold">Footfall</th>
                  <th className="px-5 py-3 text-right font-semibold">Revenue</th>
                  <th className="px-5 py-3 text-right font-semibold">Size (sqft)</th>
                  <th className="px-5 py-3 text-right font-semibold">Score</th>
                  <th className="px-5 py-3 font-semibold">Tier</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.records.map((store) => (
                  <tr key={store.storeId} className="hover:bg-slate-50/70">
                    <td className="px-5 py-4 font-mono text-xs text-slate-600">{store.storeId}</td>
                    <td className="px-5 py-4 font-semibold text-slate-900">{store.storeName}</td>
                    <td className="px-5 py-4 text-right tabular-nums text-slate-700">
                      {formatNumber(store.estimatedMonthlyFootfall)}
                    </td>
                    <td className="px-5 py-4 text-right tabular-nums text-slate-700">
                      {formatNumber(store.estimatedMonthlyRevenue)}
                    </td>
                    <td className="px-5 py-4 text-right tabular-nums text-slate-700">
                      {formatNumber(store.storeSizeSqft)}
                    </td>
                    <td className="px-5 py-4 text-right font-semibold tabular-nums text-slate-950">
                      {formatNumber(store.score)}
                    </td>
                    <td className="px-5 py-4">
                      <TierBadge tier={store.tier} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            totalRecords={data.totalRecords}
            onPageChange={onPageChange}
          />
        </div>
      )}
    </section>
  );
}
