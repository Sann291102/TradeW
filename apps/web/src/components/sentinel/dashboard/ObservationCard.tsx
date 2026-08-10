'use client';

import { cn } from '@tradew/ui';
import type { ObservationCardModel } from '@/lib/sentinel/dashboardModel';

/**
 * Sentinel Observation card — the single, user-facing read (headline + why +
 * confidence-vs-threshold). Mirrors the reference "WAIT AND WATCH" panel. Copy
 * is non-directive by construction: it explains what Sentinel sees and why,
 * never buy/sell/entry/target. All content comes from the real observation
 * (synthesis / publication gate / top observations).
 */
export function ObservationCard({ model }: { model: ObservationCardModel }) {
  const { headline, summary, why, confidence, threshold, updatedLabel } = model;
  const pct = confidence == null ? null : Math.max(0, Math.min(100, confidence));

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-bold text-text">Sentinel Observation</h2>
        <span className="text-[10.5px] text-faint">{updatedLabel}</span>
      </div>

      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-bg text-amber">
          <EyeIcon />
        </span>
        <div className="min-w-0">
          <p className="text-[15px] font-extrabold uppercase tracking-tightTrack text-amber">{headline}</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">{summary}</p>
        </div>
      </div>

      {why.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[11px] font-bold text-text">Why?</p>
          <ul className="space-y-1.5">
            {why.map((w, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px] leading-snug text-muted">
                <span className={cn('mt-[3px] shrink-0', w.ok ? 'text-up' : 'text-amber')}>
                  {w.ok ? <CheckIcon /> : <DotAlertIcon />}
                </span>
                <span className="min-w-0">{w.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pct != null && (
        <div className="mt-4 rounded-xl border border-border bg-bg p-3">
          <div className="mb-1.5 flex items-center justify-between text-[11px]">
            <span className="font-semibold text-text">Confidence</span>
            <span className="text-faint">Threshold: {threshold}%</span>
          </div>
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-hover">
            <div
              className={cn('h-full rounded-full', pct >= threshold ? 'bg-up' : 'bg-amber')}
              style={{ width: `${pct}%` }}
            />
            <div className="absolute top-0 h-full w-px bg-text/60" style={{ left: `${threshold}%` }} aria-hidden />
          </div>
          <p className="mt-1 text-[11px] font-bold text-text">{pct}%</p>
        </div>
      )}
    </section>
  );
}

const ic = { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const EyeIcon = () => (<svg {...ic}><path d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10Z" /><circle cx="10" cy="10" r="2.4" /></svg>);
const CheckIcon = () => (<svg {...ic} width={13} height={13}><path d="m4 10.5 3.5 3.5L16 5.5" /></svg>);
const DotAlertIcon = () => (<svg {...ic} width={13} height={13}><circle cx="10" cy="10" r="7" /><path d="M10 6.5v4M10 13.4v.1" /></svg>);
