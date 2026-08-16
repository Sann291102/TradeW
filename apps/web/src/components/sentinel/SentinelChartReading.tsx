'use client';

import type { TimelineReading } from '@/lib/sentinel/sentinelPy';
import { fmt } from '@/lib/format';

/**
 * What Sentinel measured off the candles beside it.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The workspace could already say WHICH of the user's conditions were met. It
 * could never say what was measured to decide that. So "retest ✓" was
 * something to take on trust: the user saw a chart, Sentinel saw a chart, and
 * there was no way to tell whether they were looking at the same one — or at
 * anything at all, since a sweep that could not reach the market recorded a
 * skip that nothing surfaced.
 *
 * Every number here was recorded by `services/sentinel-py`'s poller at sweep
 * time (`measure_vwap`, `measure_flip`, `measure_zone`, …). Nothing is
 * recomputed in the browser — a second implementation would eventually
 * disagree with the engine, and a panel whose purpose is "check the engine's
 * work" cannot be the thing that is wrong.
 *
 * It reports; it does not advise. No row here says buy, sell, enter or target.
 */

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** `n ATR`, or nothing when the engine could not scale it. */
function atr(value: unknown): string | null {
  const n = num(value);
  return n == null ? null : `${n.toFixed(2)} ATR`;
}

function join(parts: (string | null)[]): string {
  return parts.filter(Boolean).join(' · ');
}

function istTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

/** One measurement, or null when the sweep did not produce it. */
function row(label: string, m: Record<string, unknown> | undefined, detail: (v: Record<string, unknown>) => string) {
  if (!m) return null;
  const value = detail(m);
  return value ? { label, value } : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function SentinelChartReading({ reading }: { reading: TimelineReading | null }) {
  if (!reading) {
    return (
      <Shell>
        <p className="text-[11.5px] text-faint">
          This watch has not been swept yet. Sentinel evaluates every 15 seconds while the market is open — nothing has
          been measured off these bars so far.
        </p>
      </Shell>
    );
  }

  const m = reading.measurements;
  const rows = [
    row('VWAP', asRecord(m.vwap), (v) =>
      join([
        num(v.vwap) == null ? null : fmt(num(v.vwap)!),
        text(v.testOrdinal) ? `${text(v.testOrdinal)} test` : null,
        text(v.deviationBucket),
        atr(v.deviationAtr),
      ]),
    ),
    row('Pullback', asRecord(m.pullback), (v) => join([text(v.classification), atr(v.depthAtr)])),
    row('Level flip', asRecord(m.flip), (v) =>
      join([
        num(v.price) == null ? null : `${text(v.kind) ?? 'level'} at ${fmt(num(v.price)!)}`,
        num(v.touches) == null ? null : `${num(v.touches)} touches`,
        num(v.ageBars) == null ? null : `${num(v.ageBars)} bars old`,
        text(v.stage) ? `stage: ${text(v.stage)}` : null,
        v.held === true ? 'held' : v.retested === true ? 'retested' : null,
      ]),
    ),
    row('Flag', asRecord(m.flag), (v) =>
      join([
        text(v.direction) ? `${text(v.direction)} impulse` : null,
        atr(v.impulseAtr),
        num(v.bars) == null ? null : `${num(v.bars)} bars`,
        v.brokeOut === true ? 'broke out' : 'still forming',
      ]),
    ),
    row('Zone', asRecord(m.zone), (v) =>
      join([
        num(v.bottom) != null && num(v.top) != null ? `${text(v.kind) ?? 'zone'} ${fmt(num(v.bottom)!)}–${fmt(num(v.top)!)}` : null,
        num(v.touches) == null ? null : `${num(v.touches)} touches`,
        v.fresh === true ? 'fresh' : null,
        num(v.score) == null ? null : `score ${num(v.score)}`,
      ]),
    ),
    row('Liquidity sweep', asRecord(m.liquidity), (v) =>
      join([
        num(v.poolPrice) == null ? null : `pool ${fmt(num(v.poolPrice)!)}`,
        num(v.poolTouches) == null ? null : `${num(v.poolTouches)} touches`,
        atr(v.penetrationAtr) ? `penetration ${atr(v.penetrationAtr)}` : null,
        v.structureShifted === true ? 'structure shifted' : null,
      ]),
    ),
  ].filter((r): r is { label: string; value: string } => r !== null);

  const or =
    reading.openingRangeHigh != null && reading.openingRangeLow != null
      ? `${fmt(reading.openingRangeLow)} – ${fmt(reading.openingRangeHigh)}`
      : null;

  const barTime = istTime(reading.candleTime);
  const sweptAt = istTime(reading.at);

  return (
    <Shell
      when={
        barTime
          ? `last bar read ${barTime} IST`
          : sweptAt
            ? `last swept ${sweptAt} IST`
            : null
      }
    >
      {/* The staleness warning comes FIRST and is never merged into the rows:
          numbers that are no longer current must not be read before the fact
          that they are no longer current. */}
      {reading.unreadable && (
        <p className="mb-2.5 rounded-lg border border-amber bg-amber-bg px-2.5 py-2 text-[11px] leading-relaxed text-amber">
          Sentinel could not read the market on its most recent sweep — {reading.unreadable} Anything below is the last
          reading that succeeded, not what is true now.
        </p>
      )}

      {or && (
        <p className="mb-2 text-[11px] text-muted">
          <span className="text-faint">Opening range</span> <span className="font-mono text-text">{or}</span>
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-[11.5px] leading-relaxed text-faint">
          {or
            ? 'No structure measured on this pass beyond the opening range.'
            : 'The sweep read these bars and measured no structure on this pass — no VWAP test, pullback, flip, flag, zone or sweep. That is a reading, not a failure.'}
        </p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-5 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <div key={r.label} className="min-w-0">
              <dt className="text-[9.5px] font-bold uppercase tracking-wideTrack text-faint">{r.label}</dt>
              <dd className="truncate text-[11.5px] text-text" title={r.value}>
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Shell>
  );
}

function Shell({ children, when }: { children: React.ReactNode; when?: string | null }) {
  return (
    <div className="mt-3 rounded-xl border border-border bg-bg p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-[10.5px] font-bold uppercase tracking-wideTrack text-faint">
          What Sentinel measured off these bars
        </p>
        {when && <span className="text-[10px] text-faint">{when}</span>}
      </div>
      {children}
    </div>
  );
}
