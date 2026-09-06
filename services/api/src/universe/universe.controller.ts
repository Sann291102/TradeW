import { Controller, Get, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UniverseAssetClass, UniverseMarket, UniverseStatus } from '@prisma/client';
import { PUBLIC_PROXY_LIMIT } from '../common/throttling';
import { MAX_PAGE_SIZE, UniverseService } from './universe.service';

/**
 * The tradable universe — read-only catalogue browsing.
 *
 * PUBLIC, no AuthGuard, for the same reason the crypto/forex/us-stocks proxies
 * are: this is reference data with no user scoping and nothing that varies by
 * who is asking. Which instruments exist on the NSE is not a secret, and
 * auth-gating it would mean a signed-out visitor could see live NIFTY prices
 * through the feed bridge but not the list of what NIFTY contains.
 *
 * Everything user-scoped — orders, positions, wallets — stays behind AuthGuard.
 *
 * THE PAGE CEILING IS THE POINT. Every route here is bounded: `limit` is clamped
 * server-side to MAX_PAGE_SIZE and pagination is keyset-based, so no request can
 * pull the catalogue into a browser. That constraint is the reason this endpoint
 * exists at all rather than an "all instruments" fetch on the client.
 */
@Throttle(PUBLIC_PROXY_LIMIT)
@ApiTags('Universe')
@Controller('universe')
export class UniverseController {
  constructor(private readonly universe: UniverseService) {}

  /**
   * GET /universe/search?q=rel&market=INDIA&exchange=NSE&limit=25&cursor=…
   *
   * Free-text over symbol, name, ISIN and pair legs, filtered and paginated.
   * Returns at most `MAX_PAGE_SIZE` rows plus an opaque `nextCursor`.
   */
  @Get('search')
  @ApiOperation({
    summary: 'Search the tradable universe',
    description:
      `Keyset-paginated search across all five markets. Page size is capped at ${MAX_PAGE_SIZE} ` +
      'server-side. Every row carries quoteCurrency (what the venue prices in) and accountCurrency ' +
      '(what the paper account settles in) as separate fields; no price is ever converted here.',
  })
  search(
    @Query('q') q?: string,
    @Query('market') market?: string,
    @Query('markets') markets?: string,
    @Query('exchange') exchange?: string,
    @Query('assetClass') assetClass?: string,
    @Query('status') status?: string,
    @Query('currency') currency?: string,
    @Query('includeInactive') includeInactive?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.universe.search({
      q,
      market: parseEnum(market, UniverseMarket),
      markets: markets
        ?.split(',')
        .map((m) => parseEnum(m, UniverseMarket))
        .filter((m): m is UniverseMarket => m !== undefined),
      exchange,
      assetClass: parseEnum(assetClass, UniverseAssetClass),
      status: parseEnum(status, UniverseStatus),
      currency,
      includeInactive: includeInactive === 'true',
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      cursor,
    });
  }

  /**
   * GET /universe/facets — which markets, exchanges and asset classes hold
   * something, and how much. Drives the filter bar without a full download.
   */
  @Get('facets')
  facets() {
    return this.universe.facets();
  }

  /** GET /universe/stats — size and freshness per market, plus recent syncs. */
  @Get('stats')
  stats() {
    return this.universe.stats();
  }

  /**
   * GET /universe/ref/USA:NASDAQ:AAPL — one instrument by its full address.
   *
   * Routed under `/ref/` rather than `/:ref` so it can never shadow `search`,
   * `facets` or `stats`, which would otherwise be reachable as refs.
   */
  @Get('ref/:ref')
  byRef(@Param('ref') ref: string) {
    return this.universe.byRef(ref);
  }
}

/**
 * Accept a query-string value only if it is a real enum member.
 *
 * An unrecognised value becomes `undefined` — no filter — rather than an error.
 * A stale bookmark with `?assetClass=STOCK` should show the unfiltered universe,
 * not a 400, and Prisma would reject an unknown enum value at the driver level
 * with a message no user should ever see.
 */
function parseEnum<T extends Record<string, string>>(value: string | undefined, enumObject: T): T[keyof T] | undefined {
  if (!value) return undefined;
  const upper = value.trim().toUpperCase();
  return (Object.values(enumObject) as string[]).includes(upper) ? (upper as T[keyof T]) : undefined;
}
