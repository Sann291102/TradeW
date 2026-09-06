/**
 * CRYPTO — every spot pair Binance lists, from `/api/v3/exchangeInfo`.
 *
 * One unauthenticated request returns the complete spot catalogue: ~3,000 pairs
 * with their status, base and quote assets, and the lot/tick filters that
 * govern order size. No key, no pagination, no quota — which is why the crypto
 * universe is the one market that can be resynced as often as anyone likes.
 *
 * WHAT "COMPREHENSIVE" MEANS HERE, AND WHAT IT DELIBERATELY EXCLUDES
 *
 *   · SPOT ONLY. `/api/v3/exchangeInfo` is the spot endpoint. Futures and
 *     margin live behind different hosts and carry leverage, liquidation and
 *     funding mechanics the paper account has no model for. Their absence is a
 *     scope decision, matching the existing CryptoWallet's spot-only design.
 *
 *   · EVERY QUOTE ASSET, NOT JUST USDT. Restricting to USDT would drop the
 *     BTC-quoted and ETH-quoted books entirely — a real part of the market and
 *     the only way most small-cap pairs trade. They are imported with their true
 *     quote asset, which the currency policy then treats honestly: a BTC-quoted
 *     pair is priced in BTC and needs a rate to be shown in a USD account.
 *
 *   · NOTHING IS FILTERED BY STATUS. Binance publishes BREAK and HALT states,
 *     and those are mapped to SUSPENDED rather than dropped. A pair that
 *     disappears from a later complete run is what gets marked DELISTED.
 *
 * STABLECOINS ARE NOT DOLLARS. USDT and USDC are recorded as the quote currency
 * they are. See `currency-policy.ts` for why the platform declines to call them
 * USD: they are dollar-referenced tokens that have traded off peg, and the
 * paper account settles in actual dollars.
 */

import { resolveCurrencyPolicy } from '../currency-policy';
import type {
  CatalogueFetchOptions,
  CataloguePage,
  CatalogueRecord,
  CatalogueSource,
  UniverseStatus,
} from '../universe.contracts';

const BINANCE_API = process.env.BINANCE_API_URL || 'https://api.binance.com';
const TIMEOUT_MS = Number(process.env.BINANCE_TIMEOUT_MS ?? 20_000);

/**
 * Binance symbol status -> platform status.
 *
 * `BREAK` and `HALT` are temporary trading stops, not delistings, so they map to
 * SUSPENDED: the instrument still exists and its history is still valid.
 * `PENDING_TRADING` is a listed-but-not-yet-open pair — INACTIVE, because it is
 * real but not currently tradable. Anything unrecognised becomes UNKNOWN rather
 * than being optimistically called ACTIVE.
 */
const STATUS_MAP: Readonly<Record<string, UniverseStatus>> = {
  TRADING: 'ACTIVE',
  BREAK: 'SUSPENDED',
  HALT: 'SUSPENDED',
  PENDING_TRADING: 'INACTIVE',
  PRE_TRADING: 'INACTIVE',
  POST_TRADING: 'INACTIVE',
  END_OF_DAY: 'INACTIVE',
  AUCTION_MATCH: 'SUSPENDED',
  DELISTED: 'DELISTED',
};

interface BinanceFilter {
  filterType?: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
}

interface BinanceSymbol {
  symbol?: string;
  status?: string;
  baseAsset?: string;
  quoteAsset?: string;
  baseAssetPrecision?: number;
  quotePrecision?: number;
  isSpotTradingAllowed?: boolean;
  permissions?: string[];
  filters?: BinanceFilter[];
}

export interface BinanceCatalogueOptions {
  baseUrl?: string;
  /**
   * Keep only pairs whose spot book is open. Off by default — a pair Binance
   * lists but has paused is still part of the universe and hiding it makes the
   * catalogue disagree with the exchange.
   */
  spotTradableOnly?: boolean;
}

export class BinanceCatalogueSource implements CatalogueSource {
  readonly id = 'binance';
  readonly markets = ['CRYPTO'] as const;

  constructor(private readonly options: BinanceCatalogueOptions = {}) {}

  /** Public and keyless — always available. */
  isConfigured(): boolean {
    return true;
  }

  async *pages(options: CatalogueFetchOptions = {}): AsyncGenerator<CataloguePage, void, undefined> {
    if (options.markets && !options.markets.includes('CRYPTO')) return;

    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort);

    let body: { symbols?: BinanceSymbol[] };
    try {
      const res = await fetchImpl(`${this.options.baseUrl ?? BINANCE_API}/api/v3/exchangeInfo`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Binance exchangeInfo failed: HTTP ${res.status} ${res.statusText}`);
      body = (await res.json()) as { symbols?: BinanceSymbol[] };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    const rejected: CataloguePage['rejected'] = [];
    const records: CatalogueRecord[] = [];
    const seen = new Set<string>();

    for (const row of body.symbols ?? []) {
      if (options.limit && records.length >= options.limit) break;

      const symbol = (row.symbol ?? '').trim().toUpperCase();
      const base = (row.baseAsset ?? '').trim().toUpperCase();
      const quote = (row.quoteAsset ?? '').trim().toUpperCase();
      if (!symbol || !base || !quote) {
        rejected.push({ reason: 'incomplete pair', sample: symbol || row.baseAsset });
        continue;
      }
      // Non-spot permissions (MARGIN, LEVERAGED) appear on the same endpoint;
      // this is the spot universe, so anything without a spot book is out.
      if (row.isSpotTradingAllowed === false && !row.permissions?.includes('SPOT')) {
        rejected.push({ reason: 'not spot-tradable', sample: symbol });
        continue;
      }
      if (this.options.spotTradableOnly && row.status !== 'TRADING') {
        rejected.push({ reason: `status ${row.status}`, sample: symbol });
        continue;
      }
      // Binance has, on occasion, listed the same symbol twice across a
      // migration window. First wins, deterministically.
      if (seen.has(symbol)) continue;
      seen.add(symbol);

      records.push(toBinanceRecord(row, symbol, base, quote));
    }

    yield { records, label: 'spot', rejected };
  }
}

/** Map one Binance exchangeInfo symbol. Exported for tests. */
export function toBinanceRecord(
  row: BinanceSymbol,
  symbol: string,
  base: string,
  quote: string,
): CatalogueRecord {
  const filters = row.filters ?? [];
  const priceFilter = filters.find((f) => f.filterType === 'PRICE_FILTER');
  const lotFilter = filters.find((f) => f.filterType === 'LOT_SIZE');

  // A pair is priced in its quote asset — BTCUSDT in USDT, ETHBTC in BTC.
  const currency = resolveCurrencyPolicy({ market: 'CRYPTO', exchange: 'BINANCE', quoteAsset: quote });

  return {
    market: 'CRYPTO',
    exchange: 'BINANCE',
    symbol,
    displayName: `${base}/${quote}`,
    assetClass: 'CRYPTO_PAIR',
    status: STATUS_MAP[(row.status ?? '').toUpperCase()] ?? 'UNKNOWN',
    quoteCurrency: currency.quoteCurrency,
    provider: 'binance',
    // Binance is addressed by the unslashed pair, which is also `symbol` here.
    providerSymbol: symbol,
    baseAsset: base,
    quoteAsset: quote,
    // Published as decimal strings; kept as the exchange states them so an
    // order-size check uses the exchange's own increments rather than a
    // rounded copy.
    tickSize: toNumber(priceFilter?.tickSize),
    stepSize: toNumber(lotFilter?.stepSize),
    minQty: toNumber(lotFilter?.minQty),
    raw: row,
  };
}

function toNumber(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
