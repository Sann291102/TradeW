import type { Candle } from '@tradew/types';
import type { EmaCrossConfig } from './types';

/**
 * The user's EMA-cross scalp trigger, stated precisely so it can be *measured*.
 * "It's just EMA, no other thing" — so this is deliberately the bare rule; the
 * fake-spike filters (volume, body size, trend) are layered on separately in a
 * later phase, not baked in here.
 *
 * Chart legend from the user's reference screenshots:
 *   blue line   = EMA(period)
 *   blue candle = bullish (their "green"),  black candle = bearish (their "red")
 *
 * A LONG trigger fires at the close of bar `i` when:
 *   1. bar i is bullish ............... close > open        ("green candle")
 *   2. the EMA passes through bar i ... low <= ema_i <= high ("EMA crossing that candle")
 *   3. bar i closes above the EMA ..... close > ema_i        (reclaim / cross up)
 *   4. (optional, requireFreshCross) .. prevClose <= prevEma (a genuine cross, not mid-trend)
 *
 * Every clause uses only information available at the close of bar i — no
 * look-ahead. Reading ema[i] is safe: an EMA at index i depends only on
 * closes[0..i].
 */
export function isEmaCrossLong(
  candles: Candle[],
  ema: number[],
  i: number,
  cfg: EmaCrossConfig,
): boolean {
  if (i < 1) return false; // need a prior bar for clause 4 and for a next-bar fill
  const c = candles[i];
  const e = ema[i];

  const bullish = c.close > c.open;
  const emaThroughBar = c.low <= e && e <= c.high;
  const closesAbove = c.close > e;
  if (!(bullish && emaThroughBar && closesAbove)) return false;

  if (cfg.requireFreshCross) {
    const prev = candles[i - 1];
    const ePrev = ema[i - 1];
    if (prev.close > ePrev) return false; // prior bar already above the EMA — not a fresh cross
  }
  return true;
}
