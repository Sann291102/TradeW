/**
 * USA, UK and FOREX catalogues — Twelve Data reference data.
 *
 * WHY THIS VENDOR FOR THESE THREE MARKETS
 *
 * The platform already holds a Twelve Data key for FX and US quotes (see
 * `twelvedata.client.ts`), and its *reference* endpoints — `/stocks`, `/etf`,
 * `/indices`, `/forex_pairs`, `/cryptocurrencies` — are a different surface from
 * its quote endpoints in the one way that matters here: they are static
 * catalogue dumps, not per-symbol lookups. One request returns every symbol on
 * an exchange, so building a 20,000-instrument US universe costs three requests,
 * not 20,000. That is what makes a complete universe affordable on a plan that
 * allows 8 quote requests a minute.
 *
 * RATE-LIMIT DISCIPLINE. Reference endpoints are documented as not consuming
 * the per-minute API credit budget, but this source does not rely on that: it
 * issues one request per (exchange, page), paces them with a configurable
 * inter-request delay, and retries a 429 with backoff. A catalogue sync runs
 * daily, so even the pessimistic reading — every request counted — is a handful
 * of calls a day.
 *
 * PAGINATION. Twelve Data's reference endpoints historically returned the whole
 * list in one body and later grew `page`/`page_size` parameters. Both shapes are
 * handled: the source keeps requesting pages until a page comes back short or
 * empty, and a single-body response simply terminates after page 1. It also
 * stops on a page whose symbols it has already seen, which is the defence
 * against an endpoint that ignores `page` and would otherwise loop forever.
 *
 * CURRENCY. The vendor publishes a per-instrument `currency`, and it is passed
 * through rather than inferred. This is load-bearing for the UK: LSE lines are
 * mostly quoted in GBp (pence) but a real minority are quoted in USD or EUR, and
 * assuming pence for those would divide their prices by a hundred.
 */

import { normaliseCurrency, resolveCurrencyPolicy } from '../currency-policy';
import type {
  CatalogueFetchOptions,
  CataloguePage,
  CatalogueRecord,
  CatalogueSource,
  UniverseAssetClass,
  UniverseExchange,
  UniverseMarket,
} from '../universe.contracts';

const API = process.env.TWELVEDATA_API_URL || 'https://api.twelvedata.com';
const TIMEOUT_MS = Number(process.env.TWELVEDATA_TIMEOUT_MS ?? 20_000);
/** Space between reference requests. Cheap insurance against a shared key. */
const REQUEST_SPACING_MS = Number(process.env.TWELVEDATA_CATALOGUE_SPACING_MS ?? 400);
const PAGE_SIZE = Number(process.env.TWELVEDATA_CATALOGUE_PAGE_SIZE ?? 5000);
const MAX_PAGES_PER_FEED = Number(process.env.TWELVEDATA_CATALOGUE_MAX_PAGES ?? 50);

/**
 * The venues each market resolves to, as Twelve Data spells them.
 *
 * `AMEX` is the vendor's name for NYSE American (formerly the American Stock
 * Exchange); it is requested under both spellings because the vendor has used
 * each at different times and a missing alias silently costs the whole venue.
 */
const US_EXCHANGES: Array<{ query: string[]; exchange: UniverseExchange; mic: string }> = [
  { query: ['NASDAQ'], exchange: 'NASDAQ', mic: 'XNAS' },
  { query: ['NYSE'], exchange: 'NYSE', mic: 'XNYS' },
  { query: ['NYSE American', 'AMEX'], exchange: 'AMEX', mic: 'XASE' },
];

const UK_EXCHANGES: Array<{ query: string[]; exchange: UniverseExchange; mic: string }> = [
  { query: ['LSE', 'London Stock Exchange'], exchange: 'LSE', mic: 'XLON' },
];

/** Which reference feeds contribute equity-like instruments. */
const EQUITY_FEEDS = [
  { path: '/stocks', assetClass: 'EQUITY' as UniverseAssetClass },
  { path: '/etf', assetClass: 'ETF' as UniverseAssetClass },
] as const;

