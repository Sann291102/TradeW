import { api } from './api';

/**
 * Global-markets client — the surfaces served by providers other than Dhan.
 *
 *   /crypto     Binance      real, keyless, unlimited
 *   /forex      Twelve Data  real interbank spot
 *   /us-stocks  Twelve Data  US-listed equities
 *
 * All three go through `services/api`, never straight to the vendor: the Twelve
 * Data key is server-side only and must never reach the browser, and the free
 * plan allows 8 requests/minute, which only holds if requests are batched and
 * cached on the server rather than issued per tab.
 *
 * Indian markets are NOT here — NIFTY, NSE equities, options and MCX come from
 * the Dhan pipeline (lib/dhanLiveFeed.ts and /market-data).
 *
 * Every value is real vendor data. On an outage these throw and the UI says so;
 * nothing is simulated or carried forward.
 */

export interface CryptoQuote {
  symbol: string;
  displayName: string;
  baseAsset: string;
  quoteAsset: string;
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
  marketOpen: boolean;
  updatedAt: string;
  source: 'binance';
}

export interface FxQuote {
  symbol: string;
  displayName: string;
  baseCurrency: string;
  quoteCurrency: string;
  ltp: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  close: number;
  marketOpen: boolean;
  updatedAt: string;
  source: 'twelvedata';
}

export interface StockQuote {
  symbol: string;
  displayName: string;
  exchange: string;
  currency: string;
  ltp: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  marketOpen: boolean;
  updatedAt: string;
  source: 'twelvedata';
}

export function fetchCryptoQuotes(symbols?: string[]): Promise<CryptoQuote[]> {
  const qs = symbols?.length ? `?symbols=${encodeURIComponent(symbols.join(','))}` : '';
  return api(`/crypto/quotes${qs}`);
}

export function fetchFxQuotes(pairs?: string[]): Promise<FxQuote[]> {
  const qs = pairs?.length ? `?pairs=${encodeURIComponent(pairs.join(','))}` : '';
  return api(`/forex/quotes${qs}`);
}

export function fetchUsStockQuotes(symbols?: string[]): Promise<StockQuote[]> {
  const qs = symbols?.length ? `?symbols=${encodeURIComponent(symbols.join(','))}` : '';
  return api(`/us-stocks/quotes${qs}`);
}

/**
 * How often each board re-asks the server.
 *
 * Crypto polls faster because Binance imposes no meaningful quota on this
 * usage. FX is slower than its 60s server-side cache, so a page left open
 * cannot itself become the reason the 8/min budget is spent.
 */
export const CRYPTO_POLL_MS = 10_000;
export const FX_POLL_MS = 60_000;
