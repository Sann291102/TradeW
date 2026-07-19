import { api } from './api';

/**
 * Real market-data client (Phase 2, Milestone 4, Step 2) — talks to
 * services/api's market-data module (GET /market-data/indices,
 * /market-data/quotes). Every value is server-computed by the Simulated
 * Market Data Engine (`source: 'simulated'` on every row) — see
 * services/api/src/market-data/simulated-engine.service.ts and
 * knowledge/Research/2026-07-18 - Market Data Step 2 for why: no live
 * provider (Dhan/TrueData) is wired into this repo yet.
 */

/** Mirrors services/api's DASHBOARD_INDEX_SYMBOLS (market-data.service.ts) — a
 *  literal constant, not logic, so this isn't the "duplicated API logic" the
 *  milestone forbids; it's just naming the same 5 symbols on both sides. */
export const DASHBOARD_INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'] as const;

export type MarketStatus = 'pre-open' | 'open' | 'closed';

export interface LiveQuote {
  instrumentId: string;
  symbol: string;
  displayName: string;
  ltp: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  close: number;
  bid: number;
  ask: number;
  volume: number;
  marketStatus: MarketStatus;
  updatedAt: string;
  source: 'simulated';
}

export async function fetchIndices(): Promise<LiveQuote[]> {
  return api('/market-data/indices');
}

export async function fetchQuotes(symbols: string[]): Promise<LiveQuote[]> {
  if (symbols.length === 0) return [];
  return api(`/market-data/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
}
