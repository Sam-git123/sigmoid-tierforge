interface PaginationProps {
  page: number;
  totalPages: number;
  totalRecords: number;
  onPageChange(page: number): void;
}

export function Pagination({ page, totalPages, totalRecords, onPageChange }: PaginationProps) {
  return (
    <div className="flex flex-col gap-3 border-t border-slate-200 px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="text-slate-500">
        {totalRecords.toLocaleString()} record{totalRecords === 1 ? '' : 's'}
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-lg border border-slate-300 px-3 py-2 font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>
        <span className="text-slate-600">
          Page <strong className="text-slate-900">{page}</strong> of {Math.max(totalPages, 1)}
        </span>
        <button
          type="button"
          disabled={page >= totalPages || totalPages === 0}
          onClick={() => onPageChange(page + 1)}
          className="rounded-lg border border-slate-300 px-3 py-2 font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
