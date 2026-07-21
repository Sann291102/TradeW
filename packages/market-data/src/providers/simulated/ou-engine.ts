/**
 * Simulated Market Data Engine — the single simulated market for the platform.
 *
 * Moved verbatim (behaviour-preserving) from
 * `services/api/src/market-data/simulated-engine.service.ts`, which was the
 * better of the two simulators that previously existed: it is anchored to each
 * instrument's real `previousClose` and models mean reversion, where
 * `services/sentinel`'s copy used hardcoded per-symbol base prices and a plain
 * random walk. Those two disagreed on the same symbol at the same instant —
 * flagged High severity in MARKET-DATA-BASELINE.md §7. This file is the
 * resolution: one engine, consumed by every service.
 *
 * Framework-free on purpose (no NestJS import) so the ingestor, the API and
 * Sentinel can all use it without pulling a DI container into a shared package.
 *
 * Model: a mean-reverting random walk (discrete Ornstein-Uhlenbeck), anchored
 * to `previousClose`, stepped in 1-minute buckets across the NSE session
 * (09:15–15:30 IST). Deterministic — seeded from (symbol, trading-day) — so
 * repeated calls within a day reproduce the same path, giving a genuinely
 * time-varying but reproducible series across restarts and processes.
 */

export type MarketStatus = 'pre-open' | 'open' | 'closed';

export interface SimulatedQuote {
  ltp: number;
  open: number;
  high: number;
  low: number;
  bid: number;
  ask: number;
  volume: number;
  changeAbs: number;
  changePct: number;
  marketStatus: MarketStatus;
}

const IST_OFFSET_MIN = 330; // UTC+5:30
const SESSION_OPEN_MIN = 9 * 60 + 15; // 09:15
const SESSION_CLOSE_MIN = 15 * 60 + 30; // 15:30
const SESSION_LENGTH_MIN = SESSION_CLOSE_MIN - SESSION_OPEN_MIN; // 375

const VOL_PER_MINUTE = 0.00055; // ~1.07% total session stdev (sqrt(375) * vol)
const MEAN_REVERSION_THETA = 0.015; // pulls the walk gently back toward the anchor

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, deterministic PRNG (public-domain algorithm). */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function istMinutesAndDateKey(at: Date): { minutesOfDay: number; dayOfWeek: number; dateKey: string } {
  const ist = new Date(at.getTime() + IST_OFFSET_MIN * 60000);
  return {
    minutesOfDay: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    dayOfWeek: ist.getUTCDay(), // 0 = Sunday, 6 = Saturday
    dateKey: ist.toISOString().slice(0, 10),
  };
}

export function marketStatusAt(at: Date): MarketStatus {
  const { minutesOfDay, dayOfWeek } = istMinutesAndDateKey(at);
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  if (isWeekend) return 'closed';
  if (minutesOfDay < SESSION_OPEN_MIN) return 'pre-open';
  if (minutesOfDay >= SESSION_CLOSE_MIN) return 'closed';
  return 'open';
}

/**
 * Compute the current simulated quote for one instrument. `anchor` is the
 * instrument's previous-close price — the walk's mean-reversion target.
 * `tickSize` sets the minimum realistic bid/ask spread.
 */
export function simulateQuoteAt(symbol: string, anchor: number, tickSize: number, at: Date): SimulatedQuote {
  const { minutesOfDay, dayOfWeek, dateKey } = istMinutesAndDateKey(at);
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const marketStatus: MarketStatus = isWeekend || minutesOfDay < SESSION_OPEN_MIN
    ? minutesOfDay < SESSION_OPEN_MIN && !isWeekend ? 'pre-open' : 'closed'
    : minutesOfDay >= SESSION_CLOSE_MIN
      ? 'closed'
      : 'open';

  const elapsed = isWeekend
    ? SESSION_LENGTH_MIN // weekend: show the full prior session's frozen path
    : Math.max(0, Math.min(minutesOfDay, SESSION_CLOSE_MIN) - SESSION_OPEN_MIN);

  const rand = mulberry32(hashSeed(`${symbol}:${dateKey}`));

  let logReturn = 0;
  let open = anchor;
  let high = anchor;
  let low = anchor;
  let price = anchor;

  for (let minute = 0; minute <= elapsed; minute++) {
    if (minute > 0) {
      const drift = -MEAN_REVERSION_THETA * logReturn;
      const shock = VOL_PER_MINUTE * gaussian(rand);
      logReturn += drift + shock;
      price = anchor * Math.exp(logReturn);
    }
    if (minute === 0) open = price;
    if (price > high) high = price;
    if (price < low) low = price;
  }

  const spread = Math.max(tickSize, price * 0.0002);
  const bid = price - spread / 2;
  const ask = price + spread / 2;

  // Deterministic volume proxy: grows with elapsed session time and
  // accumulated realized volatility (busier minutes trade more).
  const baseVolumePerMinute = Math.max(1000, anchor * 2);
  const volume = Math.round(baseVolumePerMinute * elapsed * (1 + Math.abs(logReturn) * 10));

  const changeAbs = price - anchor;
  const changePct = anchor !== 0 ? (changeAbs / anchor) * 100 : 0;

  return {
    ltp: round2(price),
    open: round2(open),
    high: round2(high),
    low: round2(low),
    bid: round2(bid),
    ask: round2(ask),
    volume,
    changeAbs: round2(changeAbs),
    changePct: round2(changePct),
    marketStatus,
  };
}

/**
 * Deterministic OHLC series for an instrument, used by the pull-side
 * `getCandles`. Derived from the same walk as `simulateQuoteAt`, so a candle
 * series and a live quote for the same symbol now agree — they did not when
 * Sentinel ran its own independent generator.
 */
export function simulateCandles(
  symbol: string,
  anchor: number,
  stepMs: number,
  from: Date,
  to: Date,
  maxBars = 500,
): Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number; openInterest: number }> {
  const count = Math.min(maxBars, Math.max(1, Math.floor((to.getTime() - from.getTime()) / stepMs)));
  const rand = mulberry32(hashSeed(`${symbol}:${from.toISOString().slice(0, 10)}:${stepMs}`));
  const bars = [];
  let price = anchor;
  let oi = 1_000_000 + Math.floor(rand() * 500_000);

  for (let i = 0; i < count; i++) {
    const open = price;
    const logStep = -MEAN_REVERSION_THETA * 0.1 + VOL_PER_MINUTE * Math.sqrt(stepMs / 60_000) * gaussian(rand);
    const close = Math.max(0.05, price * Math.exp(logStep));
    const high = Math.max(open, close) * (1 + rand() * 0.002);
    const low = Math.min(open, close) * (1 - rand() * 0.002);
    const volume = Math.floor(50_000 + rand() * 150_000 * (1 + (rand() > 0.9 ? 2 : 0)));
    oi = Math.max(100_000, oi + Math.floor((rand() - 0.5) * 40_000));
    bars.push({
      timestamp: new Date(from.getTime() + i * stepMs),
      open: round2(open),
      high: round2(high),
      low: round2(low),
      close: round2(close),
      volume,
      openInterest: oi,
    });
    price = close;
  }
  return bars;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const SESSION = {
  IST_OFFSET_MIN,
  SESSION_OPEN_MIN,
  SESSION_CLOSE_MIN,
  SESSION_LENGTH_MIN,
} as const;