interface TdStockRef {
  symbol?: string;
  name?: string;
  currency?: string;
  exchange?: string;
  mic_code?: string;
  country?: string;
  type?: string;
  figi_code?: string;
  isin?: string;
  cusip?: string;
  access?: { global?: string; plan?: string };
}

interface TdForexRef {
  symbol?: string;
  currency_group?: string;
  currency_base?: string;
  currency_quote?: string;
}

/**
 * Vendor `type` -> asset class. The vendor's vocabulary is wider than the
 * platform's, so anything unrecognised becomes the feed's own default rather
 * than being forced into EQUITY.
 */
const TYPE_MAP: Readonly<Record<string, UniverseAssetClass>> = {
  'common stock': 'EQUITY',
  'common': 'EQUITY',
  'preferred stock': 'EQUITY',
  'class a': 'EQUITY',
  'class b': 'EQUITY',
  'etf': 'ETF',
  'exchange traded fund': 'ETF',
  'index': 'INDEX',
  'mutual fund': 'FUND',
  'closed-end fund': 'FUND',
  'unit': 'FUND',
  'trust': 'TRUST',
  'unit trust': 'TRUST',
  'investment trust': 'TRUST',
  'reit': 'REIT',
  'real estate investment trust': 'REIT',
  'depositary receipt': 'DEPOSITARY_RECEIPT',
  'american depositary receipt': 'DEPOSITARY_RECEIPT',
  'global depositary receipt': 'DEPOSITARY_RECEIPT',
  'adr': 'DEPOSITARY_RECEIPT',
  'gdr': 'DEPOSITARY_RECEIPT',
  'warrant': 'WARRANT',
  'right': 'WARRANT',
  'bond': 'BOND',
  'structured product': 'OTHER',
};

export interface TwelveDataCatalogueOptions {
  apiKey?: string;
  /** Override the venue list — tests, or narrowing a resync to one exchange. */
  usExchanges?: typeof US_EXCHANGES;
  ukExchanges?: typeof UK_EXCHANGES;
  spacingMs?: number;
}

export class TwelveDataCatalogueSource implements CatalogueSource {
  readonly id = 'twelvedata';
  readonly markets = ['USA', 'UK', 'FOREX'] as const;

  constructor(private readonly options: TwelveDataCatalogueOptions = {}) {}

  private key(): string | undefined {
    return this.options.apiKey ?? process.env.TWELVEDATA_API_KEY;
  }

  /**
   * A missing key makes this source UNAVAILABLE, not empty.
   *
   * The distinction is the difference between "we could not look" and "the
   * provider lists nothing" — and the second, taken at face value, would delist
   * every US, UK and FX instrument in the catalogue on the next run.
   */
  isConfigured(): boolean {
    return typeof this.key() === 'string' && this.key()!.length > 0;
  }

  async *pages(options: CatalogueFetchOptions = {}): AsyncGenerator<CataloguePage, void, undefined> {
    const key = this.key();
    if (!key) {
      throw new Error(
        'TwelveDataCatalogueSource requires TWELVEDATA_API_KEY. Refusing to run: an unauthenticated ' +
          'run would report an empty US/UK/FX catalogue, which a sync would read as a mass delisting.',
      );
    }

    const wanted = new Set<UniverseMarket>(options.markets ?? this.markets);
    let emitted = 0;
    const budget = () => (options.limit ? Math.max(0, options.limit - emitted) : Infinity);

    if (wanted.has('USA')) {
      for (const venue of this.options.usExchanges ?? US_EXCHANGES) {
        for (const feed of EQUITY_FEEDS) {
          for await (const page of this.equityPages('USA', venue, feed, key, options, budget)) {
            emitted += page.records.length;
            yield page;
            if (budget() === 0) return;
          }
        }
      }
    }

    if (wanted.has('UK')) {
      for (const venue of this.options.ukExchanges ?? UK_EXCHANGES) {
        for (const feed of EQUITY_FEEDS) {
          for await (const page of this.equityPages('UK', venue, feed, key, options, budget)) {
            emitted += page.records.length;
            yield page;
            if (budget() === 0) return;
          }
        }
      }
    }

    if (wanted.has('FOREX')) {
      const page = await this.forexPage(key, options, budget);
      emitted += page.records.length;
      yield page;
    }
  }

