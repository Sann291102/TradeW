import { Candle } from '@tradew/types';

/** Pure indicator math — deterministic, dependency-free, unit-testable. */

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

export function vwap(candles: Candle[]): number | null {
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
  }
  return vol === 0 ? null : pv / vol;
}

export function macd(closes: number[]): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < 35) return null;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine.slice(-9 * 3), 9);
  const m = macdLine[macdLine.length - 1];
  const s = signalLine[signalLine.length - 1];
  return { macd: m, signal: s, histogram: m - s };
}

/** Central Pivot Range from the prior candle (typically prior day). */
export function cpr(prior: Candle): { pivot: number; bc: number; tc: number } {
  const pivot = (prior.high + prior.low + prior.close) / 3;
  const bc = (prior.high + prior.low) / 2;
  const tc = pivot * 2 - bc;
  return { pivot, bc: Math.min(bc, tc), tc: Math.max(bc, tc) };
}

export function averageVolume(candles: Candle[], lookback = 20): number {
  const window = candles.slice(-lookback);
  if (window.length === 0) return 0;
  return window.reduce((s, c) => s + c.volume, 0) / window.length;
}

/** Simple swing high/low over a lookback window (excludes the last candle). */
export function swingLevels(candles: Candle[], lookback = 20): { resistance: number; support: number } | null {
  const window = candles.slice(-(lookback + 1), -1);
  if (window.length < 5) return null;
  return {
    resistance: Math.max(...window.map((c) => c.high)),
    support: Math.min(...window.map((c) => c.low)),
  };
}

export function realizedVolatilityPct(closes: number[], lookback = 20): number | null {
  if (closes.length < lookback + 1) return null;
  const returns: number[] = [];
  for (let i = closes.length - lookback; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * 100;
}

export function oiTrend(candles: Candle[], lookback = 10): 'rising' | 'falling' | 'flat' | 'unknown' {
  const withOi = candles.slice(-lookback).filter((c) => c.openInterest !== undefined);
  if (withOi.length < 3) return 'unknown';
  const first = withOi[0].openInterest!;
  const last = withOi[withOi.length - 1].openInterest!;
  const change = (last - first) / first;
  if (change > 0.02) return 'rising';
  if (change < -0.02) return 'falling';
  return 'flat';
}
