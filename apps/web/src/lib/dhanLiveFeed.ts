const DHAN_LIVE_URL = process.env.NEXT_PUBLIC_DHAN_LIVE_URL || 'http://localhost:4600';

/**
 * Client for the standalone Dhan live-feed bridge
 * (services/market-data/scripts/live-feed-server.ts) — a read-only, no-DB,
 * no-auth server that wraps the real `DhanMarketFeed` client so the dashboard
 * can show genuine broker ticks without Postgres or a login. Separate from
 * `marketData.ts`, which talks to services/api's DB-backed, auth-gated,
 * simulated-engine routes.
 */

export interface DhanLiveQuote {
  instrumentId: string;
  symbol: string;
  displayName: string;
  ltp: number;
  change: number;
  changePct: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  bid: number;
  ask: number;
  volume: number;
  marketStatus: 'open' | 'closed';
  updatedAt: string;
  source: 'dhan';
}

export interface DhanLiveSnapshot {
  marketOpen: boolean;
  indices: DhanLiveQuote[];
  stocks: DhanLiveQuote[];
  etfs: DhanLiveQuote[];
  commodities: DhanLiveQuote[];
}

export async function fetchDhanQuotes(): Promise<DhanLiveSnapshot> {
  const res = await fetch(`${DHAN_LIVE_URL}/quotes`);
  if (!res.ok) throw new Error(`dhan live-feed bridge returned ${res.status}`);
  return res.json();
}

/** One real OHLC candle from Dhan's Historical Data API (timestamp in ms). */
export interface DhanCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Real historical candles for the TradingView (lightweight-charts) charts,
 * from the bridge's `/candles` route (which proxies Dhan's charged, cached
 * Historical Data REST API). Returns [] for symbols the bridge doesn't cover
 * or on any error, so the caller falls back to simulated candles.
 */
export async function fetchDhanCandles(symbol: string, interval: string, days: number): Promise<DhanCandle[]> {
  const url = `${DHAN_LIVE_URL}/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&days=${days}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as { candles?: DhanCandle[]; source?: string };
  return data.source === 'dhan' && Array.isArray(data.candles) ? data.candles : [];
}

/**
 * REAL OHLC for one option contract, from the bridge's `/candles/option` route
 * (Dhan's historical API addressed by the contract's own securityId, resolved
 * out of the scrip master).
 *
 * This replaces the Black-Scholes-derived stand-in the contract chart used to
 * draw. That series could only approximate the shape, and once its scale anchor
 * drifted from the live premium it rendered a visible cliff at the final bar.
 * Returns [] when the contract can't be resolved or Dhan declines, so the
 * caller can fall back and say so.
 */
export async function fetchDhanOptionCandles(
  symbol: string,
  expiryIso: string,
  strike: number,
  optionType: 'CE' | 'PE',
  interval: string,
  days: number,
): Promise<DhanCandle[]> {
  const url =
    `${DHAN_LIVE_URL}/candles/option?symbol=${encodeURIComponent(symbol)}` +
    `&expiry=${encodeURIComponent(expiryIso)}&strike=${strike}&type=${optionType}` +
    `&interval=${encodeURIComponent(interval)}&days=${days}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { candles?: DhanCandle[]; source?: string };
    return data.source === 'dhan' && Array.isArray(data.candles) ? data.candles : [];
  } catch {
    return [];
  }
}

/** One option leg (CE or PE) from Dhan's real Option Chain API. */
export interface DhanOptionLeg {
  ltp: number;
  previousClose: number;
  oi: number;
  previousOi: number;
  volume: number;
  previousVolume: number;
  iv: number;
  bid: number;
  ask: number;
  delta: number | null;
  theta: number | null;
  gamma: number | null;
  vega: number | null;
}

export interface DhanOptionStrike {
  strike: number;
  ce: DhanOptionLeg | null;
  pe: DhanOptionLeg | null;
}

export interface DhanOptionChain {
  spot: number | null;
  strikes: DhanOptionStrike[];
}

/**
 * Real expiry dates (ISO `YYYY-MM-DD`) for an underlying's option chain, from
 * the bridge's `/optionchain/expirylist` route (proxying Dhan's Option Chain
 * API, server-side rate-limited — see live-feed-server.ts). Returns [] for
 * symbols with no options market (ETFs, commodities) or if unreachable, so
 * the caller falls back to the simulated expiry table.
 */
export async function fetchDhanExpiryList(symbol: string): Promise<string[]> {
  try {
    const res = await fetch(`${DHAN_LIVE_URL}/optionchain/expirylist?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { expiries?: string[] };
    return data.expiries ?? [];
  } catch {
    return [];
  }
}

/**
 * Whether `symbol` has a live options market at all — the same
 * `/optionchain/expirylist` call as `fetchDhanExpiryList`, but distinguishing
 * "confirmed no options" (`false`) from "couldn't determine right now"
 * (`null`, e.g. bridge unreachable). That distinction matters to callers
 * that cache the result: a confirmed no is safe to cache indefinitely for
 * the session, an unknown is not (retry later instead of caching a false
 * negative). See useHasOptionChain, which is the actual consumer.
 */
export async function fetchDhanHasOptionChain(symbol: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${DHAN_LIVE_URL}/optionchain/expirylist?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) {
      console.error(`fetchDhanHasOptionChain(${symbol}): bridge returned ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { expiries?: string[]; error?: string };
    if (data.error) {
      console.error(`fetchDhanHasOptionChain(${symbol}): ${data.error}`);
      return null;
    }
    return Array.isArray(data.expiries) && data.expiries.length > 0;
  } catch (err) {
    console.error(`fetchDhanHasOptionChain(${symbol}): unreachable`, err);
    return null;
  }
}

/**
 * Real option chain (spot + every strike's CE/PE — OI, volume, LTP, IV, real
 * Greeks) for an underlying + expiry, from the bridge's `/optionchain`
 * route. Returns null on any failure/empty result so the caller falls back
 * to the simulated chain.
 */
export async function fetchDhanOptionChain(symbol: string, expiryIso: string): Promise<DhanOptionChain | null> {
  try {
    const res = await fetch(`${DHAN_LIVE_URL}/optionchain?symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiryIso)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as DhanOptionChain & { error?: string };
    if (data.error || !Array.isArray(data.strikes) || data.strikes.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}
