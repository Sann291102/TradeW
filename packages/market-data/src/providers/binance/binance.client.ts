import type { Candle, CandleInterval } from '@tradew/types';

/**
 * Binance public market-data client — crypto quotes and OHLCV.
 *
 * Read-only and keyless. Every endpoint used here is on Binance's public REST
 * surface (`/api/v3/ticker/24hr`, `/api/v3/klines`), which needs no API key,
 * no account and no signature. Nothing in this file can place an order or
 * touch a balance — it is a price source, nothing more.
 *
 * Deliberately NOT routed through the Dhan live-feed bridge. That bridge exists
 * because Dhan requires a secret broker token and a persistent websocket
 * subscription set that must not be duplicated across API replicas. Binance
 * needs neither, so its data belongs behind `services/api` — the authenticated
 * single ingress that actually ships — rather than behind a standalone script
 * that is not in the deploy pipeline.
 *
 * Provenance: every value returned here is real Binance market data. Nothing is
 * simulated, interpolated or filled in. When Binance is unreachable the caller
 * gets an error, not a fabricated price — same rule as the Dhan path.
 */

const BINANCE_API = process.env.BINANCE_API_URL || 'https://api.binance.com';
const DEFAULT_TIMEOUT_MS = Number(process.env.BINANCE_TIMEOUT_MS ?? 8000);

/** Binance kline interval codes, keyed by the platform's CandleInterval. */
const KLINE_INTERVAL: Record<CandleInterval, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '1d': '1d',
};

/** Binance caps a single klines request at 1000 bars. */
const MAX_KLINES = 1000;

export interface CryptoQuote {
  /** Binance symbol, e.g. 'BTCUSDT'. */
  symbol: string;
  /** Display form, e.g. 'BTC/USDT'. */
  displayName: string;
  baseAsset: string;
  quoteAsset: string;
  ltp: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  /** Previous close, so the wire shape matches the Dhan quote DTO. */
  close: number;
  bid: number;
  ask: number;
  volume: number;
  /** Crypto never closes — always true. Present so the UI can treat every
   *  market the same way instead of special-casing this one. */
  marketOpen: boolean;
  updatedAt: string;
  source: 'binance';
}

interface BinanceTicker24h {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  prevClosePrice: string;
  bidPrice: string;
  askPrice: string;
  volume: string;
  closeTime: number;
}

/**
 * Raised when Binance cannot be reached or refuses a request. Named so callers
 * can map it to a 503 and say what is disconnected, rather than flattening it
 * into a generic 500.
 */
export class CryptoDataUnavailableError extends Error {
  constructor(detail: string) {
    super(`Crypto market data is unavailable (${detail})`);
    this.name = 'CryptoDataUnavailableError';
  }
}

async function getJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${BINANCE_API}${path}`, { signal: controller.signal });
    if (!res.ok) throw new CryptoDataUnavailableError(`Binance returned ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof CryptoDataUnavailableError) throw err;
    throw new CryptoDataUnavailableError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Split 'BTCUSDT' into base/quote against the known quote assets. Binance
 *  symbols carry no separator, so the quote must be matched by suffix —
 *  longest first, or 'FDUSD' would be read as 'USD'. */
const QUOTE_ASSETS = ['FDUSD', 'USDC', 'USDT', 'BUSD', 'USD', 'BTC', 'ETH', 'BNB'] as const;

export function splitSymbol(symbol: string): { baseAsset: string; quoteAsset: string } {
  const upper = symbol.toUpperCase();
  for (const quote of [...QUOTE_ASSETS].sort((a, b) => b.length - a.length)) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return { baseAsset: upper.slice(0, -quote.length), quoteAsset: quote };
    }
  }
  return { baseAsset: upper, quoteAsset: '' };
}

function toQuote(t: BinanceTicker24h): CryptoQuote {
  const { baseAsset, quoteAsset } = splitSymbol(t.symbol);
  const num = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const ltp = num(t.lastPrice);
  return {
    symbol: t.symbol,
    displayName: quoteAsset ? `${baseAsset}/${quoteAsset}` : baseAsset,
    baseAsset,
    quoteAsset,
    ltp,
    change: num(t.priceChange),
    changePct: num(t.priceChangePercent),
    open: num(t.openPrice),
    high: num(t.highPrice),
    low: num(t.lowPrice),
    close: num(t.prevClosePrice),
    // Binance reports 0 for bid/ask on thin books; fall back to LTP rather than
    // presenting 0 as a crossable price (same rule as the Dhan bridge).
    bid: num(t.bidPrice) > 0 ? num(t.bidPrice) : ltp,
    ask: num(t.askPrice) > 0 ? num(t.askPrice) : ltp,
    volume: num(t.volume),
    marketOpen: true,
    updatedAt: new Date(t.closeTime).toISOString(),
    source: 'binance',
  };
}

/**
 * 24h ticker for the given symbols, in one request.
 *
 * Binance's `symbols` parameter takes a JSON array and costs far less request
 * weight than one call per symbol — which matters because the weight budget is
 * per-IP and this runs server-side for every user.
 */
export async function fetchCryptoQuotes(symbols: readonly string[]): Promise<CryptoQuote[]> {
  if (symbols.length === 0) return [];
  const list = JSON.stringify(symbols.map((s) => s.toUpperCase()));
  const tickers = await getJson<BinanceTicker24h[]>(`/api/v3/ticker/24hr?symbols=${encodeURIComponent(list)}`);
  const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));
  // Preserve the caller's ordering so the UI renders in the order it asked for.
  return symbols
    .map((s) => bySymbol.get(s.toUpperCase()))
    .filter((t): t is BinanceTicker24h => t !== undefined)
    .map(toQuote);
}

/**
 * Real OHLCV candles. `limit` is clamped to Binance's 1000-bar ceiling — asking
 * for more silently returns 1000, so clamping here keeps the caller's
 * expectation and the response honest.
 *
 * A kline row is a positional array:
 *   [openTime, open, high, low, close, volume, closeTime, ...]
 */
export async function fetchCryptoCandles(
  symbol: string,
  interval: CandleInterval,
  limit = 500,
): Promise<Candle[]> {
  const bars = Math.max(1, Math.min(MAX_KLINES, Math.floor(limit)));
  const rows = await getJson<unknown[][]>(
    `/api/v3/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${KLINE_INTERVAL[interval]}&limit=${bars}`,
  );
  return rows.map((r) => ({
    timestamp: new Date(Number(r[0])),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));
}

/** True when Binance lists this symbol as currently TRADING. */
export async function isTradableSymbol(symbol: string): Promise<boolean> {
  const info = await getJson<{ symbols: Array<{ symbol: string; status: string }> }>(
    `/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
  );
  return info.symbols?.[0]?.status === 'TRADING';
}
