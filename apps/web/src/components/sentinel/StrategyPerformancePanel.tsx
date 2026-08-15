'use client';

import type { Performance, Segment } from '@/lib/sentinel/strategyContract';

/**
 * Performance: the lifecycle funnel, and any breakdown the user's own history
 * can actually support.
 *
 * Two rules, both load-bearing:
 *
 * 1. **No observed samples, no segment.** A breakdown with nothing behind it
 *    is not rendered empty — it is not rendered. Three empty bars read as
 *    three findings, and a dashboard that is mostly zeroes teaches people to
 *    ignore the parts that aren't.
 *
 * 2. **Nothing here is a verdict.** These are counts from the user's own
 *    watches. A bucket with more confirmations is not a better bucket, no
 *    strategy is compared with another, and the small-sample note from the
 *    backend is shown rather than hidden.
 */

interface Props {
  performance: Performance;
  segments: Segment[];
}

function Stage({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-xs tabular-nums text-fg">{value}</span>
    </div>
  );
}

function R({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-xs tabular-nums text-fg">
        {value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`}
      </span>
    </div>
  );
}

export function StrategyPerformancePanel({ performance, segments }: Props) {
  const { funnel, outcomes, r } = performance;
  // Filtered here as well as in the adapter: a component that renders whatever
  // it is handed is one prop away from showing an empty chart.
  const worthShowing = segments.filter((segment) => segment.samples > 0);

  return (
    <section data-testid="strategy-performance" className="space-y-5">
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Strategy lifecycle
        </h3>
        <Stage label="Observed setups" value={funnel.watches} />
        <Stage label="Validated" value={funnel.interactions} />
        <Stage label="Confirmed" value={funnel.confirmations} />
        <Stage label="Entries you confirmed" value={funnel.entries} />
        <Stage label="Outcomes" value={funnel.outcomes} />
        <Stage label="Setups that gave a condition back" value={funnel.rejections} />
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Outcomes</h3>
        <Stage label="Reached projected level" value={outcomes.reachedProjected} />
        <Stage label="Reached invalidation" value={outcomes.reachedInvalidation} />
        <Stage label="Still open" value={outcomes.stillOpen} />
        <R label="Expectancy" value={r.expectancy} />
        <R label="Best" value={r.best} />
        <R label="Worst" value={r.worst} />
      </div>

      {performance.note && (
        <p data-testid="sample-note" className="text-[11px] leading-relaxed text-amber">
          {performance.note}
        </p>
      )}

      {worthShowing.map((segment) => {
        const largest = Math.max(...segment.buckets.map((b) => b.observations), 1);
        return (
          <div key={segment.id} data-testid={`segment-${segment.id}`}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {segment.label}{' '}
              <span className="font-normal normal-case text-faint">
                · {segment.samples} observation{segment.samples === 1 ? '' : 's'}
              </span>
            </h3>
            <ul className="space-y-1.5">
              {segment.buckets.map((bucket) => (
                <li key={bucket.label} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 text-xs text-muted">{bucket.label}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg2">
                    <span
                      className="block h-full rounded-full bg-fg/40"
                      style={{ width: `${(bucket.observations / largest) * 100}%` }}
                    />
                  </span>
                  <span className="w-8 shrink-0 text-right text-xs tabular-nums text-fg">
                    {bucket.observations}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
