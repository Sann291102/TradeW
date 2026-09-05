import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MARKET_SORT_ORDER,
  MAX_PAGE_SIZE,
  UniverseService,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  keysetPredicate,
} from './universe.service';

/**
 * The universe read path's boundaries.
 *
 * Everything asserted here is a property that only fails once the catalogue is
 * genuinely large — which is to say, in production and not in development. A
 * page ceiling that can be bypassed, a keyset that skips a row at a page
 * boundary, or a default filter that hides every FX pair are all invisible
 * against a seed database of forty instruments.
 *
 * No Nest context and no database: the service takes Prisma by injection, so a
 * hand-written stub is enough to observe the query it builds.
 */

/** Records the arguments the service hands Prisma, and returns fixed rows. */
function stubPrisma(rows: unknown[] = []) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    universeInstrument: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push(args);
        return rows;
      },
      findUnique: async () => null,
      groupBy: async () => [],
    },
    universeSyncRun: { findMany: async () => [] },
  };
}

const row = (over: Record<string, unknown> = {}) => ({
  ref: 'USA:NASDAQ:AAPL',
  market: 'USA',
  exchange: 'NASDAQ',
  mic: 'XNAS',
  symbol: 'AAPL',
  displayName: 'Apple Inc',
  assetClass: 'EQUITY',
  status: 'ACTIVE',
  quoteCurrency: 'USD',
  accountCurrency: 'USD',
  requiresFxConversion: false,
  country: 'United States',
  isin: null,
  baseAsset: null,
  quoteAsset: null,
  lotSize: null,
  provider: 'twelvedata',
  providerSymbol: 'AAPL',
  securityId: null,
  exchangeSegment: null,
  lastSeenAt: new Date('2026-09-05T00:00:00Z'),
  delistedAt: null,
  ...over,
});

