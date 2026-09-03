import { INDEX_QUOTES, TICKER_EXTRA, WATCHLIST, TOP_GAINERS, TOP_LOSERS } from '@/lib/mock/market';
import { FO_STOCK_UNIVERSE } from '@/lib/mock/foUniverse';
import { ALL_NSE_INDICES } from '@/lib/mock/indices';
import { COMMON_INTERVALS, type InstrumentRef } from './types';

/**
 * THE catalog — every instrument this application can name, across every venue.
 *
 * ── WHY THE NON-NSE HALVES ARE DECLARED HERE ───────────────────────────────
 *
 * The NSE half is derived from the same mock sources the command palette
 * searches, exactly as `assistant/instruments.ts` already did — so the
 * assistant and the palette cannot disagree about what an Indian symbol is.
 *
 * The crypto, FX and US halves are declared literally, mirroring
 * `DEFAULT_CRYPTO_SYMBOLS`, `DEFAULT_FX_PAIRS` and `DEFAULT_US_SYMBOLS` in
 * `services/api/src/crypto/*.service.ts`. That mirroring is asserted by
 * `catalog.test.ts` rather than assumed, following the precedent already set
 * by `lib/markets/tradingViewSymbols.test.ts`.
 *
 * The right long-term home is the Prisma `Instrument` table — but its
 * `InstrumentType` enum has four values (INDEX, OPTION, EQUITY, FUTURE), so a
 * crypto pair is currently *unrepresentable* there, not merely absent. Widening
 * that enum is a migration against a table that `Order`, `Trade` and `Position`
 * reference forever; it is sequenced after this, and this file is written so
 * that swapping its source for a fetch changes nothing above it.
 *
 * ── CAPABILITY IS DECLARED PER INSTRUMENT, NOT PER ASSET CLASS ─────────────
 *
 * Crypto is `native` because `GET /crypto/candles/:symbol` returns the same
 * `Candle[]` shape `TradeChart` already draws — it was never NSE-specific, only
 * the fetch was. FX and US equities are `embed`: Twelve Data's free tier allows
 * 8 requests/minute, which a mounted chart polling on a 60s timer would spend
 * on a single tab, so those keep the TradingView embed until a server-side
 * candle cache exists. The assistant reads `chartSurface` and says so plainly
 * rather than opening something it cannot then operate.
 */

// ---------------------------------------------------------------------------
// Indian markets — Dhan
// ---------------------------------------------------------------------------

/** Spoken forms for the index names people actually say out loud. */
const NSE_ALIASES: Record<string, string[]> = {
  NIFTY: ['nifty', 'nifty 50', 'nifty50', 'nifty fifty'],
  BANKNIFTY: ['bank nifty', 'nifty bank', 'banknifty'],
  FINNIFTY: ['fin nifty', 'finnifty', 'nifty financial services'],
  MIDCPNIFTY: ['midcap nifty', 'nifty midcap', 'midcpnifty', 'nifty midcap select'],
  SENSEX: ['sensex', 'bse sensex'],
  BANKEX: ['bankex'],
};

function nseInstruments(): InstrumentRef[] {
  const byName = new Map<string, string>();
  for (const q of [...INDEX_QUOTES, ...TICKER_EXTRA]) byName.set(q.symbol, q.name);
  for (const w of WATCHLIST) byName.set(w.symbol, w.name);
  for (const m of [...TOP_GAINERS, ...TOP_LOSERS]) byName.set(m.symbol, m.name);
  for (const s of FO_STOCK_UNIVERSE) byName.set(s.symbol, s.name);
  for (const idx of ALL_NSE_INDICES) if (!byName.has(idx.name)) byName.set(idx.name, idx.name);

  const indexSymbols = new Set([
    ...INDEX_QUOTES.map((q) => q.symbol),
    ...TICKER_EXTRA.map((q) => q.symbol),
    ...ALL_NSE_INDICES.map((i) => i.name),
  ]);

  return Array.from(byName.entries()).map(([symbol, displayName]) => ({
    symbol,
    displayName,
    assetClass: indexSymbols.has(symbol) ? ('index' as const) : ('equity' as const),
    venue: symbol === 'SENSEX' || symbol === 'BANKEX' ? ('BSE' as const) : ('NSE' as const),
    aliases: NSE_ALIASES[symbol] ?? [],
    quoteSource: 'dhan' as const,
    candleSource: 'dhan' as const,
    chartSurface: 'native' as const,
    supportedIntervals: [...COMMON_INTERVALS],
    // Indices are not directly tradeable; their derivatives are. Equities are.
    tradeable: !indexSymbols.has(symbol),
  }));
}

// ---------------------------------------------------------------------------
// Crypto — Binance, via GET /crypto/*
// ---------------------------------------------------------------------------

/**
 * Mirrors `DEFAULT_CRYPTO_SYMBOLS` in `services/api/src/crypto/crypto.service.ts`.
 * The base-asset names are what make "open bitcoin" work as well as "open BTC".
 */
const CRYPTO_BASES: ReadonlyArray<[symbol: string, base: string, name: string]> = [
  ['BTCUSDT', 'BTC', 'Bitcoin'],
  ['ETHUSDT', 'ETH', 'Ethereum'],
  ['BNBUSDT', 'BNB', 'BNB'],
  ['SOLUSDT', 'SOL', 'Solana'],
  ['XRPUSDT', 'XRP', 'XRP'],
  ['ADAUSDT', 'ADA', 'Cardano'],
  ['DOGEUSDT', 'DOGE', 'Dogecoin'],
  ['TRXUSDT', 'TRX', 'TRON'],
  ['LINKUSDT', 'LINK', 'Chainlink'],
  ['AVAXUSDT', 'AVAX', 'Avalanche'],
  ['DOTUSDT', 'DOT', 'Polkadot'],
  ['MATICUSDT', 'MATIC', 'Polygon'],
];

