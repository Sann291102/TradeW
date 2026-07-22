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
