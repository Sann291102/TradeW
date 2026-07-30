import type { Candle, CandleInterval } from '@tradew/types';

/**
 * Twelve Data client — real foreign exchange (interbank spot).
 *
 * Why this and not Binance or Dhan:
 *   - Dhan carries NO live currency contracts. Verified 2026-07-28 against the
 *     scrip master: the newest unexpired NSE currency future is a test
 *     instrument, and every real FUT/OPTCUR row expired on or before
 *     2026-06-26. There is nothing to quote.
 *   - Binance lists NO fiat/fiat pairs at all — verified against
 *     /api/v3/exchangeInfo, zero symbols where base and quote are both fiat.
 *     Its closest analogue is EURUSDT, which is EUR against a dollar
 *     stablecoin, not an FX rate.
 * Twelve Data returns genuine EUR/USD, GBP/USD, USD/JPY and USD/INR.
 *
 * RATE LIMIT IS THE DESIGN CONSTRAINT. The free "basic" plan allows **8
 * requests per minute** and 800 per day, per key — measured, not assumed
 * (GET /api_usage returns plan_limit: 8, plan_daily_limit: 800). A page that
 * issued one request per pair per render would exhaust that within a single
 * refresh. So:
 *   - every quote read is BATCHED into one multi-symbol request, and
 *   - responses are cached server-side, so upstream cost is a function of time,
 *     not of how many users or tabs are open.
 * Both caches are process-local, which is correct for the single API replica
 * this deploys as today; a second replica would double upstream calls, not
 * break correctness.
 *
 * Provenance: real vendor data only. On failure this throws — no stale-price
 * fallback, no interpolation, matching the rule the Dhan and Binance paths
 * already follow.
 */

const TWELVEDATA_API = process.env.TWELVEDATA_API_URL || 'https://api.twelvedata.com';
const TIMEOUT_MS = Number(process.env.TWELVEDATA_TIMEOUT_MS ?? 8000);

/** One batched quote request per minute keeps steady-state usage at ~1 of 8. */
const QUOTE_CACHE_TTL_MS = 60_000;
/** Candles move far more slowly than the budget; 5 minutes is generous. */
const CANDLE_CACHE_TTL_MS = 5 * 60_000;

/** Platform interval -> Twelve Data interval code. */
const TD_INTERVAL: Record<CandleInterval, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1h': '1h',
  '1d': '1day',
};

export interface FxQuote {
  /** Vendor symbol, e.g. 'EUR/USD'. */
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
  /** Previous close. */
  close: number;
  /** True while the FX session is open — the vendor reports this per symbol. */
  marketOpen: boolean;
  updatedAt: string;
  source: 'twelvedata';
}

export class FxDataUnavailableError extends Error {
  constructor(detail: string) {
    super(`Foreign-exchange data is unavailable (${detail})`);
    this.name = 'FxDataUnavailableError';
  }
}

function apiKey(): string {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new FxDataUnavailableError('TWELVEDATA_API_KEY is not configured');
  return key;
}

const quoteCache = new Map<string, { at: number; quotes: FxQuote[] }>();
const stockCache = new Map<string, { at: number; quotes: StockQuote[] }>();
const candleCache = new Map<string, { at: number; candles: Candle[] }>();

