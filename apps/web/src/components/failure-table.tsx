import type { FailureRecord, Paginated } from '../api/tierforge';
import { ErrorNotice, LoadingPanel } from './app-shell';
import { Pagination } from './pagination';

interface FailureTableProps {
  data?: Paginated<FailureRecord> | undefined;
  loading: boolean;
  error?: string | undefined;
  onPageChange(page: number): void;
}

export function FailureTable({ data, loading, error, onPageChange }: FailureTableProps) {
  if (loading) return <LoadingPanel label="Loading failure details…" />;
  if (error) return <ErrorNotice message={error} />;
  if (!data?.records.length) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-5 text-sm text-emerald-800">
        No failed or skipped stores were recorded.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-5 py-3 font-semibold">Store</th>
              <th className="px-5 py-3 font-semibold">Attempts</th>
              <th className="px-5 py-3 font-semibold">Final status</th>
              <th className="px-5 py-3 font-semibold">Failure details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.records.map((record) => (
              <tr key={record.storeId}>
                <td className="px-5 py-4">
                  <span className="block font-semibold text-slate-900">{record.storeName}</span>
                  <span className="font-mono text-xs text-slate-500">{record.storeId}</span>
                </td>
                <td className="px-5 py-4 text-slate-700">{record.attemptCount}</td>
                <td className="px-5 py-4">
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-bold ${record.finalStatus === 'failed' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}`}
                  >
                    {record.finalStatus}
                  </span>
                </td>
                <td className="max-w-md px-5 py-4">
                  <span className="block text-xs font-semibold text-slate-700">
                    {record.lastErrorCode ?? 'No code'}
                  </span>
                  <span className="mt-1 block text-slate-600">
                    {record.lastErrorMessage ?? 'No additional reason was recorded.'}
                  </span>
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
  );
}
