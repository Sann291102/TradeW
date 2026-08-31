/**
 * Indicator primitives for USER-WRITTEN strategies.
 *
 * ## Why these are not `intelligence/indicators.ts`
 *
 * They are faithful ports of `services/sentinel-py/app/watch/indicators.py`,
 * and faithfulness is the whole point: the same candles must produce the same
 * verdict in both engines, or a strategy a person watched in the workspace
 * would mean something else when an agent traded it.
 *
 * The existing `intelligence/indicators.ts` answers similar-sounding questions
 * with different definitions — `averageVolume` there includes the current bar
 * in its own baseline, where the Python `_volume_above_average` excludes it.
 * Sharing them would silently change what a user's rule means, so these live
 * apart and every difference from the Python original is a bug, not a choice.
 *
 * Every function here is pure over a candle list — no I/O, no state — for the
 * same reason the Python file gives: each can be tested against a hand-built
 * series rather than a market.
 *
 * ## Parity notes
 *
 * Python slices like `values[:period]` and `candles[-(period + 1) : -1]` have
 * exact TS equivalents, but the negative-index forms are the ones that go
 * wrong in translation. `candles.slice(-(period + 1), -1)` matches Python only
 * while `candles.length >= period + 1`; below that Python yields a shorter
 * window and TS yields an empty or misaligned one. Every function here guards
 * the length BEFORE slicing, exactly where the Python original does.
 */
import type { Candle } from '@tradew/types';

/**
 * Exponential moving average, seeded with the simple average of the first
 * `period` values.
 *
 * Returns one value per input from index `period - 1` onward, so a caller can
 * align it against the tail of the candle list. Shorter input returns empty
 * rather than a value computed from too little data — an "EMA-7" off three
 * candles is not an EMA-7.
 *
 * Port of `ema_series`. The seed matters: seeding with the first close instead
 * of the SMA of the first `period` closes produces a series that converges to
 * the same place but differs for the first several dozen bars, which is
 * precisely the window a short intraday history lives in.
 */
export function emaSeries(values: number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];

  const multiplier = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;

  const out: number[] = [seed];
  for (let i = period; i < values.length; i++) {
    const prev = out[out.length - 1];
    out.push((values[i] - prev) * multiplier + prev);
  }
  return out;
}

/** Port of `ema_of` — the EMA of closes. */
export function emaOf(candles: Candle[], period: number): number[] {
  return emaSeries(
    candles.map((c) => c.close),
    period,
  );
}

export type Slope = 'rising' | 'flat' | 'falling';

/**
 * Direction of an EMA over `lookback` steps.
 *
 * Normalised against ATR when one is supplied, so "rising" means the same
 * thing on a ₹200 option and a 24,000 index. Without ATR it falls back to a
 * relative threshold, which is weaker but never silently treats noise on a
 * large number as a trend.
 *
 * Port of `classify_slope`. The ±0.25 thresholds and the `lookback + 1` length
 * guard are load-bearing — a strategy gated on `ema7_rising` fires or does not
 * fire on exactly this boundary.
 */
export function classifySlope(emaValues: number[], lookback = 3, atrValue: number | null = null): Slope {
  if (emaValues.length < lookback + 1) return 'flat';

  const change = emaValues[emaValues.length - 1] - emaValues[emaValues.length - 1 - lookback];
  const scale = atrValue !== null && atrValue > 0 ? atrValue : Math.abs(emaValues[emaValues.length - 1]) * 0.001;
  if (scale <= 0) return 'flat';

  const normalised = change / scale;
  if (normalised > 0.25) return 'rising';
  if (normalised < -0.25) return 'falling';
  return 'flat';
}

/**
 * Average true range. `null` below `period + 1` candles rather than an average
 * of whatever happens to be there.
 *
 * Port of `atr`. Note the window: Python zips `candles[-period - 1 : -1]`
 * against `candles[-period:]`, so the true range of the NEWEST bar is included
 * and the oldest bar contributes only its close as the previous reference.
 */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  const previous = candles.slice(-period - 1, -1);
  const current = candles.slice(-period);
  const trs: number[] = [];
  for (let i = 0; i < Math.min(previous.length, current.length); i++) {
    const prev = previous[i];
    const cur = current[i];
    trs.push(
      Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)),
    );
  }
  if (trs.length === 0) return null;
  return trs.reduce((sum, tr) => sum + tr, 0) / trs.length;
}

