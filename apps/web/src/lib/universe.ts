import { api } from './api';

/**
 * Tradable-universe client — the catalogue of everything the platform quotes.
 *
 * THE CONSTRAINT THIS MODULE EXISTS TO HONOUR
 *
 * The universe is on the order of 10^5 instruments across five markets. It is
 * never fetched whole. Every function here is bounded — a page at a time, at
 * most `MAX_PAGE_SIZE` rows, addressed by an opaque cursor — and there is
 * deliberately no `fetchAll`. Searching and filtering happen on the SERVER,
 * against a trigram-indexed column, and the browser only ever holds what is on
 * screen plus the pages a user has scrolled through.
 *
 * That is also why there is no client-side `.filter()` anywhere in the UI built
 * on this: filtering in the browser would require having the data in the
 * browser, which is exactly the thing being avoided.
 *
 * CURRENCY. Every row carries two currencies and they mean different things:
 *
 *   quoteCurrency    what the VENUE prices the instrument in. INR on NSE/BSE,
 *                    USD on NYSE/NASDAQ/AMEX, GBX (pence) on most of the LSE,
 *                    the pair's own quote leg for FX and crypto.
 *   accountCurrency  what the PAPER ACCOUNT settles in. INR for India, USD for
 *                    the US, UK, forex and crypto.
 *
 * `requiresFxConversion` is true where they differ. The UI renders prices in
 * `quoteCurrency` and never converts: a GBX price is shown as pence. Anything
 * that wants a figure in the account's currency has to go and get a real rate.
 */

/** Mirrors MAX_PAGE_SIZE in services/api — the server clamps regardless. */
export const UNIVERSE_MAX_PAGE_SIZE = 100;

export type UniverseMarket = 'INDIA' | 'USA' | 'UK' | 'FOREX' | 'CRYPTO';

export type UniverseAssetClass =
  | 'EQUITY'
  | 'ETF'
  | 'INDEX'
  | 'FUND'
  | 'TRUST'
  | 'REIT'
  | 'DEPOSITARY_RECEIPT'
  | 'WARRANT'
  | 'BOND'
  | 'FUTURE'
  | 'OPTION'
  | 'CURRENCY_PAIR'
  | 'CRYPTO_PAIR'
  | 'COMMODITY'
  | 'OTHER';

export type UniverseStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'DELISTED' | 'UNKNOWN';

export interface UniverseInstrument {
  ref: string;
  market: UniverseMarket;
  exchange: string;
  mic: string | null;
  symbol: string;
  displayName: string;
  assetClass: UniverseAssetClass;
  status: UniverseStatus;
  quoteCurrency: string;
  accountCurrency: string;
  requiresFxConversion: boolean;
  country: string | null;
  isin: string | null;
  baseAsset: string | null;
  quoteAsset: string | null;
  lotSize: number | null;
  provider: string;
  providerSymbol: string;
  securityId: string | null;
  exchangeSegment: string | null;
  lastSeenAt: string;
  delistedAt: string | null;
}

export interface UniverseSearchPage {
  items: UniverseInstrument[];
  nextCursor: string | null;
  pageSize: number;
  hasMore: boolean;
}

export interface UniverseFacets {
  markets: Array<{ market: UniverseMarket; count: number; accountCurrency: string }>;
  exchanges: Array<{ market: UniverseMarket; exchange: string; count: number }>;
  assetClasses: Array<{ market: UniverseMarket; assetClass: UniverseAssetClass; count: number }>;
  statuses: Array<{ status: UniverseStatus; count: number }>;
}

export interface UniverseStats {
  markets: Array<{
    market: UniverseMarket;
    accountCurrency: string;
    total: number;
    active: number;
    delisted: number;
  }>;
  recentSyncs: Array<{
    source: string;
    market: UniverseMarket | null;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    discovered: number;
    created: number;
    updated: number;
    delisted: number;
    truncated: boolean;
  }>;
}

export interface UniverseSearchParams {
  q?: string;
  market?: UniverseMarket;
  exchange?: string;
  assetClass?: UniverseAssetClass;
  includeInactive?: boolean;
  limit?: number;
  cursor?: string;
}

/** One page. Call again with `nextCursor` for the next. */
export async function searchUniverse(params: UniverseSearchParams = {}): Promise<UniverseSearchPage> {
  const qs = new URLSearchParams();
  if (params.q?.trim()) qs.set('q', params.q.trim());
  if (params.market) qs.set('market', params.market);
  if (params.exchange) qs.set('exchange', params.exchange);
  if (params.assetClass) qs.set('assetClass', params.assetClass);
  if (params.includeInactive) qs.set('includeInactive', 'true');
  if (params.limit) qs.set('limit', String(Math.min(UNIVERSE_MAX_PAGE_SIZE, params.limit)));
  if (params.cursor) qs.set('cursor', params.cursor);
  return api(`/universe/search?${qs.toString()}`);
}

export async function fetchUniverseFacets(): Promise<UniverseFacets> {
  return api('/universe/facets');
}

export async function fetchUniverseStats(): Promise<UniverseStats> {
  return api('/universe/stats');
}

export async function fetchUniverseInstrument(ref: string): Promise<UniverseInstrument> {
  return api(`/universe/ref/${encodeURIComponent(ref)}`);
}

/** Human labels for the five markets, with the venues each covers. */
export const MARKET_LABELS: Record<UniverseMarket, { label: string; venues: string; flag: string }> = {
  INDIA: { label: 'India', venues: 'NSE · BSE', flag: '🇮🇳' },
  USA: { label: 'United States', venues: 'NYSE · NASDAQ · AMEX', flag: '🇺🇸' },
  UK: { label: 'United Kingdom', venues: 'LSE', flag: '🇬🇧' },
  FOREX: { label: 'Forex', venues: 'Interbank spot', flag: '💱' },
  CRYPTO: { label: 'Crypto', venues: 'Binance spot', flag: '₿' },
};

export const ASSET_CLASS_LABELS: Record<UniverseAssetClass, string> = {
  EQUITY: 'Equity',
  ETF: 'ETF',
  INDEX: 'Index',
  FUND: 'Fund',
  TRUST: 'Trust',
  REIT: 'REIT',
  DEPOSITARY_RECEIPT: 'Depositary receipt',
  WARRANT: 'Warrant',
  BOND: 'Bond',
  FUTURE: 'Future',
  OPTION: 'Option',
  CURRENCY_PAIR: 'FX pair',
  CRYPTO_PAIR: 'Crypto pair',
  COMMODITY: 'Commodity',
  OTHER: 'Other',
};

/**
 * How a price in this instrument's own currency should be labelled.
 *
 * `GBX` renders as a pence suffix rather than a pound sign, because the LSE
 * quotes ordinary shares in pence and showing 2,431 pence as "£2,431" is a
 * hundred-fold error that looks entirely plausible on screen.
 */
export function quoteCurrencyLabel(currency: string): string {
  const code = currency.toUpperCase();
  if (code === 'GBX') return 'pence (GBX)';
  return code;
}
