'use client';

import { useEffect } from 'react';
import { Badge, Card, Skeleton, cn } from '@tradew/ui';
import { DisciplineLimit } from '@/lib/discipline';
import { useDisciplineStore } from '@/lib/store/disciplineStore';

/**
 * Read-only view of today's discipline session: the limits the trader set
 * against what is left of each.
 *
 * Strictly a read. Nothing here places, cancels or modifies anything, and
 * nothing is editable — limits are set once, at the start of the session, and
 * going past one costs a written reason rather than an edit.
 *
 * Every figure comes from the server's `budget`, computed by `computeBudget`
 * in the API. None of it is recomputed client-side, so this view and the
 * enforcement path can never disagree about how much room is left.
 *
 * Observation only — the trader's own counters against their own numbers.
 */
export function SessionBudgetCard({ className }: { className?: string }) {
  const status = useDisciplineStore((s) => s.status);
  const today = useDisciplineStore((s) => s.today);
  const error = useDisciplineStore((s) => s.error);

  // `init` is idempotent (guarded by a module-level flag), so whichever mounts
  // first wins and later callers are no-ops. That lets this card stand alone on
  // /discipline without depending on the shell having started the store.
  useEffect(() => useDisciplineStore.getState().init(), []);

  if (status === 'idle' || status === 'loading') {
    return (
      <Card title="Today's limits" className={className}>
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </Card>
    );
  }

  if (status === 'error') {
    return (
      <Card title="Today's limits" className={className}>
        <p className="text-xs text-muted">
          Couldn&apos;t load your session just now{error ? ` — ${error}` : ''}. Your limits are still being applied on
          every order.
        </p>
      </Card>
    );
  }

  const session = today?.session;
  if (!session) {
    return (
      <Card title="Today's limits" className={className}>
        <p className="text-xs text-muted">
          {today?.reason === 'not_a_trading_day'
            ? 'No session today — the market is closed.'
            : today?.reason === 'before_market_open'
              ? "You'll be asked to set your limits when the session opens."
              : 'No limits set for today yet.'}
        </p>
      </Card>
    );
  }

  const { budget } = session;
  const breached = (limit: DisciplineLimit) => budget.breachedLimits.includes(limit);

  return (
    <Card
      title="Today's limits"
      subtitle={`started ${startedLabel(session.startedAt)}`}
      className={className}
      actions={
        budget.breachedLimits.length > 0 ? (
          <Badge tone="warning" className="px-1.5 py-0 text-[9px]">
            {budget.breachedLimits.length} PASSED
          </Badge>
        ) : undefined
      }
    >
      <dl className="space-y-2.5">
        <Row
          label="Time"
          value={`${budget.elapsedMinutes} of ${session.maxMinutes} min`}
          fraction={session.maxMinutes === 0 ? 1 : budget.elapsedMinutes / session.maxMinutes}
          breached={breached('MAX_MINUTES')}
        />
        <Row
          label="Trades"
          value={`${budget.tradesTaken} of ${session.maxTrades}`}
          fraction={session.maxTrades === 0 ? 1 : budget.tradesTaken / session.maxTrades}
          breached={breached('MAX_TRADES')}
        />
        <Row
          label="Loss budget"
          value={`${inr0(budget.remainingLoss)} of ${inr0(session.maxLoss)} left`}
          fraction={session.maxLoss === 0 ? 1 : 1 - budget.remainingLoss / session.maxLoss}
          breached={breached('MAX_LOSS')}
        />

        <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2.5">
          <dt className="text-xs text-muted">Profit target</dt>
          <dd className="text-xs font-semibold tabular-nums text-text">
            {session.targetProfit === null ? (
              <span className="font-normal text-faint">Not set</span>
            ) : (
              <>
                {inr0(session.targetProfit)}
                {budget.targetReached && <span className="ml-1.5 font-normal text-muted">· reached</span>}
              </>
            )}
          </dd>
        </div>

        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-xs text-muted">Overrides today</dt>
          <dd className="text-xs font-semibold tabular-nums text-text">{session.overrides.length}</dd>
        </div>
      </dl>

      {session.overrides.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-border pt-3">
          {session.overrides.map((o) => (
            <li key={o.id} className="text-[11px] leading-relaxed">
              <span className="font-semibold text-muted">{LIMIT_LABEL[o.limitType]}</span>
              <span className="text-faint"> · {timeLabel(o.createdAt)}</span>
              <p className="mt-0.5 text-muted">{o.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const LIMIT_LABEL: Record<DisciplineLimit, string> = {
  MAX_TRADES: 'Trade count',
  MAX_LOSS: 'Loss budget',
  MAX_MINUTES: 'Session length',
};

/**
 * One limit row: label, figures, and a spent-so-far bar.
 *
 * The bar is teal while there is room and amber once the limit is passed —
 * never green/red, which DESIGN-SYSTEM.md §1 reserves for market direction.
 * A spent loss budget is not a down move.
 */
function Row({
  label,
  value,
  fraction,
  breached,
}: {
  label: string;
  value: string;
  fraction: number;
  breached: boolean;
}) {
  const pctWidth = Math.min(100, Math.max(0, fraction * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-xs text-muted">{label}</dt>
        <dd className={cn('text-xs font-semibold tabular-nums', breached ? 'text-amber' : 'text-text')}>{value}</dd>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-bg" aria-hidden="true">
        <div
          className={cn('h-full rounded-full transition-[width] duration-panel ease-standard', breached ? 'bg-amber' : 'bg-teal')}
          style={{ width: `${pctWidth}%` }}
        />
      </div>
    </div>
  );
}

function inr0(n: number): string {
  return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(n));
}

/** 'HH:mm' in IST — the session's own clock, not the browser's. */
function startedLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

const timeLabel = startedLabel;
