import type { Candle } from '@tradew/types';
import { cn } from '@tradew/ui';
import { fmt } from '@/lib/format';
import { classicPivots, sma, smaSignal, technicalIndicators, type Signal } from '@/lib/technicals';

const SMA_PERIODS = [5, 10, 20, 50, 100, 200] as const;

function SignalTag({ signal }: { signal: Signal }) {
  return (
    <span className={cn('font-semibold', signal === 'Bullish' ? 'text-up' : signal === 'Bearish' ? 'text-down' : 'text-faint')}>
      {signal}
    </span>
  );
}

function PivotRow({ label, value, tone }: { label: string; value: number; tone: 'r' | 's' | 'pivot' }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between rounded px-2.5 py-1.5 text-[11.5px]',
        tone === 'pivot' && 'bg-amber-bg font-semibold text-amber',
        tone === 'r' && 'text-down',
        tone === 's' && 'text-up',
      )}
    >
      <span>{label}</span>
      <span className="font-mono tabular-nums">{fmt(value)}</span>
    </div>
  );
}

/** Technicals tab — classic pivot levels + moving-average table + an
 *  aggregate oscillator sentiment bar, all computed from real candle data
 *  (apps/web/src/lib/technicals.ts), not hardcoded. */
export function TechnicalsTab({ dailyCandles, ltp }: { dailyCandles: Candle[]; ltp: number }) {
  if (dailyCandles.length < 30) {
    return <p className="p-4 text-xs text-faint">Loading technicals…</p>;
  }

  const prevDay = dailyCandles[dailyCandles.length - 2];
  const pivots = classicPivots(prevDay.high, prevDay.low, prevDay.close);
  const closes = dailyCandles.map((c) => c.close);
  const smaRows = SMA_PERIODS.map((period) => {
    const value = sma(closes, period);
    return { period, value, signal: smaSignal(ltp, value) };
  });
  const indicators = technicalIndicators(dailyCandles);
  const bearish = indicators.filter((i) => i.signal === 'Bearish').length;
  const bullish = indicators.filter((i) => i.signal === 'Bullish').length;
  const neutral = indicators.length - bearish - bullish;
  const total = indicators.length;

  return (
    <div className="space-y-4 p-3">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-bg p-3">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Pivot Levels · Classic</h4>
          <div className="space-y-0.5">
            <PivotRow label="R3" value={pivots.r3} tone="r" />
            <PivotRow label="R2" value={pivots.r2} tone="r" />
            <PivotRow label="R1" value={pivots.r1} tone="r" />
            <PivotRow label="Pivot" value={pivots.pivot} tone="pivot" />
            <PivotRow label="S1" value={pivots.s1} tone="s" />
            <PivotRow label="S2" value={pivots.s2} tone="s" />
            <PivotRow label="S3" value={pivots.s3} tone="s" />
          </div>
        </div>

        <div className="rounded-xl border border-border bg-bg p-3">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Moving Average</h4>
          <table className="w-full text-[11.5px]">
            <thead className="text-faint">
              <tr className="border-b border-border">
                <th className="py-1 text-left font-semibold">Period</th>
                <th className="py-1 text-right font-semibold">Value</th>
                <th className="py-1 text-right font-semibold">Signal</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {smaRows.map((r) => (
                <tr key={r.period} className="border-b border-border">
                  <td className="py-1 text-left text-muted">{r.period}-SMA</td>
                  <td className="py-1 text-right text-text">{r.value != null ? fmt(r.value) : '—'}</td>
                  <td className="py-1 text-right"><SignalTag signal={r.signal} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-bg p-3">
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Technical Indicators</h4>
        <div className="flex items-center justify-between text-[11.5px]">
          <span className="text-down">Bearish <b>{bearish}</b></span>
          <span className="text-faint">Neutral <b>{neutral}</b></span>
          <span className="text-up">Bullish <b>{bullish}</b></span>
        </div>
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-border">
          <div className="h-full bg-down" style={{ width: `${(bearish / total) * 100}%` }} />
          <div className="h-full bg-faint" style={{ width: `${(neutral / total) * 100}%` }} />
          <div className="h-full bg-up" style={{ width: `${(bullish / total) * 100}%` }} />
        </div>
        <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted sm:grid-cols-3">
          {indicators.map((ind) => (
            <li key={ind.name} className="flex items-center justify-between">
              <span>{ind.name}</span>
              <SignalTag signal={ind.signal} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
