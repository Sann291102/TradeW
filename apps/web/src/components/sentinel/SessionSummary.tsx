import { cn } from '@tradew/ui';
import type { SessionSummaryData } from '@/lib/sentinel/types';

export function SessionSummary({ summary }: { summary: SessionSummaryData | null }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">Session Summary</h3>
      <dl className="space-y-3">
        <div className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5">
          <dt className="text-muted">Trades Today</dt>
          <dd className="font-semibold text-text">{summary?.tradesToday ?? '—'}</dd>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5">
          <dt className="text-muted">Flagged Events</dt>
          <dd className={cn('font-semibold', (summary?.flaggedEvents ?? 0) > 0 ? 'text-amber' : 'text-text')}>
            {summary?.flaggedEvents ?? '—'}
          </dd>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5">
          <dt className="text-muted">Realized P&amp;L</dt>
          <dd className={cn('font-semibold', (summary?.realizedPnl ?? 0) < 0 ? 'text-down' : 'text-up')}>
            {summary ? `₹${summary.realizedPnl.toLocaleString('en-IN')}` : '—'}
          </dd>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5">
          <dt className="text-muted">Order Flow</dt>
          <dd className="text-[11.5px] font-medium text-up">Never blocked by Sentinel</dd>
        </div>
      </dl>
    </div>
  );
}
