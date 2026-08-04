'use client';

import type { OptionContextPanel as OptionContext } from '@/lib/strategy-workspace/types';

/**
 * Panel 2 — the option-chain context around the strike in focus.
 *
 * Two things this panel is careful about:
 *
 * `strikeSource` is shown, not hidden. A UI that cannot distinguish "the user
 * asked about 24500" from "we snapped to the nearest ATM strike" will
 * eventually present the second as the first.
 *
 * OI bars are scaled against the largest value in the visible window, so the
 * relative shape of positioning is readable at a glance. They are a comparison
 * within this window only, never an absolute measure.
 */
export function OptionContextPanel({ context }: { context: OptionContext | null }) {
  if (!context) {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-[12px] font-semibold text-text">Option context</h2>
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
          No option chain is available for this instrument, so positioning cannot be read. Nothing is estimated in its
          place.
        </p>
      </section>
    );
  }

  const maxOI = Math.max(1, ...context.rows.flatMap((r) => [r.callOI, r.putOI]));

  return (
    <section className="rounded-lg border border-border bg-surface">
      <header className="border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[12px] font-semibold text-text">
            {context.underlying} option context
          </h2>
          <span className="text-[10.5px] text-faint">
            spot {context.spot.toFixed(1)}
            {context.expiry ? ` · expiry ${context.expiry.slice(0, 10)}` : ''}
          </span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px]">
          <span className="text-muted">
            Strike in focus{' '}
            <span className="font-semibold text-text">
              {context.selectedStrike ?? '—'}
              {context.selectedRight ?? ''}
            </span>
          </span>
          {context.strikeSource === 'atm-snap' && (
            <span className="rounded border border-border px-1 py-0.5 text-faint">
              chosen for you — nearest at-the-money
            </span>
          )}
          {context.strikeSource === 'user' && (
            <span className="rounded border border-border px-1 py-0.5 text-faint">as requested</span>
          )}
        </div>

        {context.summary && (
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10.5px] sm:grid-cols-4">
            <Stat label="PCR" value={context.summary.pcr.toFixed(2)} />
            <Stat label="Max pain" value={context.summary.maxPain.toFixed(0)} />
            <Stat label="Call wall" value={context.summary.callOIWall?.toFixed(0) ?? '—'} />
            <Stat label="Put wall" value={context.summary.putOIWall?.toFixed(0) ?? '—'} />
          </dl>
        )}
      </header>

      <div className="max-h-[420px] overflow-auto">
        <table className="w-full text-[10.5px]">
          <thead className="sticky top-0 bg-surface">
            <tr className="text-faint">
              <th className="px-2 py-1 text-right font-medium">Call OI</th>
              <th className="px-2 py-1 text-right font-medium">Call LTP</th>
              <th className="px-2 py-1 text-center font-medium">Strike</th>
              <th className="px-2 py-1 text-right font-medium">Put LTP</th>
              <th className="px-2 py-1 text-right font-medium">Put OI</th>
            </tr>
          </thead>
          <tbody>
            {context.rows.map((row) => (
              <tr
                key={row.strike}
                className={
                  row.selected
                    ? 'bg-accent/10 font-semibold text-text'
                    : row.stepsFromSpot === 0
                      ? 'text-text'
                      : 'text-muted'
                }
              >
                <td className="px-2 py-0.5 text-right tabular-nums">
                  <OIBar value={row.callOI} max={maxOI} align="right" colour="#dc2626" />
                </td>
                <td className="px-2 py-0.5 text-right tabular-nums">{row.callLtp?.toFixed(1) ?? '—'}</td>
                <td className="px-2 py-0.5 text-center tabular-nums">
                  {row.strike}
                  {row.stepsFromSpot === 0 && <span className="ml-1 text-[9px] text-faint">ATM</span>}
                </td>
                <td className="px-2 py-0.5 text-right tabular-nums">{row.putLtp?.toFixed(1) ?? '—'}</td>
                <td className="px-2 py-0.5 text-right tabular-nums">
                  <OIBar value={row.putOI} max={maxOI} align="left" colour="#16a34a" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className="font-semibold text-text tabular-nums">{value}</dd>
    </div>
  );
}

/** A miniature OI bar behind the number, scaled within the visible window. */
function OIBar({ value, max, align, colour }: { value: number; max: number; align: 'left' | 'right'; colour: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <span className="relative inline-flex w-full items-center justify-end gap-1">
      <span
        aria-hidden
        className="absolute inset-y-0 opacity-20"
        style={{ width: `${pct}%`, backgroundColor: colour, [align]: 0 }}
      />
      <span className="relative">{value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(0)}</span>
    </span>
  );
}
