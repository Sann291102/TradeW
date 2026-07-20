import type { Candle } from '@tradew/types';

/**
 * Technical-analysis math — pure functions over OHLC candle data. Standard,
 * industry-common formulas (RSI/MACD/pivots/etc. are not any one platform's
 * IP); this is our own implementation, not lifted from a reference UI.
 * Consumed by the Trade dock's Technicals tab.
 */

export interface PivotLevels {
  r3: number;
  r2: number;
  r1: number;
  pivot: number;
  s1: number;
  s2: number;
  s3: number;
}

/** Classic pivot points from the prior period's H/L/C. */
export function classicPivots(prevHigh: number, prevLow: number, prevClose: number): PivotLevels {
  const pivot = (prevHigh + prevLow + prevClose) / 3;
  const range = prevHigh - prevLow;
  return {
    pivot,
    r1: 2 * pivot - prevLow,
    r2: pivot + range,
    r3: prevHigh + 2 * (pivot - prevLow),
    s1: 2 * pivot - prevHigh,
    s2: pivot - range,
    s3: prevLow - 2 * (prevHigh - pivot),
  };
}

export function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  return window.reduce((a, b) => a + b, 0) / period;
}

export type Signal = 'Bullish' | 'Bearish' | 'Neutral';

/** LTP vs SMA — the standard trend-following read. */
export function smaSignal(ltp: number, smaValue: number | null): Signal {
  if (smaValue == null) return 'Neutral';
  return ltp > smaValue ? 'Bullish' : ltp < smaValue ? 'Bearish' : 'Neutral';
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

export function macdHistogram(closes: number[]): number | null {
  if (closes.length < 35) return null;
  const emaFast = ema(closes, 12);
  const emaSlow = ema(closes, 26);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine.slice(-Math.min(macdLine.length, 100)), 9);
  return macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];
}

export function stochasticK(candles: Candle[], period = 14): number | null {
  if (candles.length < period) return null;
  const window = candles.slice(-period);
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const close = window[window.length - 1].close;
  if (high === low) return 50;
  return ((close - low) / (high - low)) * 100;
}

export function williamsR(candles: Candle[], period = 14): number | null {
  const k = stochasticK(candles, period);
  return k == null ? null : k - 100;
}

export function roc(closes: number[], period = 12): number | null {
  if (closes.length < period + 1) return null;
  const past = closes[closes.length - 1 - period];
  const now = closes[closes.length - 1];
  if (past === 0) return null;
  return ((now - past) / past) * 100;
}

export function cci(candles: Candle[], period = 20): number | null {
  if (candles.length < period) return null;
  const window = candles.slice(-period);
  const typical = window.map((c) => (c.high + c.low + c.close) / 3);
  const meanTp = typical.reduce((a, b) => a + b, 0) / period;
  const meanDev = typical.reduce((a, b) => a + Math.abs(b - meanTp), 0) / period;
  if (meanDev === 0) return 0;
  return (typical[typical.length - 1] - meanTp) / (0.015 * meanDev);
}

export interface IndicatorReading {
  name: string;
  value: number | null;
  signal: Signal;
}

/** Aggregate oscillator/momentum readings into the bearish/neutral/bullish
 *  tri-count shown on the Technicals tab. */
export function technicalIndicators(candles: Candle[]): IndicatorReading[] {
  const closes = candles.map((c) => c.close);
  const rsiVal = rsi(closes);
  const macdVal = macdHistogram(closes);
  const stoch = stochasticK(candles);
  const wr = williamsR(candles);
  const rocVal = roc(closes);
  const cciVal = cci(candles);

  const sig = (v: number | null, bullish: boolean, bearish: boolean): Signal => {
    if (v == null) return 'Neutral';
    if (bullish) return 'Bullish';
    if (bearish) return 'Bearish';
    return 'Neutral';
  };

  return [
    { name: 'RSI (14)', value: rsiVal, signal: sig(rsiVal, (rsiVal ?? 50) < 30, (rsiVal ?? 50) > 70) },
    { name: 'MACD (12,26,9)', value: macdVal, signal: sig(macdVal, (macdVal ?? 0) > 0, (macdVal ?? 0) < 0) },
    { name: 'Stochastic %K', value: stoch, signal: sig(stoch, (stoch ?? 50) < 20, (stoch ?? 50) > 80) },
    { name: 'Williams %R', value: wr, signal: sig(wr, (wr ?? -50) < -80, (wr ?? -50) > -20) },
    { name: 'ROC (12)', value: rocVal, signal: sig(rocVal, (rocVal ?? 0) > 0, (rocVal ?? 0) < 0) },
    { name: 'CCI (20)', value: cciVal, signal: sig(cciVal, (cciVal ?? 0) > 100, (cciVal ?? 0) < -100) },
  ];
}