function cryptoInstruments(): InstrumentRef[] {
  return CRYPTO_BASES.map(([symbol, base, name]) => ({
    symbol,
    displayName: `${name} / Tether`,
    assetClass: 'crypto' as const,
    venue: 'BINANCE' as const,
    aliases: [
      base.toLowerCase(),
      name.toLowerCase(),
      `${base.toLowerCase()} usdt`,
      `${base.toLowerCase()}/usdt`,
      `${base.toLowerCase()} usd`,
    ],
    quoteSource: 'binance' as const,
    candleSource: 'binance' as const,
    // Native: the Binance candle route returns the same `Candle[]` TradeChart
    // draws, so crypto inherits drawings, detectors and timeframe control.
    chartSurface: 'native' as const,
    supportedIntervals: [...COMMON_INTERVALS],
    // Display only — see the doc comment on `InstrumentRef.tradeable`.
    tradeable: false,
  }));
}

// ---------------------------------------------------------------------------
// Foreign exchange — Twelve Data, via GET /forex/*
// ---------------------------------------------------------------------------

/** Mirrors `DEFAULT_FX_PAIRS` in `services/api/src/crypto/forex.service.ts`. */
const FX_PAIRS = [
  'EUR/USD',
  'GBP/USD',
  'USD/JPY',
  'USD/INR',
  'AUD/USD',
  'USD/CHF',
  'USD/CAD',
  'NZD/USD',
] as const;

function fxInstruments(): InstrumentRef[] {
  return FX_PAIRS.map((pair) => {
    const [base, quote] = pair.split('/');
    const compact = `${base}${quote}`;
    return {
      // The catalog key is the compact form so it satisfies the assistant's
      // symbol pattern; the slashed form is an alias, since that is how the
      // pair is written and spoken.
      symbol: compact,
      displayName: pair,
      assetClass: 'forex' as const,
      venue: 'TWELVEDATA' as const,
      aliases: [
        pair.toLowerCase(),
        compact.toLowerCase(),
        `${base.toLowerCase()} ${quote.toLowerCase()}`,
        `${base.toLowerCase()}/${quote.toLowerCase()}`,
      ],
      quoteSource: 'twelvedata' as const,
      candleSource: 'twelvedata' as const,
      // Embed, not native: Twelve Data's free tier is 8 req/min and a mounted
      // native chart refetching on a 60s timer would spend that on one tab.
      chartSurface: 'embed' as const,
      supportedIntervals: [...COMMON_INTERVALS],
      tradeable: false,
    };
  });
}

// ---------------------------------------------------------------------------
// US equities — Twelve Data, via GET /us-stocks/*
// ---------------------------------------------------------------------------

/** Mirrors `DEFAULT_US_SYMBOLS` in `services/api/src/crypto/stocks.service.ts`. */
const US_STOCKS: ReadonlyArray<[symbol: string, name: string]> = [
  ['AAPL', 'Apple'],
  ['MSFT', 'Microsoft'],
  ['NVDA', 'NVIDIA'],
  ['GOOGL', 'Alphabet'],
  ['AMZN', 'Amazon'],
  ['META', 'Meta Platforms'],
  ['TSLA', 'Tesla'],
  ['NFLX', 'Netflix'],
];

function usInstruments(): InstrumentRef[] {
  return US_STOCKS.map(([symbol, name]) => ({
    symbol,
    displayName: name,
    assetClass: 'equity' as const,
    venue: 'TWELVEDATA' as const,
    aliases: [name.toLowerCase()],
    quoteSource: 'twelvedata' as const,
    candleSource: 'twelvedata' as const,
    chartSurface: 'embed' as const,
    supportedIntervals: [...COMMON_INTERVALS],
    tradeable: false,
  }));
}

// ---------------------------------------------------------------------------

/**
 * The catalog, built once.
 *
 * NSE goes in FIRST and later venues do not overwrite it: a collision would
 * mean an Indian symbol and a foreign one share a ticker, and on an Indian
 * trading platform the Indian one is what the user meant. There is exactly one
 * such collision in practice today and this ordering is what settles it.
 */
export const INSTRUMENT_CATALOG: readonly InstrumentRef[] = (() => {
  const bySymbol = new Map<string, InstrumentRef>();
  for (const ref of [
    ...nseInstruments(),
    ...cryptoInstruments(),
    ...fxInstruments(),
    ...usInstruments(),
  ]) {
    if (!bySymbol.has(ref.symbol)) bySymbol.set(ref.symbol, ref);
  }
  return Array.from(bySymbol.values());
})();

/** Look one up by exact symbol. Case-insensitive; returns null when unknown. */
export function instrumentBySymbol(symbol: string): InstrumentRef | null {
  const want = symbol.trim().toUpperCase();
  return INSTRUMENT_CATALOG.find((i) => i.symbol === want) ?? null;
}

/** Every instrument on one venue — used by the destination registry so a
 *  venue board can state what it contains without a second hardcoded list. */
export function instrumentsForAssetClass(assetClass: InstrumentRef['assetClass']): InstrumentRef[] {
  return INSTRUMENT_CATALOG.filter((i) => i.assetClass === assetClass);
}
