import type { Candle } from '@tradew/types';
import { blackScholesPrice } from '@/lib/black-scholes';

/**
 * Derives a synthetic option-premium candle series from the underlying's
 * real mock candles via Black-Scholes repricing — there's no per-contract
 * candle feed to poll, but this isn't fabricated data either: every OHLC
 * value is the actual theoretical price of THIS strike at the underlying's
 * actual OHLC for that bar, using a linearly-decaying time-to-expiry across
 * the series. Reused by ChartPanel's contract mode.
 */
export function deriveOptionCandles(
  underlying: Candle[],
  strike: number,
  optionType: 'CE' | 'PE',
  yearsToExpiryAtStart: number,
  ivPct: number,
  /** Real, live premium for this contract (Dhan option chain). When given, the
   *  whole derived series is rescaled so its FINAL close lands exactly on this
   *  price — the shape stays Black-Scholes-derived but the number the user
   *  reads matches the Option Chain instead of contradicting it. Without this
   *  the chart showed a theoretical premium (e.g. ~220) next to a chain LTP of
   *  160.75 for the same strike. */
  anchorLastTo?: number,
): Candle[] {
  const n = underlying.length;
  const bsType = optionType === 'CE' ? 'call' : 'put';

  const series = underlying.map((c, i) => {
    // linearly decay remaining time across the series, never hitting exactly 0
    const remaining = Math.max(yearsToExpiryAtStart * (1 - i / n), 1 / 3650);
    const price = (spot: number) => blackScholesPrice(spot, strike, remaining, ivPct, bsType);

    const openPx = price(c.open);
    const closePx = price(c.close);
    // calls rise with spot (high-spot -> high premium); puts fall with spot
    // (high-spot -> low premium) — map high/low through the correct side.
    const highPx = optionType === 'CE' ? price(c.high) : price(c.low);
    const lowPx = optionType === 'CE' ? price(c.low) : price(c.high);

    return {
      timestamp: c.timestamp,
      open: openPx,
      high: Math.max(highPx, openPx, closePx),
      low: Math.max(0.05, Math.min(lowPx, openPx, closePx)),
      close: closePx,
      volume: c.volume,
    };
  });

  // Rescale onto the real premium. A single multiplicative factor keeps every
  // bar's proportions (and therefore the series' shape) intact while making the
  // last close exactly the live chain price. Guarded against a zero/absent
  // theoretical close, which would otherwise produce Infinity.
  const lastClose = series[series.length - 1]?.close;
  if (anchorLastTo != null && anchorLastTo > 0 && lastClose && lastClose > 0) {
    const factor = anchorLastTo / lastClose;
    return series.map((c) => ({
      ...c,
      open: c.open * factor,
      high: c.high * factor,
      low: c.low * factor,
      close: c.close * factor,
    }));
  }
  return series;
}