describe('clampPageSize', () => {
  it('caps the page server-side so a client cannot request the whole universe', () => {
    // The entire point of this endpoint is that thousands of instruments never
    // reach the browser. A client-supplied limit is a suggestion, not a bound.
    expect(clampPageSize(999_999)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(50)).toBe(50);
  });

  it('falls back to the default for absent, zero and nonsense limits', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(-5)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe('cursors', () => {
  it('round-trips', () => {
    const cursor = { market: 'USA' as const, symbol: 'AAPL', ref: 'USA:NASDAQ:AAPL' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('restarts from the beginning on a malformed cursor instead of erroring', () => {
    // Almost always a stale bookmark or a truncated URL — not something worth
    // showing a user a 500 for.
    expect(decodeCursor('not-base64!!')).toBeNull();
    expect(decodeCursor(Buffer.from('{"market":"USA"}').toString('base64url'))).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});

describe('keysetPredicate', () => {
  it('matches the enum order Postgres actually sorts by', () => {
    // Postgres orders an enum column by DECLARATION order, not alphabetically.
    // If this drifts from schema.prisma, page boundaries silently skip rows.
    expect([...MARKET_SORT_ORDER]).toEqual(['INDIA', 'USA', 'UK', 'FOREX', 'CRYPTO']);
  });

  it('seeks past the cursor row within its market and into every later market', () => {
    const predicate = keysetPredicate({ market: 'USA', symbol: 'AAPL', ref: 'USA:NASDAQ:AAPL' });
    const branches = predicate.OR as Array<Record<string, unknown>>;

    const sameMarket = branches.find((b) => b.market === 'USA')!;
    expect(sameMarket.OR).toEqual([
      { symbol: { gt: 'AAPL' } },
      { symbol: 'AAPL', ref: { gt: 'USA:NASDAQ:AAPL' } },
    ]);

    // UK, FOREX and CRYPTO follow USA in declaration order; INDIA precedes it
    // and must not be revisited.
    const laterMarkets = branches.find((b) => typeof b.market === 'object')!;
    expect(laterMarkets.market).toEqual({ in: ['UK', 'FOREX', 'CRYPTO'] });
  });

  it('ends the walk on the last market rather than emitting an empty in-clause', () => {
    const predicate = keysetPredicate({ market: 'CRYPTO', symbol: 'BTCUSDT', ref: 'CRYPTO:BINANCE:BTCUSDT' });
    expect((predicate.OR as unknown[]).length).toBe(1);
  });

  it('treats a cursor naming an unknown market as the end, not as a restart', () => {
    const predicate = keysetPredicate({ market: 'ATLANTIS' as never, symbol: 'X', ref: 'X' });
    const branches = predicate.OR as Array<Record<string, unknown>>;
    expect(branches).toHaveLength(1);
    expect(branches[0].market).toBe('ATLANTIS');
  });
});

describe('UniverseService.search', () => {
  it('asks for one row more than the page, to answer hasMore without a COUNT', async () => {
    // A COUNT over a trigram search on a 10^5-row table is a full scan per
    // keystroke, and no screen here needs "of 41,921".
    const prisma = stubPrisma([]);
    const service = new UniverseService(prisma as never);
    await service.search({ limit: 25 });
    expect(prisma.calls[0].take).toBe(26);
  });

  it('returns a cursor only when there is genuinely another page', async () => {
    const service = new UniverseService(stubPrisma([row(), row({ ref: 'B', symbol: 'B' })]) as never);
    const result = await service.search({ limit: 2 });
    // Two rows for a page of two: the extra probe row was not returned, so this
    // is the last page.
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(2);
  });

  it('drops the probe row from the response and hands back a cursor', async () => {
    const rows = [row({ ref: 'A', symbol: 'A' }), row({ ref: 'B', symbol: 'B' }), row({ ref: 'C', symbol: 'C' })];
    const service = new UniverseService(stubPrisma(rows) as never);
    const result = await service.search({ limit: 2 });
    expect(result.items.map((i) => i.symbol)).toEqual(['A', 'B']);
    expect(result.hasMore).toBe(true);
    expect(decodeCursor(result.nextCursor!)).toEqual({ market: 'USA', symbol: 'B', ref: 'B' });
  });

  it('hides delisted instruments by default but keeps FX pairs, which have no status', async () => {
    const prisma = stubPrisma();
    await new UniverseService(prisma as never).search({});
    // UNKNOWN must be in the default view: every FX pair carries it, because the
    // vendor publishes no status for pairs. Excluding it empties the market.
    expect((prisma.calls[0].where as Record<string, unknown>).status).toEqual({ in: ['ACTIVE', 'UNKNOWN'] });
  });

  it('includes every lifecycle state on request, so an old journal entry still resolves', async () => {
    const prisma = stubPrisma();
    await new UniverseService(prisma as never).search({ includeInactive: true });
    expect((prisma.calls[0].where as Record<string, unknown>).status).toBeUndefined();
  });

  it('searches the single trigram-indexed column, lower-cased', async () => {
    const prisma = stubPrisma();
    await new UniverseService(prisma as never).search({ q: '  ReLiAnCe  ' });
    expect((prisma.calls[0].where as Record<string, unknown>).searchText).toEqual({ contains: 'reliance' });
  });

  it('orders by the index the keyset walks, with a unique tiebreaker', async () => {
    const prisma = stubPrisma();
    await new UniverseService(prisma as never).search({});
    // `ref` is what makes the keyset total — without a unique final key, a page
    // boundary between two equal sort keys can skip or repeat a row.
    expect(prisma.calls[0].orderBy).toEqual([{ market: 'asc' }, { symbol: 'asc' }, { ref: 'asc' }]);
  });

  it('serves an identical repeat query from cache rather than re-querying', async () => {
    const prisma = stubPrisma();
    const service = new UniverseService(prisma as never);
    await service.search({ q: 'rel', market: 'INDIA' });
    await service.search({ q: 'rel', market: 'INDIA' });
    // The dominant load on this endpoint is many clients typing the same few
    // prefixes.
    expect(prisma.calls).toHaveLength(1);
  });

  it('keeps both currency facts distinct on the way out, and converts neither', async () => {
    const service = new UniverseService(
      stubPrisma([
        row({
          ref: 'UK:LSE:VOD',
          market: 'UK',
          exchange: 'LSE',
          symbol: 'VOD',
          quoteCurrency: 'GBX',
          accountCurrency: 'USD',
          requiresFxConversion: true,
        }),
      ]) as never,
    );
    const [item] = (await service.search({})).items;
    expect(item.quoteCurrency).toBe('GBX');
    expect(item.accountCurrency).toBe('USD');
    expect(item.requiresFxConversion).toBe(true);
  });
});
