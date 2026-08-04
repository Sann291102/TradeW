import type { Candle } from '@tradew/types';
import { cpr, ema } from '../../intelligence/indicators';

/**
 * Full indicator *series* for plotting.
 *
 * `intelligence/indicators.ts` returns the latest scalar because that is what
 * signal evaluation needs — "RSI is 62 right now". A chart needs the whole
 * curve. Rather than change that module (which the existing orchestrator
 * depends on), this one composes it: `ema` is imported and reused verbatim,
 * and only the genuinely missing series are implemented here.
 *
 * Every function returns one point per input bar, with `null` where the
 * indicator has not warmed up yet. Aligning lengths this way means the client
 * can zip a series against the candle array by index and never has to reason
 * about offsets — the single most common source of an indicator drawn one bar
 * out of alignment.
 */

export interface SeriesPoint {
  time: number;
  value: number | null;
}

/** Exponential moving average, reusing the existing implementation. */
export function emaSeries(candles: Candle[], period: number): SeriesPoint[] {
  const closes = candles.map((c) => c.close);
  const values = ema(closes, period);
  return candles.map((candle, i) => ({
    time: candle.timestamp.getTime(),
    // The EMA seed is the first close, which is not a meaningful average until
    // roughly `period` bars have contributed. Nulling the warm-up keeps a
    // misleading early curve off the chart.
    value: i < period - 1 ? null : (values[i] ?? null),
  }));
}

/**
 * Session-anchored VWAP.
 *
 * Resets at each new trading day, which is what makes VWAP meaningful: a VWAP
 * accumulated across days is a slow moving average with a volume tilt, not the
 * session's fair-value reference that traders actually use.
 */
export function vwapSeries(candles: Candle[]): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  let cumulativePV = 0;
  let cumulativeVolume = 0;
  let currentDay = '';

  for (const candle of candles) {
    const day = candle.timestamp.toDateString();
    if (day !== currentDay) {
      currentDay = day;
      cumulativePV = 0;
      cumulativeVolume = 0;
    }
    const typical = (candle.high + candle.low + candle.close) / 3;
    cumulativePV += typical * candle.volume;
    cumulativeVolume += candle.volume;
    out.push({
      time: candle.timestamp.getTime(),
      value: cumulativeVolume > 0 ? cumulativePV / cumulativeVolume : null,
    });
  }
  return out;
}

/**
 * Wilder's RSI.
 *
 * Uses Wilder smoothing rather than the simple average in
 * `indicators.ts#rsi` — that function computes a rolling simple-average RSI
 * suitable for a point-in-time threshold check, but plotted as a series it
 * produces visible steps as values enter and leave the window. Wilder's
 * smoothing is what every charting package draws, so the curve here matches
 * what a trader sees on TradingView.
 */
export function rsiSeries(candles: Candle[], period = 14): SeriesPoint[] {
  const out: SeriesPoint[] = candles.map((c) => ({ time: c.timestamp.getTime(), value: null }));
  if (candles.length <= period) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = { time: candles[period].timestamp.getTime(), value: rsiFrom(avgGain, avgLoss) };

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = { time: candles[i].timestamp.getTime(), value: rsiFrom(avgGain, avgLoss) };
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export interface MacdSeries {
  macd: SeriesPoint[];
  signal: SeriesPoint[];
  histogram: SeriesPoint[];
}

/**
 * MACD(12, 26, 9).
 *
 * The signal line is an EMA of the MACD line over its full history, not over a
 * trailing slice. `indicators.ts#macd` slices before smoothing, which is fine
 * for the latest scalar it returns but would make a plotted signal line depend
 * on where the slice happened to start.
 */
export function macdSeries(candles: Candle[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
  const times = candles.map((c) => c.timestamp.getTime());
  const closes = candles.map((c) => c.close);

  if (candles.length < slow + signalPeriod) {
    const empty = times.map((time) => ({ time, value: null }));
    return { macd: empty, signal: [...empty], histogram: [...empty] };
  }

  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine = closes.map((_, i) => fastEma[i] - slowEma[i]);
  const signalLine = ema(macdLine, signalPeriod);

  const warmup = slow - 1;
  return {
    macd: times.map((time, i) => ({ time, value: i < warmup ? null : macdLine[i] })),
    signal: times.map((time, i) => ({ time, value: i < warmup + signalPeriod - 1 ? null : signalLine[i] })),
    histogram: times.map((time, i) => ({
      time,
      value: i < warmup + signalPeriod - 1 ? null : macdLine[i] - signalLine[i],
    })),
  };
}

export interface CprLevels {
  pivot: number;
  bc: number;
  tc: number;
  /** R1–R3 / S1–S3, the standard floor-trader extensions. */
  resistance: number[];
  support: number[];
}

/**
 * Central Pivot Range plus classic floor-trader levels from the prior session.
 *
 * The CPR itself is delegated to the existing `cpr()` so the pivot/BC/TC a
 * trader sees drawn is byte-identical to the one the strategy rules evaluate
 * against. Two implementations of the same level would eventually disagree,
 * and the chart would then contradict the reasoning drawn on it.
 */
export function cprLevels(priorDay: Candle | null): CprLevels | null {
  if (!priorDay) return null;
  const { pivot, bc, tc } = cpr(priorDay);
  const range = priorDay.high - priorDay.low;

  return {
    pivot,
    bc,
    tc,
    resistance: [
      pivot * 2 - priorDay.low,
      pivot + range,
      priorDay.high + 2 * (pivot - priorDay.low),
    ],
    support: [
      pivot * 2 - priorDay.high,
      pivot - range,
      priorDay.low - 2 * (priorDay.high - pivot),
    ],
  };
}

/** Average True Range — the distance unit projections are measured in. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const current = candles[i];
    const previousClose = candles[i - 1].close;
    sum += Math.max(
      current.high - current.low,
      Math.abs(current.high - previousClose),
      Math.abs(current.low - previousClose),
    );
  }
  return sum / period;
}

/** Drop null-valued warm-up points — the shape a chart client wants to plot. */
export function compact(series: SeriesPoint[]): { time: number; value: number }[] {
  return series.filter((p): p is { time: number; value: number } => p.value !== null);
}
