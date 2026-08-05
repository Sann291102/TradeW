'use client';

import { buttonClasses, cn } from '@tradew/ui';

/** Shared page-forward/back control — Orders, Trade History, and the
 *  Performance Diary all paginate, so this is built once rather than three
 *  times with slightly different styling. */
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;

  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted">
      <span>
        Page {page} of {pageCount} &middot; {total} total
      </span>
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          className={cn(buttonClasses({ variant: 'outline', size: 'sm' }), 'disabled:opacity-40')}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= pageCount}
          onClick={() => onChange(page + 1)}
          className={cn(buttonClasses({ variant: 'outline', size: 'sm' }), 'disabled:opacity-40')}
        >
          Next
        </button>
      </div>
    </div>
  );
}
