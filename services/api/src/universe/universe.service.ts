import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UniverseAssetClass, UniverseMarket, UniverseStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Tradable-universe READS.
 *
 * The catalogue is large by design — a complete NSE + BSE + NYSE + NASDAQ +
 * AMEX + LSE + FX + Binance universe is on the order of 10^5 rows — and this
 * service exists so that size never reaches a browser or a request handler.
 * Three properties make that work:
 *
 *  1. KEYSET PAGINATION, NOT OFFSET. Pages are addressed by the last row's sort
 *     key, so page 400 costs exactly what page 1 costs. `OFFSET 20000` makes
 *     Postgres walk and discard 20,000 rows on every request, which is precisely
 *     the failure a large catalogue produces and precisely the failure that only
 *     shows up once the data is real.
 *
 *  2. A HARD PAGE CEILING. `MAX_PAGE_SIZE` is enforced server-side, not
 *     suggested. A client cannot ask for the whole universe by passing
 *     `limit=999999`, because the one thing this design must prevent is
 *     thousands of instruments being loaded into the browser at once.
 *
 *  3. ONE TRIGRAM-INDEXED SEARCH COLUMN. `searchText` holds symbol, name, ISIN
 *     and pair legs lower-cased in a single column with a GIN trigram index, so
 *     a free-text query is one index scan rather than four ILIKEs OR'd across
 *     the table.
 *
 * CURRENCY. Every row carries `quoteCurrency` (what the venue prices in) and
 * `accountCurrency` (what the paper account settles in) as two separate fields,
 * and this service never converts between them. A UK row goes out as GBX with
 * `requiresFxConversion: true`, and the decision to show a dollar figure — with
 * a real rate, attributed — belongs to whoever has a live FX source. Converting
 * here would bury an exchange rate inside a catalogue lookup.
 */

/** What a client may ask for in one page. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Facet counts are stable for minutes and expensive to recompute per keystroke. */
const FACET_CACHE_TTL_MS = 60_000;
/**
 * Short-lived search cache. The dominant load on this endpoint is many clients
 * typing the same few prefixes; 10s is long enough to collapse that and short
 * enough that a sync's changes appear promptly.
 */
const SEARCH_CACHE_TTL_MS = 10_000;
const SEARCH_CACHE_MAX_ENTRIES = 500;

export interface UniverseSearchQuery {
  q?: string;
  market?: UniverseMarket;
  markets?: UniverseMarket[];
  exchange?: string;
  assetClass?: UniverseAssetClass;
  status?: UniverseStatus;
  /** Include DELISTED/INACTIVE rows. Off by default — see `statusFilter`. */
  includeInactive?: boolean;
  currency?: string;
  limit?: number;
  /** Opaque keyset cursor from the previous page's `nextCursor`. */
  cursor?: string;
}

export interface UniverseInstrumentDto {
  ref: string;
  market: UniverseMarket;
  exchange: string;
  mic: string | null;
  symbol: string;
  displayName: string;
  assetClass: UniverseAssetClass;
  status: UniverseStatus;
  /** What the VENUE quotes in. Never converted. */
  quoteCurrency: string;
  /** What the PAPER ACCOUNT settles in. */
  accountCurrency: string;
  /** True when showing this instrument in account currency needs an FX rate. */
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

export interface UniverseSearchResult {
  items: UniverseInstrumentDto[];
  /** Pass back as `cursor` for the next page. Null when the page is the last. */
  nextCursor: string | null;
  pageSize: number;
  /**
   * Deliberately absent. A COUNT over a filtered trigram search on a table this
   * size is a full scan per keystroke, and no UI here needs "of 41,921" — it
   * needs "is there more", which `nextCursor` answers exactly. Use
   * /universe/stats for cardinality.
   */
  hasMore: boolean;
}

@Injectable()
export class UniverseService {
  private facetCache: { at: number; value: UniverseFacets } | null = null;
  private readonly searchCache = new Map<string, { at: number; value: UniverseSearchResult }>();

  constructor(private readonly prisma: PrismaService) {}

