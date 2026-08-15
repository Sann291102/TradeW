'use client';

import { Badge, cn } from '@tradew/ui';
import type { UserStrategy, WatchSession } from '@/lib/sentinel/strategyApi';
import {
  formatExpiry,
  formatRMultiple,
  instrumentLabel,
  isDormant,
  plannedRatio,
  positionSnapshot,
  rMultipleTone,
  WATCH_STATE_META,
} from '@/lib/sentinel/watchModel';

/**
 * One watch, in whatever state it is in.
 *
 * Pre-position (IDLE/FORMING/CONFIRMED) it shows the instrument, the strategy
 * behind it and what the state means. Once the user has declared a position it
 * additionally shows their own entry, invalidation and projected levels
 * alongside the live price and the resulting R-multiple.
 *
 * Everything shown is either the user's own number or a live quote. Sentinel
 * proposes no levels here, and the card never renders a price it does not
 * have — a dash means "no live quote right now", not zero.
 */
export function WatchCard({
  watch,
  strategies,
  price,
  action,
}: {
  watch: WatchSession;
  strategies: UserStrategy[];
  price: number | null;
  /** Rendered in the card's action row — "I'm in", "Close", etc. */
  action?: React.ReactNode;
}) {
  const meta = WATCH_STATE_META[watch.state];
  const strategy = strategies.find((s) => s.id === watch.strategyId);
  const dormant = isDormant(watch, strategies);
  const snapshot = positionSnapshot(watch, price);
  const inTrade = watch.state === 'IN_TRADE';

  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        watch.state === 'CONFIRMED' ? 'border-teal bg-teal-bg' : 'border-border bg-bg',
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[13px] font-bold text-text">{instrumentLabel(watch)}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted">
            {strategy?.name ?? 'Strategy no longer listed'}
            {watch.expiry && ` · ${formatExpiry(watch.expiry)}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={meta.tone} className="px-2 py-0 text-[9.5px] uppercase">
            {meta.label}
          </Badge>
          <span className="font-mono text-[12.5px] font-semibold text-text">
            {price === null ? '—' : price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{meta.blurb}</p>

      {dormant && (
        <p className="mt-1.5 rounded-lg border border-amber bg-amber-bg px-2 py-1.5 text-[10.5px] leading-relaxed text-amber">
          Its strategy is paused, so this watch is not being evaluated right now.
        </p>
      )}

      {inTrade && (
        <>
          <dl className="mt-2.5 grid grid-cols-3 gap-2 border-t border-border pt-2.5">
            <Metric label="Your entry" value={fmt(watch.entryPrice)} />
            <Metric label="Invalidation" value={fmt(watch.stopPrice)} />
            <Metric label="Projected" value={fmt(watch.targetPrice)} />
          </dl>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">Progress</span>
              <p
                className={cn(
                  'font-mono text-[15px] font-bold leading-tight',
                  snapshot.r === null
                    ? 'text-muted'
                    : rMultipleTone(snapshot.r) === 'positive'
                      ? 'text-up'
                      : rMultipleTone(snapshot.r) === 'negative'
                        ? 'text-down'
                        : 'text-text',
                )}
              >
                {formatRMultiple(snapshot.r)}
              </p>
            </div>
            <div className="min-w-0">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">Planned</span>
              <p className="font-mono text-[12px] text-muted">{formatPlanned(watch)}</p>
            </div>
            <div className="min-w-0">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">Milestones</span>
              <p className="text-[11.5px] text-muted">
                {snapshot.reached.length > 0 ? snapshot.reached.join(' · ') : 'none yet'}
                {snapshot.next && <span className="text-faint"> → {snapshot.next}</span>}
              </p>
            </div>
          </div>
          {snapshot.r === null && price !== null && (
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-faint">
              Your entry and invalidation level are the same, so there is no risk to measure progress against.
            </p>
          )}
        </>
      )}

      {action && <div className="mt-2.5 border-t border-border pt-2.5">{action}</div>}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</dt>
      <dd className="truncate font-mono text-[12.5px] text-text">{value}</dd>
    </div>
  );
}

function fmt(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The user's own planned risk:reward, e.g. `1 : 3.00`. */
function formatPlanned(watch: WatchSession): string {
  const ratio = plannedRatio(watch.entryPrice, watch.stopPrice, watch.targetPrice);
  return ratio === null ? 'no projected level' : `1 : ${ratio.toFixed(2)}`;
}
