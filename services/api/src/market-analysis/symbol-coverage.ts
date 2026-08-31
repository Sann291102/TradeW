import { DEFAULT_CRYPTO_SYMBOLS, FX_PROXY_SYMBOLS } from '../crypto/crypto.service';

/**
 * Which analysis path a symbol belongs to — decided BEFORE anything is
 * fetched, and reported to the user either way.
 *
 * ── THE MISTAKE THIS MODULE EXISTS TO PREVENT ──────────────────────────────
 *
 * `services/sentinel`'s market-data provider is Dhan/NSE only, with no
 * simulator fallback (`candle-market-data.provider.ts`, 2026-07-26). Ask it
 * for BTCUSDT and it does not return crypto — it raises
 * `MarketDataUnavailableError`, or worse, resolves some unrelated NSE scrip
 * that happens to share a prefix.
 *
 * Meanwhile `apps/web` genuinely shows a BTC/USDT chart, and a user looking at
 * it will type "analyse BTC". Two honest answers are possible and one dishonest
 * one is very easy: routing the request into the NSE engine and narrating
 * whatever comes back. That would put an RSI on screen next to a Binance
 * candlestick chart with no relationship between them, which is exactly the
 * fabrication class this repository has already been bitten by twice (the
 * simulated-NIFTY-beside-a-live-tile incident, and the CE direction invented
 * off signals that had none).
 *
 * So coverage is explicit, classified here, and the refusal is specific: not
 * "I can't do that", but "canonical analysis runs on the NSE/Dhan engine and
 * BTCUSDT is a Binance instrument — here is what I can tell you instead."
 *
 * ── WHY THE CRYPTO PATH IS NOT SILENTLY EXTENDED ───────────────────────────
 *
 * Binance candles DO exist in this repo (`GET /crypto/candles/:symbol`), and
 * `composeSnapshot` is a pure function of candles, so feeding one into the
 * other is technically a small change. It is deliberately NOT done here:
 * Sentinel's provider contract, its session slicing (`sessionSlice` groups by
 * calendar day, which is meaningless on a 24/7 venue), its opening range and
 * its CPR all assume an exchange session with an open and a close. Producing
 * numbers that are arithmetically real and economically meaningless is the
 * failure `DEFAULT_MIN_CANDLES`'s docblock describes, one layer up. Extending
 * crypto is a real piece of work with its own session model, not a routing
 * tweak.
 */

export type CoverageKind = 'nse-canonical' | 'crypto' | 'fx' | 'unknown';

export interface SymbolCoverage {
  symbol: string;
  kind: CoverageKind;
  /** True only when the canonical Sentinel snapshot can serve this symbol. */
  analysable: boolean;
  /** Why not, when `analysable` is false. Written to be shown to a user. */
  reason: string | null;
  /** Where the workspace does get data for this symbol, when it is not us. */
  dataSource: string;
}

/**
 * Index symbols the Dhan bridge resolves and the engine is known to read.
 *
 * Listed rather than inferred because these are the symbols the assistant is
 * asked about by name every day, and an index that silently fell out of the
 * bridge's universe should surface as "no data for NIFTY" from the provider,
 * not as "NIFTY is not a symbol I know" from this file.
 */
export const NSE_INDEX_SYMBOLS = [
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'NIFTYNXT50',
  'SENSEX',
  'BANKEX',
] as const;

const CRYPTO_SET = new Set<string>([...DEFAULT_CRYPTO_SYMBOLS, ...FX_PROXY_SYMBOLS]);

/**
 * Bare crypto tickers people actually type. `BTC` is not a Binance symbol —
 * `BTCUSDT` is — and a user saying "analyse BTC" must still be told the truth
 * about coverage rather than falling through to `unknown` and being routed at
 * the NSE engine.
 */
const CRYPTO_BASES = new Set([
  'BTC', 'BITCOIN', 'ETH', 'ETHEREUM', 'BNB', 'SOL', 'SOLANA', 'XRP', 'RIPPLE',
  'ADA', 'CARDANO', 'DOGE', 'DOGECOIN', 'TRX', 'TRON', 'LINK', 'CHAINLINK',
  'AVAX', 'DOT', 'POLKADOT', 'MATIC', 'POLYGON',
]);

/** Spot-FX pairs the Markets workspace charts through a third-party aggregator. */
const FX_PAIRS = new Set(['EURUSD', 'GBPUSD', 'USDJPY', 'USDINR', 'EURINR', 'GBPINR', 'JPYINR', 'AUDUSD', 'USDCAD']);

const CRYPTO_REASON =
  'Canonical market analysis runs on the NSE/Dhan engine, and this is a crypto instrument charted from Binance — a completely separate data path. I will not run NSE indicators over a market they were not read from and present the result as analysis. Ask me for its price and I will fetch that from the live board, or ask me about an NSE symbol for the full read.';

const FX_REASON =
  'Canonical market analysis runs on the NSE/Dhan engine, and this is a spot-FX pair charted from a third-party aggregator. Those are different feeds with different timestamps, so I will not narrate NSE indicators over them. I can still quote the pair.';

/** Classify a symbol into an analysis path. Pure — no network, no fetch. */
export function classifySymbol(raw: string): SymbolCoverage {
  const symbol = raw.trim().toUpperCase();

  if (!symbol) {
    return {
      symbol,
      kind: 'unknown',
      analysable: false,
      reason: 'No symbol was named.',
      dataSource: 'none',
    };
  }

  if (CRYPTO_SET.has(symbol) || CRYPTO_BASES.has(symbol)) {
    // EURUSDT is Binance's FX proxy — same venue, so it takes the crypto path's
    // data source with the FX explanation.
    const isFxProxy = (FX_PROXY_SYMBOLS as readonly string[]).includes(symbol);
    return {
      symbol,
      kind: isFxProxy ? 'fx' : 'crypto',
      analysable: false,
      reason: isFxProxy ? FX_REASON : CRYPTO_REASON,
      dataSource: 'Binance (GET /crypto/candles) — quotes and candles only',
    };
  }

  if (FX_PAIRS.has(symbol)) {
    return {
      symbol,
      kind: 'fx',
      analysable: false,
      reason: FX_REASON,
      dataSource: 'Twelve Data / FX aggregator — quotes only',
    };
  }

  // Everything else is treated as an NSE instrument and offered to the engine.
  // If the bridge does not carry it, the provider says so and that 503 reaches
  // the user verbatim — which is a better answer than this file guessing at a
  // universe of ~550 symbols that changes with Dhan's scrip master.
  return {
    symbol,
    kind: 'nse-canonical',
    analysable: true,
    reason: null,
    dataSource: 'Sentinel canonical MarketSnapshot (Dhan real OHLC)',
  };
}

/** True when the symbol is one of the named NSE indices. */
export function isNseIndex(symbol: string): boolean {
  return (NSE_INDEX_SYMBOLS as readonly string[]).includes(symbol.trim().toUpperCase());
}
