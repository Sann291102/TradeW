import type { Candle } from '@tradew/types';
import { fmt } from '@/lib/format';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-bg px-3 py-2">
      <div className="text-[10.5px] text-faint">{label}</div>
      <div className="font-mono text-sm font-semibold tabular-nums text-text">{value}</div>
    </div>
  );
}

/** Markets tab — quote detail (open/high/low/prev close/volume/52w range),
 *  derived from the same daily candle series the Technicals tab computes off. */
export function MarketsTab({ dailyCandles }: { dailyCandles: Candle[] }) {
  if (dailyCandles.length < 2) {
    return <p className="p-4 text-xs text-faint">Loading market detail…</p>;
  }
  const today = dailyCandles[dailyCandles.length - 1];
  const prev = dailyCandles[dailyCandles.length - 2];
  const year = dailyCandles.slice(-250);
  const high52w = Math.max(...year.map((c) => c.high));
  const low52w = Math.min(...year.map((c) => c.low));

  return (
    <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
      <Stat label="Open" value={fmt(today.open)} />
      <Stat label="High" value={fmt(today.high)} />
      <Stat label="Low" value={fmt(today.low)} />
      <Stat label="Prev. Close" value={fmt(prev.close)} />
      <Stat label="Volume" value={today.volume.toLocaleString('en-IN')} />
      <Stat label="52W Range" value={`${fmt(low52w)} – ${fmt(high52w)}`} />
    </div>
  );
}