  async search(query: UniverseSearchQuery): Promise<UniverseSearchResult> {
    const pageSize = clampPageSize(query.limit);
    const cacheKey = JSON.stringify({ ...query, limit: pageSize });
    const cached = this.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return cached.value;

    const where = this.buildWhere(query);
    const cursor = decodeCursor(query.cursor);

    // The sort key is (market, symbol, ref). `ref` is the tiebreaker and is
    // unique, which is what makes the keyset total: without it, two rows with
    // the same (market, symbol) — impossible today, but only because of a
    // constraint that could be relaxed — would make a page boundary ambiguous
    // and could skip or repeat a row.
    if (cursor) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        keysetPredicate(cursor),
      ];
    }

    // One extra row is fetched purely to answer "is there another page" without
    // a COUNT. It is dropped before the response is built.
    const rows = await this.prisma.universeInstrument.findMany({
      where,
      orderBy: [{ market: 'asc' }, { symbol: 'asc' }, { ref: 'asc' }],
      take: pageSize + 1,
    });

    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
    const last = page[page.length - 1];

    const result: UniverseSearchResult = {
      items: page.map(toDto),
      nextCursor: hasMore && last ? encodeCursor({ market: last.market, symbol: last.symbol, ref: last.ref }) : null,
      pageSize,
      hasMore,
    };