async function getJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${TWELVEDATA_API}${path}`, { signal: controller.signal });
    if (!res.ok) throw new FxDataUnavailableError(`Twelve Data returned ${res.status}`);
    const body = (await res.json()) as T & { status?: string; message?: string; code?: number };
    // Twelve Data signals errors in a 200 body, not the status line — a quota
    // breach would otherwise parse as a successful empty response.
    if (body && typeof body === 'object' && 'status' in body && body.status === 'error') {
      throw new FxDataUnavailableError(body.message ?? `vendor error ${body.code ?? ''}`.trim());
    }
    return body;
  } catch (err) {
    if (err instanceof FxDataUnavailableError) throw err;
    throw new FxDataUnavailableError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

interface TdQuote {
  symbol: string;
  name?: string;
  currency_base?: string;
  currency_quote?: string;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  previous_close?: string;
  change?: string;
  percent_change?: string;
  timestamp?: number;
  is_market_open?: boolean;
}

const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function toFxQuote(q: TdQuote): FxQuote {
  const [base, quote] = q.symbol.split('/');
  return {
    symbol: q.symbol,
    displayName: q.symbol,
    baseCurrency: q.currency_base ?? base ?? '',
    quoteCurrency: q.currency_quote ?? quote ?? '',
    ltp: num(q.close),
    change: num(q.change),
    changePct: num(q.percent_change),
    open: num(q.open),
    high: num(q.high),
    low: num(q.low),
    close: num(q.previous_close),
    marketOpen: q.is_market_open ?? false,
    updatedAt: q.timestamp ? new Date(q.timestamp * 1000).toISOString() : new Date().toISOString(),
    source: 'twelvedata',
  };
}

/**
 * Batched quotes for several pairs in ONE upstream request.
 *
 * Twelve Data returns a bare object for a single symbol and a symbol-keyed map
 * for several, so both shapes are normalised here.
 */
export async function fetchFxQuotes(symbols: readonly string[]): Promise<FxQuote[]> {
  if (symbols.length === 0) return [];
  const key = symbols.join(',');
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.at < QUOTE_CACHE_TTL_MS) return cached.quotes;

  const raw = await getJson<TdQuote | Record<string, TdQuote>>(
    `/quote?symbol=${encodeURIComponent(key)}&apikey=${encodeURIComponent(apiKey())}`,
  );
  const list: TdQuote[] =
    'symbol' in raw && typeof (raw as TdQuote).symbol === 'string'
      ? [raw as TdQuote]
      : Object.values(raw as Record<string, TdQuote>).filter((q) => q && typeof q.symbol === 'string');

  // Preserve the caller's ordering so the board renders as requested.
  const bySymbol = new Map(list.map((q) => [q.symbol, q]));
  const quotes = symbols
    .map((s) => bySymbol.get(s))
    .filter((q): q is TdQuote => q !== undefined)
    .map(toFxQuote);

  quoteCache.set(key, { at: Date.now(), quotes });
  return quotes;
}

/**
 * US-listed equities — the one asset class this vendor adds that neither Dhan
 * nor Binance covers.
 *
 * Indian equities and indices are deliberately NOT fetched here even though the
 * endpoint accepts them: measured 2026-07-28, `RELIANCE` on NSE returns
 * "available starting with the Grow or Venture plan", and `NIFTY 50` is not a
 * recognised symbol on this plan. Dhan already serves those, in more depth and
 * without a quota — routing them here would be a downgrade behind a paywall.
 */
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

interface TdStockQuote extends TdQuote {
  exchange?: string;
  currency?: string;
  volume?: string;
}

/** Batched, cached US equity quotes — same one-request discipline as FX. */
export async function fetchStockQuotes(symbols: readonly string[]): Promise<StockQuote[]> {
  if (symbols.length === 0) return [];
  const key = symbols.join(',');
  const cacheKey = `stocks:${key}`;
  const cached = stockCache.get(cacheKey);
  if (cached && Date.now() - cached.at < QUOTE_CACHE_TTL_MS) return cached.quotes;

  const raw = await getJson<TdStockQuote | Record<string, TdStockQuote>>(
    `/quote?symbol=${encodeURIComponent(key)}&apikey=${encodeURIComponent(apiKey())}`,
  );
  const list: TdStockQuote[] =
    'symbol' in raw && typeof (raw as TdStockQuote).symbol === 'string'
      ? [raw as TdStockQuote]
      : Object.values(raw as Record<string, TdStockQuote>).filter((q) => q && typeof q.symbol === 'string');

  const bySymbol = new Map(list.map((q) => [q.symbol, q]));
  const quotes = symbols
    .map((s) => bySymbol.get(s))
    .filter((q): q is TdStockQuote => q !== undefined)
    .map((q) => ({
      symbol: q.symbol,
      displayName: q.name ?? q.symbol,
      exchange: q.exchange ?? '',
      currency: q.currency ?? 'USD',
      ltp: num(q.close),
      change: num(q.change),
      changePct: num(q.percent_change),
      open: num(q.open),
      high: num(q.high),
      low: num(q.low),
      close: num(q.previous_close),
      volume: num(q.volume),
      marketOpen: q.is_market_open ?? false,
      updatedAt: q.timestamp ? new Date(q.timestamp * 1000).toISOString() : new Date().toISOString(),
      source: 'twelvedata' as const,
    }));

  stockCache.set(cacheKey, { at: Date.now(), quotes });
  return quotes;
}

/** Real OHLC for one pair. FX has no traded volume, so `volume` is 0 — the
 *  vendor does not report one and inventing it would be a fabricated number. */
export async function fetchFxCandles(
  symbol: string,
  interval: CandleInterval,
  outputsize = 300,
): Promise<Candle[]> {
  const bars = Math.max(1, Math.min(5000, Math.floor(outputsize)));
  const cacheKey = `${symbol}:${interval}:${bars}`;
  const cached = candleCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CANDLE_CACHE_TTL_MS) return cached.candles;

  const body = await getJson<{ values?: Array<Record<string, string>> }>(
    `/time_series?symbol=${encodeURIComponent(symbol)}&interval=${TD_INTERVAL[interval]}` +
      `&outputsize=${bars}&apikey=${encodeURIComponent(apiKey())}`,
  );
  // Vendor returns newest-first; charts want oldest-first.
  const candles: Candle[] = (body.values ?? [])
    .map((v) => ({
      timestamp: new Date(v.datetime.replace(' ', 'T') + 'Z'),
      open: num(v.open),
      high: num(v.high),
      low: num(v.low),
      close: num(v.close),
      volume: 0,
    }))
    .reverse();

  candleCache.set(cacheKey, { at: Date.now(), candles });
  return candles;
}
