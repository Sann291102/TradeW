/**
 * Technical indicators for the Sentinel "Live Market Overview" indicator strip
 * (EMA 20 · RSI 14 · VWAP · MACD · OI change · IV rank).
 *
 * Every value here is computed from the REAL Dhan OHLCV candles the chart is
 * already drawing — nothing is invented. When a series is too short to compute
 * an indicator honestly (e.g. RSI needs >14 bars), the value is `null` and the
 * UI renders "—" rather than a fabricated reading. This mirrors the backend's
 * no-fabricated-data rule (see lib/hooks/useCandles.ts) on the client side.
 */

import type { Candle } from '@tradew/types';

export interface IndicatorStrip {
  /** last close, for the "Above / Below Price" EMA tag */
  lastClose: number | null;
  ema20: number | null;
  /** 'above' | 'below' price, or null when EMA is unavailable */
  ema20Position: 'above' | 'below' | null;
  rsi14: number | null;
  vwap: number | null;
  macd: { line: number; signal: number; histogram: number; bias: 'bullish' | 'bearish' } | null;
  /** session open-interest change %, when the feed carries OI; else null */
  oiChangePct: number | null;
}

/** Exponential moving average of the closes; null if fewer than `period` bars. */
export function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` closes, then smooth forward.
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
  }
  return prev;
}

/** Full EMA series (same length as input, leading nulls before it's defined). */
function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI over `period` bars; null if too few bars to be meaningful. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Session VWAP — volume-weighted average of the typical price, over the bars
 * belonging to the most recent trading day present in the series. Null when
 * there is no volume to weight by (index candles sometimes report zero volume).
 */
export function vwap(candles: Candle[]): number | null {
  if (!candles.length) return null;
  const last = candles[candles.length - 1];
  const lastDay = istDayKey(new Date(last.timestamp));
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    if (istDayKey(new Date(c.timestamp)) !== lastDay) continue;
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
  }
  if (vol <= 0) return null;
  return pv / vol;
}

/** MACD(12,26,9) on closes; null until there are enough bars for the signal. */
export function macd(closes: number[]): IndicatorStrip['macd'] {
  if (closes.length < 26 + 9) return null;
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macdLineSeries: (number | null)[] = closes.map((_, i) =>
    fast[i] != null && slow[i] != null ? (fast[i] as number) - (slow[i] as number) : null,
  );
  const defined = macdLineSeries.filter((v): v is number => v != null);
  const signalSeries = emaSeries(defined, 9);
  const line = defined[defined.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  if (line == null || signal == null) return null;
  const histogram = line - signal;
  return { line, signal, histogram, bias: histogram >= 0 ? 'bullish' : 'bearish' };
}

/** Day bucket in IST so VWAP resets on the correct session boundary. */
function istDayKey(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Build the whole indicator strip from a real candle series. */
export function buildIndicatorStrip(candles: Candle[] | null): IndicatorStrip {
  if (!candles || candles.length === 0) {
    return { lastClose: null, ema20: null, ema20Position: null, rsi14: null, vwap: null, macd: null, oiChangePct: null };
  }
  const closes = candles.map((c) => c.close);
  const lastClose = closes[closes.length - 1];
  const ema20 = ema(closes, 20);
  const ema20Position = ema20 == null ? null : lastClose >= ema20 ? 'above' : 'below';

  // OI change across the session, only when the feed actually carries OI.
  let oiChangePct: number | null = null;
  const withOi = candles.filter((c) => typeof c.openInterest === 'number' && (c.openInterest as number) > 0);
  if (withOi.length >= 2) {
    const first = withOi[0].openInterest as number;
    const last = withOi[withOi.length - 1].openInterest as number;
    if (first > 0) oiChangePct = ((last - first) / first) * 100;
  }

  return { lastClose, ema20, ema20Position, rsi14: rsi(closes, 14), vwap: vwap(candles), macd: macd(closes), oiChangePct };
}
