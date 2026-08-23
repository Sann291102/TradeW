'use client';

import { useId, useState } from 'react';
import { Card, cn } from '@tradew/ui';
import type { ResearchHistory, ResearchHistorySeries, ResearchSection } from '@/lib/research/types';
import { asOf, compactMoney, percent } from '@/lib/research/format';
import { DataUnavailable, SourceLine } from './DataUnavailable';

/**
 * Historical performance.
 *
 * ── WHY A BAR CHART, AND WHY INLINE SVG ────────────────────────────────────
 *
 * Bars, not a line: these are discrete reporting periods, not a continuous
 * series, and a line between two annual points implies values in between that
 * nobody filed. Inline SVG rather than a charting dependency because the shape
 * is five to eight bars with a zero baseline — the whole component is smaller
 * than the config a library would need.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * The server only emits a series when a metric has at least TWO comparable
 * periods, so this component never has to draw a single dot and call it a trend.
 * When nothing qualifies, the section renders the unavailable state instead —
 * "Historical financial data unavailable for this company", the brief's exact
 * requirement.
 *
 * The zero baseline is drawn whenever the data crosses it, because a bar chart
 * of profit that hides the axis makes a loss look like a small profit.
 */
export function HistoryChart({ section }: { section: ResearchSection<ResearchHistory> }) {
  const [active, setActive] = useState(0);

  if (!section.available) {
    return (
      <Card title="Historical performance">
        <DataUnavailable title="Historical financial data unavailable" reason={section.reason} />
      </Card>
    );
  }

  const { series, periodType } = section.data;
  const current = series[Math.min(active, series.length - 1)]!;

  return (
    <Card title="Historical performance" subtitle={`· ${periodType} periods`}>
      <div role="tablist" aria-label="Metric" className="mb-3 flex flex-wrap gap-1">
        {series.map((s, i) => (
          <button
            key={s.metric}
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            className={cn(
              'rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              i === active ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <Bars series={current} />

      <SourceLine
        className="mt-3"
        source={section.provenance.source}
        sourceTimestamp={asOf(section.provenance.sourceTimestamp)}
        fetchedAt={asOf(section.provenance.fetchedAt)}
      />
    </Card>
  );
}

function Bars({ series }: { series: ResearchHistorySeries }) {
  const titleId = useId();
  const values = series.points.map((p) => p.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  // A flat series has zero span; 1 keeps the SVG arithmetic finite. This is
  // chart geometry, never a stand-in for a missing value — every point plotted
  // here is a real reported figure.
  const span = max - min === 0 ? 1 : max - min;

  const W = 100;
  const H = 42;
  const gap = 1.6;
  const barW = (W - gap * (series.points.length - 1)) / series.points.length;
  const zeroY = H - ((0 - min) / span) * H;

  const fmt = (v: number) =>
    series.unit === 'percent' ? percent(v, 1) : compactMoney(v, series.currency ?? 'INR');

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={titleId}
        className="h-36 w-full"
      >
        <title id={titleId}>
          {series.label} by period: {series.points.map((p) => `${p.fiscalYear} ${fmt(p.value)}`).join(', ')}
        </title>
        {/* Zero baseline, drawn only when the data actually crosses it. */}
        {min < 0 && max > 0 && (
          <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="currentColor" strokeWidth={0.3} className="text-border2" />
        )}
        {series.points.map((p, i) => {
          const x = i * (barW + gap);
          const y = H - ((p.value - min) / span) * H;
          const height = Math.abs(zeroY - y);
          return (
            <rect
              key={p.periodEnd}
              x={x}
              y={Math.min(y, zeroY)}
              width={barW}
              height={Math.max(height, 0.4)}
              rx={0.6}
              className={p.value >= 0 ? 'fill-teal' : 'fill-down'}
              opacity={i === series.points.length - 1 ? 1 : 0.62}
            >
              <title>{`${p.fiscalYear}${p.fiscalQuarter ? ` Q${p.fiscalQuarter}` : ''}: ${fmt(p.value)}`}</title>
            </rect>
          );
        })}
      </svg>

      <figcaption className="mt-1.5 flex justify-between text-[10px] tabular-nums text-faint">
        {series.points.map((p) => (
          <span key={p.periodEnd} className="flex-1 text-center">
            <span className="block font-semibold text-muted">{fmt(p.value)}</span>
            {p.fiscalYear}
            {p.fiscalQuarter ? ` Q${p.fiscalQuarter}` : ''}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
