import type { Candle } from '@tradew/types';

/** Today's and previous session's daily candle, derived from the same real
 *  candle series `MarketsTab` computes off. Null until at least 2 daily bars
 *  have loaded — never partial-fills with a single bar. */
export function getDayStats(dailyCandles: Candle[]): { today: Candle; prev: Candle } | null {
  if (dailyCandles.length < 2) return null;
  return { today: dailyCandles[dailyCandles.length - 1], prev: dailyCandles[dailyCandles.length - 2] };
}

/**
 * High/low over the trailing `bars` daily candles. Returns null when fewer
 * bars are available than requested — per the app's no-fabricated-data rule,
 * a "1-Year Range" must not silently shrink to whatever partial history
 * happens to be loaded (see ChartPanel's `TF_CONFIG` comment on Dhan's ~245-bar
 * daily ceiling for why 3-year/5-year windows are never requested here at all).
 */
export function getRangeStats(dailyCandles: Candle[], bars: number): { high: number; low: number } | null {
  if (dailyCandles.length < bars) return null;
  const window = dailyCandles.slice(-bars);
  return {
    high: Math.max(...window.map((c) => c.high)),
    low: Math.min(...window.map((c) => c.low)),
  };
}