/**
 * How a candle's BODY sat relative to a level.
 *
 * The distinction the EMA-7 setup rests on: a wick that pokes the EMA is not
 * the same event as a body that trades into it and closes back above. Wick-only
 * touches are extremely common and mean much less.
 *
 * Port of `BodyInteraction` / `body_interaction`.
 */
export interface BodyInteraction {
  touchedBody: boolean;
  touchedWick: boolean;
  closedAbove: boolean;
  closedBelow: boolean;
}

export function bodyInteraction(candle: Candle, level: number): BodyInteraction {
  const bodyLow = Math.min(candle.open, candle.close);
  const bodyHigh = Math.max(candle.open, candle.close);
  return {
    touchedBody: bodyLow <= level && level <= bodyHigh,
    touchedWick: candle.low <= level && level <= candle.high,
    closedAbove: candle.close > level,
    closedBelow: candle.close < level,
  };
}

export interface Reclaim {
  index: number;
  level: number;
  detail: string;
}

/**
 * Every bullish reclaim in the series, oldest first.
 *
 * Callers need the whole list rather than only the newest one: a candle that
 * follows through on an earlier reclaim can itself touch the EMA and qualify
 * as a reclaim. Returning only the most recent made the newest reclaim
 * permanently "still waiting", because the very candle that confirmed it
 * became the thing awaiting confirmation.
 *
 * Port of `find_bullish_reclaims`. Long-only by construction — there is no
 * bearish counterpart here, so a template that describes one side cannot be
 * quietly reused to justify the other.
 *
 * `offset` aligns the EMA series (which starts at candle index `period - 1`)
 * against the candle list. Getting it wrong shifts every level by a few bars
 * and produces reclaims that never happened.
 */
export function findBullishReclaims(candles: Candle[], emaValues: number[]): Reclaim[] {
  if (emaValues.length === 0) return [];

  const offset = candles.length - emaValues.length;
  const found: Reclaim[] = [];
  for (let i = offset; i < candles.length; i++) {
    const level = emaValues[i - offset];
    const interaction = bodyInteraction(candles[i], level);
    if (interaction.touchedBody && interaction.closedAbove) {
      found.push({
        index: i,
        level,
        detail: `body reached EMA ${level.toFixed(2)} and closed above at ${candles[i].close.toFixed(2)}`,
      });
    }
  }
  return found;
}

/** Port of `find_bullish_reclaim` — the most recent qualifying candle, or null. */
export function findBullishReclaim(candles: Candle[], emaValues: number[]): Reclaim | null {
  const reclaims = findBullishReclaims(candles, emaValues);
  return reclaims.length ? reclaims[reclaims.length - 1] : null;
}

/**
 * Latest volume against the trailing average, EXCLUDING the latest bar from
 * that average.
 *
 * Port of `_volume_above_average`. The exclusion is the part that differs from
 * `intelligence/indicators.ts`'s `averageVolume`, which slices `-lookback` and
 * so lets a huge bar lift its own baseline by a twentieth. Both are defensible;
 * only one matches what the user's rule meant when they wrote it.
 *
 * Returns `null` for "cannot be judged" — too little history, or an instrument
 * that reports no volume at all — which callers must surface as a refusal
 * rather than as a false.
 */
export function volumeAboveAverage(
  candles: Candle[],
  period = 20,
): { met: boolean; latest: number; average: number } | null {
  if (candles.length < period + 1) return null;
  const window = candles.slice(-(period + 1), -1);
  const average = window.reduce((sum, c) => sum + c.volume, 0) / window.length;
  if (average <= 0) return null;
  const latest = candles[candles.length - 1].volume;
  return { met: latest > average, latest, average };
}