    this.rememberSearch(cacheKey, result);
    return result;
  }

  /** One instrument by its `MARKET:EXCHANGE:SYMBOL` ref. */
  async byRef(ref: string): Promise<UniverseInstrumentDto> {
    const row = await this.prisma.universeInstrument.findUnique({ where: { ref: ref.trim().toUpperCase() } });
    if (!row) throw new NotFoundException(`No instrument in the universe with ref '${ref}'`);
    return toDto(row);
  }

  /**
   * Facet counts for the filter UI — which markets, exchanges and asset classes
   * actually contain something, and how much.
   *
   * Cached for a minute: these are three GROUP BY queries over the whole table
   * and they change only when a sync runs, which is daily.
   */
  async facets(): Promise<UniverseFacets> {
    if (this.facetCache && Date.now() - this.facetCache.at < FACET_CACHE_TTL_MS) return this.facetCache.value;

    const tradable = { status: { in: ['ACTIVE', 'UNKNOWN'] as UniverseStatus[] } };
    const [byMarket, byExchange, byAssetClass, byStatus] = await Promise.all([
      this.prisma.universeInstrument.groupBy({ by: ['market'], where: tradable, _count: { _all: true } }),
      this.prisma.universeInstrument.groupBy({ by: ['market', 'exchange'], where: tradable, _count: { _all: true } }),
      this.prisma.universeInstrument.groupBy({ by: ['market', 'assetClass'], where: tradable, _count: { _all: true } }),
      this.prisma.universeInstrument.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const value: UniverseFacets = {
      markets: byMarket
        .map((r) => ({
          market: r.market,
          count: r._count._all,
          // Restated here so a client rendering the filter bar never has to
          // hard-code the INR/USD split — and so there is exactly one place in
          // the system that decides it.
          accountCurrency: ACCOUNT_CURRENCY[r.market],
        }))
        .sort((a, b) => a.market.localeCompare(b.market)),
      exchanges: byExchange
        .map((r) => ({ market: r.market, exchange: r.exchange, count: r._count._all }))
        .sort((a, b) => b.count - a.count),
      assetClasses: byAssetClass
        .map((r) => ({ market: r.market, assetClass: r.assetClass, count: r._count._all }))
        .sort((a, b) => b.count - a.count),
      statuses: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
    };

    this.facetCache = { at: Date.now(), value };
    return value;
  }

  /**
   * Freshness and size, per market — the answer to "is the universe current?".
   *
   * Reported from `UniverseSyncRun` rather than inferred from row timestamps: a
   * run that failed leaves the rows untouched and perfectly fresh-looking, so
   * row age cannot distinguish "nothing changed" from "nothing ran".
   */
  async stats(): Promise<UniverseStats> {
    const [counts, runs] = await Promise.all([
      this.prisma.universeInstrument.groupBy({ by: ['market', 'status'], _count: { _all: true } }),
      this.prisma.universeSyncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }),
    ]);

    const byMarket = new Map<UniverseMarket, UniverseStats['markets'][number]>();
    for (const row of counts) {
      const entry = byMarket.get(row.market) ?? {
        market: row.market,
        accountCurrency: ACCOUNT_CURRENCY[row.market],
        total: 0,
        active: 0,
        delisted: 0,
      };
      entry.total += row._count._all;
      if (row.status === 'ACTIVE') entry.active += row._count._all;
      if (row.status === 'DELISTED') entry.delisted += row._count._all;
      byMarket.set(row.market, entry);
    }

    return {
      markets: [...byMarket.values()].sort((a, b) => a.market.localeCompare(b.market)),
      recentSyncs: runs.map((r) => ({
        source: r.source,
        market: r.market,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        discovered: r.discovered,
        created: r.created,
        updated: r.updated,
        delisted: r.delisted,
        truncated: r.truncated,
      })),
    };
  }

  private buildWhere(query: UniverseSearchQuery): Prisma.UniverseInstrumentWhereInput {
    const where: Prisma.UniverseInstrumentWhereInput = {};

    if (query.markets?.length) where.market = { in: query.markets };
    else if (query.market) where.market = query.market;

    if (query.exchange) where.exchange = query.exchange.trim().toUpperCase();
    if (query.assetClass) where.assetClass = query.assetClass;
    if (query.currency) {
      // Matches either side of the currency pair of facts, because both are
      // things a user might mean by "USD": priced in dollars, or settled in a
      // dollar account.
      const currency = query.currency.trim().toUpperCase();
      where.OR = [{ quoteCurrency: currency }, { accountCurrency: currency }];
    }

    where.status = this.statusFilter(query);

    const q = query.q?.trim().toLowerCase();
    if (q) {
      // Substring, not prefix: users search for "reliance" expecting
      // RELIANCE, for "bank" expecting every bank, and for a partial ISIN. The
      // trigram index is what makes a leading wildcard affordable.
      where.searchText = { contains: q };
    }

    return where;
  }

  /**
   * Which lifecycle states a search returns.
   *
   * Delisted and inactive instruments are excluded by DEFAULT but reachable on
   * request. Both halves matter: someone browsing what to trade should not be
   * offered a company that no longer exists, and someone opening a two-year-old
   * journal entry must still be able to resolve the instrument it names.
   *
   * UNKNOWN is included in the default view. It means the provider publishes no
   * status — true of every FX pair — and hiding those would empty the forex
   * market entirely.
   */
  private statusFilter(query: UniverseSearchQuery): Prisma.EnumUniverseStatusFilter | undefined {
    if (query.status) return { equals: query.status };
    if (query.includeInactive) return undefined;
    return { in: ['ACTIVE', 'UNKNOWN'] };
  }

  private rememberSearch(key: string, value: UniverseSearchResult): void {
    // Bounded, oldest-out. An unbounded cache keyed by user-supplied query text
    // is a memory leak with a friendly name.
    if (this.searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = this.searchCache.keys().next().value;
      if (oldest !== undefined) this.searchCache.delete(oldest);
    }
    this.searchCache.set(key, { at: Date.now(), value });
  }
}

/**
 * The paper-account currency per market, restated for read paths.
 *
 * Mirrors `ACCOUNT_CURRENCY_BY_MARKET` in @tradew/market-data, which is the
 * owner. It is duplicated here only as a Prisma-enum-keyed lookup so the facet
 * and stats responses can label markets without importing the whole catalogue
 * library into a read path; the values must not drift.
 */
const ACCOUNT_CURRENCY: Readonly<Record<UniverseMarket, string>> = {
  INDIA: 'INR',
  USA: 'USD',
  UK: 'USD',
  FOREX: 'USD',
  CRYPTO: 'USD',
};

