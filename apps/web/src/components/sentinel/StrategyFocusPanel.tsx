'use client';

import { useEffect, useState } from 'react';
import { cn } from '@tradew/ui';
import { fetchStrategyPerformance } from '@/lib/sentinel/sentinelPy';
import type { StrategyPerformance, Timeline } from '@/lib/sentinel/sentinelPy';

/**
 * The focus panel: ONE watch, answering "why is this happening?".
 *
 * The split with the feed is deliberate and is the point of this component.
 * The panel shows CURRENT STATE — which of the user's conditions are met
 * right now, and how this strategy has behaved historically. The feed shows
 * WHAT CHANGED. Neither repeats the other, so a user reading both is not
 * reading the same sentence twice.
 *
 * Everything here describes the user's own strategy. Nothing ranks it against
 * other strategies, nominates one, or proposes an entry, invalidation or
 * projected level — those are the user's to declare.
 */

interface Props {
  timeline: Timeline;
}

const STATE_LABEL: Record<string, { text: string; tone: string }> = {
  IDLE: { text: 'WATCHING', tone: 'bg-hover text-muted' },
  FORMING: { text: 'FORMING', tone: 'bg-amber-bg text-amber' },
  CONFIRMED: { text: 'CONFIRMED', tone: 'bg-up-bg text-up' },
  IN_TRADE: { text: 'POSITION OPEN', tone: 'bg-teal-bg text-teal' },
  EXITED: { text: 'CLOSED', tone: 'bg-hover text-faint' },
};

function R({ value }: { value: number | null }) {
  if (value == null) return <span className="text-faint">—</span>;
  return (
    <span className={value >= 0 ? 'text-up' : 'text-down'}>
      {value >= 0 ? '+' : ''}
      {value.toFixed(2)}R
    </span>
  );
}

export function StrategyFocusPanel({ timeline }: Props) {
  const [performance, setPerformance] = useState<StrategyPerformance | null>(null);
  const { watch, conditions } = timeline;

  useEffect(() => {
    let cancelled = false;
    fetchStrategyPerformance(watch.strategyId)
      .then((p) => !cancelled && setPerformance(p))
      .catch(() => !cancelled && setPerformance(null));
    return () => {
      cancelled = true;
    };
  }, [watch.strategyId]);

  const state = STATE_LABEL[watch.state] ?? STATE_LABEL.IDLE;
  const instrument = [watch.symbol, watch.strike, watch.optionType].filter(Boolean).join(' ');
  const mandatory = conditions.filter((c) => c.mandatory);
  const metCount = mandatory.filter((c) => c.met).length;

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          {/* "My Strategy", not "Strategy" — Sentinel is watching what the
              user declared, not offering one of its own. */}
          <p className="text-[10.5px] uppercase tracking-tightTrack text-faint">My strategy</p>
          <h2 className="text-[14px] font-bold text-text">{instrument}</h2>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-tightTrack',
            state.tone,
          )}
        >
          {state.text}
        </span>
      </div>

      <div className="mb-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-tightTrack text-muted">
            Your conditions
          </h3>
          {mandatory.length > 0 && (
            <span className="text-[10.5px] text-faint">
              {metCount} of {mandatory.length} required
            </span>
          )}
        </div>

        {conditions.length === 0 ? (
          <p className="text-[12px] text-faint">Nothing evaluated yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {conditions.map((condition) => (
              <li key={condition.id} className="flex items-start gap-2 text-[12px]">
                <span className={cn('mt-px shrink-0', condition.met ? 'text-up' : 'text-faint')}>
                  {condition.met ? '✓' : '○'}
                </span>
                <span className="min-w-0">
                  <span className={condition.met ? 'text-text' : 'text-muted'}>
                    {condition.name.replace(/_/g, ' ')}
                  </span>
                  {!condition.mandatory && <span className="ml-1.5 text-[10px] text-faint">optional</span>}
                  {condition.detail && (
                    <span className="block text-[11px] text-faint">{condition.detail}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border pt-3">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-tightTrack text-muted">
          How this strategy has behaved
        </h3>

        {performance == null ? (
          <p className="text-[12px] text-faint">No history yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] sm:grid-cols-3">
              <Stat label="Watches" value={String(performance.funnel.watches)} />
              <Stat label="Confirmed" value={String(performance.funnel.confirmations)} />
              <Stat label="Entries" value={String(performance.funnel.entries)} />
              <Stat label="Stepped back" value={String(performance.funnel.rejections)} />
              <Stat label="Completed" value={String(performance.r.completed)} />
              <Stat label="Expectancy" value={<R value={performance.r.expectancy} />} />
              <Stat label="Best" value={<R value={performance.r.best} />} />
              <Stat label="Worst" value={<R value={performance.r.worst} />} />
              <Stat label="Avg MFE / MAE" value={
                <>
                  <R value={performance.r.avgMfe} /> <span className="text-faint">/</span>{' '}
                  <R value={performance.r.avgMae} />
                </>
              } />
            </div>

            {/* Sample size is never hidden behind a rate — see the note the
                performance engine returns. */}
            {!performance.sufficient && performance.note && (
              <p className="mt-2.5 text-[11px] leading-relaxed text-amber">{performance.note}</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10.5px] text-faint">{label}</p>
      <p className="font-semibold text-text">{value}</p>
    </div>
  );
}