  /**
   * Walk one (exchange, feed) pair page by page.
   *
   * The vendor is asked for each of the venue's alias spellings in turn and the
   * first that returns anything wins — asking for all of them and merging would
   * double-count every instrument on a venue that answers to both names.
   */
  private async *equityPages(
    market: UniverseMarket,
    venue: { query: string[]; exchange: UniverseExchange; mic: string },
    feed: (typeof EQUITY_FEEDS)[number],
    key: string,
    options: CatalogueFetchOptions,
    budget: () => number,
  ): AsyncGenerator<CataloguePage, void, undefined> {
    for (const alias of venue.query) {
      let found = false;
      const seen = new Set<string>();

      for (let page = 1; page <= MAX_PAGES_PER_FEED; page++) {
        const url =
          `${API}${feed.path}?exchange=${encodeURIComponent(alias)}` +
          `&page=${page}&page_size=${PAGE_SIZE}&apikey=${encodeURIComponent(key)}`;
        const body = await this.get<{ data?: TdStockRef[]; result?: { list?: TdStockRef[] } }>(url, options);
        // Two response shapes are in the wild for these endpoints: `{data: []}`
        // on the reference endpoints and `{result: {list: []}}` on the newer
        // symbol-search surface. Accepting both means a vendor-side migration
        // shows up as unchanged behaviour rather than an empty universe.
        const list = body.data ?? body.result?.list ?? [];
        if (list.length === 0) break;
        found = true;

        const rejected: CataloguePage['rejected'] = [];
        const records: CatalogueRecord[] = [];
        let fresh = 0;

        for (const row of list) {
          if (records.length >= budget()) break;
          const symbol = (row.symbol ?? '').trim().toUpperCase();
          if (!symbol) {
            rejected.push({ reason: 'missing symbol', sample: row.name });
            continue;
          }
          // The vendor sometimes returns cross-listed rows under an exchange
          // query; keep only lines whose own exchange field agrees, so an LSE
          // sync does not quietly absorb Frankfurt.
          if (row.exchange && !venue.query.some((q) => q.toLowerCase() === row.exchange!.trim().toLowerCase())) {
            rejected.push({ reason: `exchange mismatch: ${row.exchange}`, sample: symbol });
            continue;
          }
          if (seen.has(symbol)) continue;
          seen.add(symbol);
          fresh++;
          records.push(toEquityRecord(market, venue, feed.assetClass, row));
        }

        yield { records, label: `${venue.exchange} ${feed.path} p${page}`, rejected };

        // Terminate on a short page (the last one), on a page that added nothing
        // new (an endpoint ignoring `page`, which would otherwise loop until
        // MAX_PAGES_PER_FEED), or when the caller's limit is spent.
        if (list.length < PAGE_SIZE || fresh === 0 || budget() === 0) break;
        await sleep(this.options.spacingMs ?? REQUEST_SPACING_MS);
      }

      if (found) return; // this alias worked; do not re-fetch the venue under another name
    }
  }

