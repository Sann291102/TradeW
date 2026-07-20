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
): Candle[] {
  const n = underlying.length;
  const bsType = optionType === 'CE' ? 'call' : 'put';

  return underlying.map((c, i) => {
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
}
