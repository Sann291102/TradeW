import type { Candle, CandleInterval, MarketDataProvider } from '@tradew/types';

/** IST is a fixed +05:30 with no DST, so a constant offset is exact for NSE. */
const IST_OFFSET_MS = 5.5 * 3_600_000;
/** NSE equity/index session, in minutes from IST midnight: 09:15 -> 15:30. */
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;

const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};

/** UTC ms of IST midnight, `dayOffset` calendar days before `refMs`. */
function istMidnightMs(refMs: number, dayOffset: number): number {
  const ist = new Date(refMs + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return ist.getTime() - IST_OFFSET_MS - dayOffset * 86_400_000;
}

function istWeekday(ms: number): number {
  return new Date(ms + IST_OFFSET_MS).getUTCDay(); // 0 Sun … 6 Sat
}

/**
 * Timestamps for `count` candles ending at the most recent completed slot.
 *
 * Bars are anchored to the session open and stepped by the interval, so a 15m
 * candle always lands on 09:15 / 09:30 / 09:45 … and a 1m candle is exactly one
 * minute — and nothing is emitted outside 09:15–15:30 IST or on a weekend.
 * The previous version simply walked back from `now` in fixed steps, which
 * produced bars at arbitrary offsets (…11:33, 14:33, 17:33…) running straight
 * through the night, as if the exchange never closed.
 */
function sessionTimestamps(interval: CandleInterval, count: number, nowMs: number): number[] {
  const step = INTERVAL_MS[interval];

  if (interval === '1d') {
    const daily: number[] = [];
    for (let d = 0; daily.length < count && d < count * 3 + 30; d++) {
      const midnight = istMidnightMs(nowMs, d);
      const dow = istWeekday(midnight);
      if (dow === 0 || dow === 6) continue;
      daily.push(midnight + SESSION_OPEN_MIN * 60_000);
    }
    return daily.reverse();
  }

  const out: number[] = [];
  // Walk back day by day, collecting each session's slots, until we have enough.
  for (let d = 0; out.length < count && d < 400; d++) {
    const midnight = istMidnightMs(nowMs, d);
    const dow = istWeekday(midnight);
    if (dow === 0 || dow === 6) continue;
    const open = midnight + SESSION_OPEN_MIN * 60_000;
    const close = midnight + SESSION_CLOSE_MIN * 60_000;
    const slots: number[] = [];
    for (let t = open; t < close; t += step) {
      if (t <= nowMs) slots.push(t);
    }
    out.unshift(...slots); // older days end up earlier in the array
  }
  return out.slice(-count);
}

/**
 * Deterministic mock OHLCV generator — the interim candle source behind
 * `TradeChart`/`useCandles` until a real provider (Dhan, per
 * docs/product-architecture/) is wired into services/api (no `Candle` model
 * exists there yet). Only implements `getCandles`, the one method this
 * phase's chart consumes — a real `MarketDataProvider` swaps in at the
 * `useCandles` call site later without this file changing shape.
 *
 * Seeded-random-walk approach mirrors services/sentinel's
 * `SimMarketDataProvider` so mock candles look consistent with the rest of
 * the platform's simulated data.
 */
export const mockMarketDataProvider: Pick<MarketDataProvider, 'getCandles'> & {
  getCandles(symbol: string, interval: CandleInterval, from: Date, to: Date, anchorPrice?: number): Promise<Candle[]>;
} = {
  /**
   * `anchorPrice` (optional): when the caller has a real live LTP (the Dhan
   * live-feed bridge, for the 5 symbols it covers — see useDhanLiveFeed), the
   * whole generated series is rescaled multiplicatively so its last close
   * lands exactly on that real price. History is still simulated (no real
   * intraday backfill exists — DHAN-MARKET-DATA-INTEGRATION.md Phase 3 isn't
   * built), but the chart then agrees with the live number shown everywhere
   * else instead of drifting on its own hardcoded baseline.
   */
  async getCandles(symbol: string, interval: CandleInterval, from: Date, to: Date, anchorPrice?: number): Promise<Candle[]> {
    const step = INTERVAL_MS[interval];
    const count = Math.min(500, Math.max(1, Math.floor((to.getTime() - from.getTime()) / step)));
    // Real, session-aligned IST timestamps rather than a flat walk back from
    // `now` — see sessionTimestamps.
    const stamps = sessionTimestamps(interval, count, to.getTime());

    let seed = 0;
    for (const c of symbol) seed = (seed * 31 + c.charCodeAt(0)) | 0;
    seed = Math.abs(seed) + 1;
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    const rand = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };

    let price = symbol.includes('BANKNIFTY') ? 52700 : symbol.includes('NIFTY') ? 24850 : 500 + (seed % 3000);
    const candles: Candle[] = [];
    for (let i = 0; i < stamps.length; i++) {
      const drift = (rand() - 0.5) * 0.004 * price;
      const open = price;
      const close = Math.max(1, price + drift);
      const high = Math.max(open, close) * (1 + rand() * 0.002);
      const low = Math.min(open, close) * (1 - rand() * 0.002);
      const volume = Math.floor(50_000 + rand() * 150_000);
      candles.push({ timestamp: new Date(stamps[i]), open, high, low, close, volume });
      price = close;
    }

    if (anchorPrice && candles.length > 0) {
      const scale = anchorPrice / candles[candles.length - 1].close;
      for (const c of candles) {
        c.open *= scale;
        c.high *= scale;
        c.low *= scale;
        c.close *= scale;
      }
    }

    return candles;
  },
};