export interface UniverseFacets {
  markets: Array<{ market: UniverseMarket; count: number; accountCurrency: string }>;
  exchanges: Array<{ market: UniverseMarket; exchange: string; count: number }>;
  assetClasses: Array<{ market: UniverseMarket; assetClass: UniverseAssetClass; count: number }>;
  statuses: Array<{ status: UniverseStatus; count: number }>;
}

export interface UniverseStats {
  markets: Array<{ market: UniverseMarket; accountCurrency: string; total: number; active: number; delisted: number }>;
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

export interface Cursor {
  market: UniverseMarket;
  symbol: string;
  ref: string;
}

/**
 * The sort order Postgres applies to `UniverseMarket`.
 *
 * Postgres orders an enum column by DECLARATION order, not alphabetically, so
 * `ORDER BY market ASC` yields INDIA, USA, UK, FOREX, CRYPTO — the order these
 * values appear in schema.prisma. The keyset seek below has to agree with that
 * exactly or a page boundary skips rows, so the order is written out here
 * rather than assumed. It must stay in step with the enum's declaration.
 */
export const MARKET_SORT_ORDER: readonly UniverseMarket[] = ['INDIA', 'USA', 'UK', 'FOREX', 'CRYPTO'];

/**
 * "Everything sorting after this row", as the keyset seek:
 *   market > m  OR  (market = m AND (symbol > s  OR  (symbol = s AND ref > r)))
 *
 * Written as nested ORs because Prisma has no row-constructor syntax, and the
 * `market >` half is expressed as an `in` over the markets that follow the
 * cursor's — Prisma offers no `gt` on an enum field, and enumerating the
 * successors is both exact and, at five values, free.
 */
export function keysetPredicate(cursor: Cursor): Prisma.UniverseInstrumentWhereInput {
  const index = MARKET_SORT_ORDER.indexOf(cursor.market);
  // An unrecognised market in a cursor means it was minted before an enum
  // change. Treating it as "no markets follow" is the safe reading: the page
  // ends rather than silently restarting the scan from the top.
  const laterMarkets = index === -1 ? [] : MARKET_SORT_ORDER.slice(index + 1);

  const after: Prisma.UniverseInstrumentWhereInput[] = [
    {
      market: cursor.market,
      OR: [
        { symbol: { gt: cursor.symbol } },
        { symbol: cursor.symbol, ref: { gt: cursor.ref } },
      ],
    },
  ];
  if (laterMarkets.length > 0) after.push({ market: { in: [...laterMarkets] } });

  return { OR: after };
}

/** Opaque to clients on purpose — its shape is an implementation detail. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.market !== 'string' || typeof parsed.symbol !== 'string' || typeof parsed.ref !== 'string') {
      return null;
    }
    return parsed as Cursor;
  } catch {
    // A malformed cursor restarts from the beginning rather than 500ing: it is
    // almost always a stale bookmark or a truncated URL, and neither is an error
    // worth showing a user.
    return null;
  }
}

export function clampPageSize(limit: number | undefined): number {
  if (!Number.isFinite(limit as number) || (limit as number) <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.floor(limit as number));
}

type UniverseRow = Prisma.UniverseInstrumentGetPayload<Record<string, never>>;

function toDto(row: UniverseRow): UniverseInstrumentDto {
  return {
    ref: row.ref,
    market: row.market,
    exchange: row.exchange,
    mic: row.mic,
    symbol: row.symbol,
    displayName: row.displayName,
    assetClass: row.assetClass,
    status: row.status,
    quoteCurrency: row.quoteCurrency,
    accountCurrency: row.accountCurrency,
    requiresFxConversion: row.requiresFxConversion,
    country: row.country,
    isin: row.isin,
    baseAsset: row.baseAsset,
    quoteAsset: row.quoteAsset,
    lotSize: row.lotSize,
    provider: row.provider,
    providerSymbol: row.providerSymbol,
    securityId: row.securityId,
    exchangeSegment: row.exchangeSegment,
    lastSeenAt: row.lastSeenAt.toISOString(),
    delistedAt: row.delistedAt?.toISOString() ?? null,
  };
}