  /**
   * Every FX pair the vendor lists — majors, minors and crosses in one request.
   *
   * `/forex_pairs` returns the full list in a single body, so there is no
   * pagination here. Each pair's quote currency is its own second leg, which
   * `resolveCurrencyPolicy` reads: USD/INR is priced in INR, not in dollars.
   */
  private async forexPage(
    key: string,
    options: CatalogueFetchOptions,
    budget: () => number,
  ): Promise<CataloguePage> {
    const body = await this.get<{ data?: TdForexRef[] }>(
      `${API}/forex_pairs?apikey=${encodeURIComponent(key)}`,
      options,
    );
    const rejected: CataloguePage['rejected'] = [];
    const records: CatalogueRecord[] = [];
    const seen = new Set<string>();

    for (const row of body.data ?? []) {
      if (records.length >= budget()) break;
      const symbol = (row.symbol ?? '').trim().toUpperCase();
      const [baseFromSymbol, quoteFromSymbol] = symbol.split('/');
      const base = (row.currency_base || baseFromSymbol || '').trim().toUpperCase();
      const quote = (row.currency_quote || quoteFromSymbol || '').trim().toUpperCase();
      if (!symbol || !base || !quote) {
        rejected.push({ reason: 'incomplete pair', sample: symbol || row.currency_base });
        continue;
      }
      if (seen.has(symbol)) continue;
      seen.add(symbol);

      const currency = resolveCurrencyPolicy({ market: 'FOREX', exchange: 'FX', quoteAsset: quote });
      records.push({
        market: 'FOREX',
        exchange: 'FX',
        symbol,
        displayName: `${base}/${quote}`,
        assetClass: 'CURRENCY_PAIR',
        // The vendor's pair list carries no status column, and an FX pair does
        // not delist the way a share does. UNKNOWN is the honest value.
        status: 'UNKNOWN',
        quoteCurrency: currency.quoteCurrency,
        provider: 'twelvedata',
        // The vendor addresses pairs by the slashed form, so that is what round-trips.
        providerSymbol: symbol,
        baseAsset: base,
        quoteAsset: quote,
        raw: row,
      });
    }

    return { records, label: 'forex_pairs', rejected };
  }

  private async get<T>(url: string, options: CatalogueFetchOptions): Promise<T> {
    const fetchImpl = options.fetchImpl ?? fetch;
    let lastError: unknown;

    // Three attempts with exponential backoff. A 429 on a catalogue endpoint is
    // recoverable and retrying beats failing a whole market's sync.
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort);
      try {
        const res = await fetchImpl(url, { signal: controller.signal });
        if (res.status === 429) {
          lastError = new Error('Twelve Data rate limit (429)');
        } else if (!res.ok) {
          throw new Error(`Twelve Data catalogue request failed: HTTP ${res.status}`);
        } else {
          const body = (await res.json()) as T & { status?: string; message?: string };
          // The vendor signals errors inside a 200 body; without this check a
          // quota breach parses as a successful empty catalogue.
          if (body && typeof body === 'object' && 'status' in body && body.status === 'error') {
            throw new Error(`Twelve Data: ${(body as { message?: string }).message ?? 'vendor error'}`);
          }
          return body;
        }
      } catch (err) {
        if (options.signal?.aborted) throw err;
        lastError = err;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
      await sleep(500 * 2 ** attempt);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** Map one vendor reference row. Exported for tests. */
export function toEquityRecord(
  market: UniverseMarket,
  venue: { exchange: UniverseExchange; mic: string },
  fallbackClass: UniverseAssetClass,
  row: TdStockRef,
): CatalogueRecord {
  const symbol = (row.symbol ?? '').trim().toUpperCase();
  const assetClass = TYPE_MAP[(row.type ?? '').trim().toLowerCase()] ?? fallbackClass;

  // The vendor's own per-instrument currency wins. For the LSE this is the
  // difference between a price in pence and a price a hundred times too small.
  const currency = resolveCurrencyPolicy({
    market,
    exchange: venue.exchange,
    providerCurrency: row.currency,
  });

  return {
    market,
    exchange: venue.exchange,
    mic: row.mic_code?.trim() || venue.mic,
    symbol,
    displayName: row.name?.trim() || symbol,
    assetClass,
    // The reference feeds list currently-listed instruments and publish no
    // status field. Presence is the vendor's statement that it is listed;
    // absence on a later complete run is what marks a row DELISTED.
    status: 'ACTIVE',
    quoteCurrency: normaliseCurrency(row.currency, currency.quoteCurrency),
    country: row.country?.trim(),
    isin: row.isin?.trim() || undefined,
    figi: row.figi_code?.trim() || undefined,
    cusip: row.cusip?.trim() || undefined,
    provider: 'twelvedata',
    // Twelve Data is addressed by plain ticker plus an `exchange` parameter, so
    // the ticker alone is the round-trip form.
    providerSymbol: symbol,
    raw: row,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
