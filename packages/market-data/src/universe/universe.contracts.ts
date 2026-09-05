/**
 * The tradable universe — provider-neutral catalogue contracts.
 *
 * A "catalogue" is the answer to *what can be traded*, as opposed to a feed,
 * which answers *what is it worth right now*. The two are deliberately
 * separate: catalogues change about once a day and are large (the Indian scrip
 * master alone is ~10 MiB), feeds change every few milliseconds and are small.
 * Nothing in this file fetches a price.
 *
 * Every provider — Dhan's CSV master, Twelve Data's reference JSON, Binance's
 * exchangeInfo — is reduced to the one `CatalogueRecord` shape below, so the
 * sync engine, the database and the UI never learn which vendor a row came
 * from except as provenance.
 *
 * PROVENANCE RULE, inherited from the feed side of this package: nothing here
 * invents a field. Where a provider does not publish a status, the record says
 * `UNKNOWN` rather than assuming `ACTIVE`; where it does not publish a lot size,
 * the field is absent rather than defaulted to 1. A fabricated catalogue fact
 * is as damaging as a fabricated price — it just fails later.
 */

export const UNIVERSE_MARKETS = ['INDIA', 'USA', 'UK', 'FOREX', 'CRYPTO'] as const;
export type UniverseMarket = (typeof UNIVERSE_MARKETS)[number];

export const UNIVERSE_ASSET_CLASSES = [
  'EQUITY',
  'ETF',
  'INDEX',
  'FUND',
  'TRUST',
  'REIT',
  'DEPOSITARY_RECEIPT',
  'WARRANT',
  'BOND',
  'FUTURE',
  'OPTION',
  'CURRENCY_PAIR',
  'CRYPTO_PAIR',
  'COMMODITY',
  'OTHER',
] as const;
export type UniverseAssetClass = (typeof UNIVERSE_ASSET_CLASSES)[number];

export const UNIVERSE_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'DELISTED', 'UNKNOWN'] as const;
export type UniverseStatus = (typeof UNIVERSE_STATUSES)[number];

/**
 * The venues the five markets resolve to. `FX` and `BINANCE` are not exchanges
 * in the listing sense — FX spot is an interbank market with no single venue,
 * and Binance is one crypto exchange among many — but both need a stable
 * `exchange` value to make (market, exchange, symbol) unique, and naming them
 * honestly beats inventing a fake MIC.
 */
export const UNIVERSE_EXCHANGES = ['NSE', 'BSE', 'NYSE', 'NASDAQ', 'AMEX', 'LSE', 'FX', 'BINANCE'] as const;
export type UniverseExchange = (typeof UNIVERSE_EXCHANGES)[number];

/** One instrument, as any provider's catalogue describes it. */
export interface CatalogueRecord {
  market: UniverseMarket;
  exchange: UniverseExchange;
  /** ISO 10383 MIC, when the provider publishes one. */
  mic?: string;
  /** Canonical ticker within (market, exchange). Upper-cased by the normaliser. */
  symbol: string;
  displayName: string;
  assetClass: UniverseAssetClass;
  status: UniverseStatus;

  /**
   * What the VENUE quotes in — `INR`, `USD`, `GBX`, `JPY`. Never the account's
   * currency, never converted. See `currency-policy.ts`.
   */
  quoteCurrency: string;

  country?: string;
  sector?: string;
  industry?: string;

  isin?: string;
  figi?: string;
  cusip?: string;
  sedol?: string;

  /** 'dhan' | 'twelvedata' | 'binance'. */
  provider: string;
  /** What to send back to that provider to address this instrument. */
  providerSymbol: string;

  securityId?: string;
  exchangeSegment?: string;
  series?: string;

  baseAsset?: string;
  quoteAsset?: string;

  lotSize?: number;
  tickSize?: number;
  minQty?: number;
  stepSize?: number;

  /** The provider payload as received, kept for debugging imports. */
  raw?: unknown;
}

/**
 * A page of catalogue records plus whatever the source needs to ask for the
 * next one. Sources yield pages rather than one big array because two of the
 * three genuinely paginate (Twelve Data by exchange and page, Dhan by file) and
 * because holding 200k records in memory to write them once is avoidable.
 */
export interface CataloguePage {
  records: CatalogueRecord[];
  /** Human-readable label for logs: 'NASDAQ p2', 'NSE_EQ', 'spot'. */
  label: string;
  /** Records this page's provider returned that could not be mapped. */
  rejected: Array<{ reason: string; sample?: string }>;
}

/**
 * A source of instruments for one or more markets.
 *
 * `pages()` is an async generator so a source can stream: the sync engine
 * writes each page as it arrives instead of waiting for a whole catalogue, and
 * a source that dies on page 40 has still contributed 39 pages of real data
 * (recorded as a PARTIAL run, which never triggers delisting).
 */
export interface CatalogueSource {
  /** Stable id, stored on every row as provenance: 'dhan' | 'twelvedata' | 'binance'. */
  readonly id: string;
  /** Markets this source can populate. */
  readonly markets: readonly UniverseMarket[];
  /**
   * True when the source is usable right now — a missing API key makes a source
   * unavailable, which must be reported as "not configured", never as an empty
   * catalogue that would delist every instrument it owns.
   */
  isConfigured(): boolean;
  pages(options?: CatalogueFetchOptions): AsyncGenerator<CataloguePage, void, undefined>;
}

export interface CatalogueFetchOptions {
  /** Restrict to these markets. Omit for everything the source covers. */
  markets?: readonly UniverseMarket[];
  /**
   * Stop after roughly this many records. For smoke runs only — a limited run
   * is marked `truncated` and is never allowed to delist anything, because its
   * silence about an instrument proves nothing.
   */
  limit?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Globally unique address for a catalogue row: `USA:NASDAQ:AAPL`. */
export function universeRef(
  record: Pick<CatalogueRecord, 'market' | 'exchange' | 'symbol'>,
): string {
  return `${record.market}:${record.exchange}:${record.symbol.trim().toUpperCase()}`;
}

/** Parse a ref back into its parts. Returns null on anything malformed. */
export function parseUniverseRef(
  ref: string,
): { market: UniverseMarket; exchange: string; symbol: string } | null {
  const parts = ref.split(':');
  if (parts.length !== 3) return null;
  const [market, exchange, symbol] = parts;
  if (!(UNIVERSE_MARKETS as readonly string[]).includes(market)) return null;
  if (!exchange || !symbol) return null;
  return { market: market as UniverseMarket, exchange, symbol };
}

/**
 * The single search column. Lower-cased and space-joined so one trigram index
 * serves ticker, company name, ISIN and pair-leg lookups — `reliance`, `RELI`,
 * `INE002A01018` and `usdt` all reach the right rows through the same predicate.
 */
export function buildSearchText(record: CatalogueRecord): string {
  return [
    record.symbol,
    record.displayName,
    record.isin,
    record.baseAsset,
    record.quoteAsset,
    record.exchange,
  ]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
