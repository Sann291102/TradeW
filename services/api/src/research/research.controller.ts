import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { PeriodType, StatementType } from '@tradew/market-data';
import { AuthGuard } from '../auth/auth.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { PUBLIC_PROXY_LIMIT } from '../common/throttling';
import { CapabilityGuard, RequiresCapability } from '../entitlements/capability.guard';
import { ResearchService } from './research.service';
import { ResearchAnalysisService } from './research-analysis.service';

/**
 * Fundamental research.
 *
 * ── ACCESS MODEL ───────────────────────────────────────────────────────────
 *
 * Everything here is behind `AuthGuard` (the whole workspace is) and NOTHING
 * except `/analysis` is behind `CapabilityGuard`. That is a deliberate product
 * decision, not an oversight: a trader who cannot read a balance sheet cannot
 * do fundamental research at all, so the statements, the ratios computed from
 * them, the history, ownership and segments are available on every plan
 * including free. Only the AI synthesis — which costs a model call per request
 * — requires the `ai_research` capability, which `tradew_pro`,
 * `tradew_ultimate` and `enterprise` already grant.
 *
 * ── RATE LIMIT ─────────────────────────────────────────────────────────────
 *
 * `PUBLIC_PROXY_LIMIT`, same as the other vendor-proxying controllers. It meters
 * THIS service's availability, not the vendor's — the vendor's credit budget is
 * protected by the durable cache in `ResearchCacheService`, so a hot symbol
 * costs one upstream call per TTL regardless of how many callers ask.
 *
 * ── WHY ONE CONSOLIDATED ENDPOINT PLUS PER-SECTION ONES ────────────────────
 *
 * `GET /research/:symbol` serves the page load in one round trip, because every
 * section shares the same three statement fetches; nine separate calls would
 * multiply cache lookups and, on a cold symbol, upstream cost. The per-section
 * routes exist for the narrower reads the UI genuinely makes on their own — a
 * period-type switch that only needs the statements, and the AI analysis, which
 * is entitlement-gated and must therefore be its own route.
 */
@Throttle(PUBLIC_PROXY_LIMIT)
@ApiTags('Research')
@ApiBearerAuth(SECURITY.bearer)
@UseGuards(AuthGuard)
@Controller('research')
export class ResearchController {
  constructor(
    private readonly research: ResearchService,
    private readonly analysis: ResearchAnalysisService,
  ) {}

  /**
   * Company/symbol search, exchange-aware.
   *
   * Deliberately NOT backed by the local `Instrument` table: those rows are
   * tradeable contracts (including option strikes) with no fundamentals
   * coverage, so every hit would lead to a company page that cannot load. A
   * search that cannot reach the provider returns zero results WITH a reason,
   * never a substituted list.
   */
  @ApiOperation({ summary: 'Search companies by symbol or name' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @Get('search')
  search(@Query('q') q?: string, @Query('limit') limit?: string) {
    const n = Number(limit);
    return this.research.search(q ?? '', Number.isFinite(n) && n > 0 ? Math.min(n, 30) : 15);
  }

  /** The consolidated page load. */
  @ApiOperation({ summary: 'Full research snapshot for one company' })
  @ApiQuery({ name: 'period', required: false, enum: ['annual', 'quarterly'] })
  @Get(':symbol')
  snapshot(@Param('symbol') symbol: string, @Query('period') period?: string) {
    return this.research.snapshot(cleanSymbol(symbol), periodType(period));
  }

  /** One statement. Used by the annual/quarterly switch. */
  @ApiOperation({ summary: 'One financial statement' })
  @ApiQuery({ name: 'period', required: false, enum: ['annual', 'quarterly'] })
  @Get(':symbol/statement/:type')
  statement(
    @Param('symbol') symbol: string,
    @Param('type') type: string,
    @Query('period') period?: string,
  ) {
    return this.research.statementSection(cleanSymbol(symbol), statementType(type), periodType(period));
  }

  @ApiOperation({ summary: 'Ratios computed from the cached statements' })
  @ApiQuery({ name: 'period', required: false, enum: ['annual', 'quarterly'] })
  @Get(':symbol/ratios')
  ratios(@Param('symbol') symbol: string, @Query('period') period?: string) {
    return this.research.ratiosSection(cleanSymbol(symbol), periodType(period));
  }

  @ApiOperation({ summary: 'Historical series for the performance charts' })
  @ApiQuery({ name: 'period', required: false, enum: ['annual', 'quarterly'] })
  @Get(':symbol/history')
  history(@Param('symbol') symbol: string, @Query('period') period?: string) {
    return this.research.historySection(cleanSymbol(symbol), periodType(period));
  }

  @ApiOperation({ summary: 'Shareholding / ownership breakdown' })
  @Get(':symbol/ownership')
  ownership(@Param('symbol') symbol: string) {
    return this.research.ownershipSection(cleanSymbol(symbol));
  }

  @ApiOperation({ summary: 'Revenue by business line / geography' })
  @Get(':symbol/segments')
  segments(@Param('symbol') symbol: string) {
    return this.research.segmentsSection(cleanSymbol(symbol));
  }

  @ApiOperation({ summary: 'Company-specific news with sentiment and event classification' })
  @Get(':symbol/news')
  news(@Param('symbol') symbol: string) {
    return this.research.companyNewsSection(cleanSymbol(symbol));
  }

  @ApiOperation({ summary: 'Structured analyst coverage derived from company news when available' })
  @Get(':symbol/analyst')
  analyst(@Param('symbol') symbol: string) {
    return this.research.analystResearchSection(cleanSymbol(symbol));
  }

  @ApiOperation({ summary: 'Earnings history and upcoming earnings events' })
  @ApiQuery({ name: 'period', required: false, enum: ['annual', 'quarterly'] })
  @Get(':symbol/earnings')
  earnings(@Param('symbol') symbol: string, @Query('period') period?: string) {
    return this.research.earningsSection(cleanSymbol(symbol), periodType(period));
  }

  @ApiOperation({ summary: 'Valuation metrics and scenario framing' })
  @ApiQuery({ name: 'period', required: false, enum: ['annual', 'quarterly'] })
  @Get(':symbol/valuation')
  valuation(@Param('symbol') symbol: string, @Query('period') period?: string) {
    return this.research.valuationSection(cleanSymbol(symbol), periodType(period));
  }

  @ApiOperation({ summary: 'Peer and sector comparison from cached/local graph data' })
  @ApiQuery({ name: 'period', required: false, enum: ['annual', 'quarterly'] })
  @Get(':symbol/peers')
  peers(@Param('symbol') symbol: string, @Query('period') period?: string) {
    return this.research.peerSection(cleanSymbol(symbol), periodType(period));
  }

  @ApiOperation({ summary: 'Knowledge-graph relationships for the selected company' })
  @Get(':symbol/graph')
  graph(@Param('symbol') symbol: string) {
    return this.research.knowledgeGraphSection(cleanSymbol(symbol));
  }

  /**
   * PREMIUM — the only gated route on this controller.
   *
   * `CapabilityGuard` runs after `AuthGuard` and returns 403 with the capability
   * and reason, which the UI renders as an upgrade prompt beside statements that
   * are still fully readable.
   */
  @ApiOperation({ summary: 'AI synthesis grounded in the retrieved statements (requires ai_research)' })
  @ApiQuery({ name: 'period', required: false, enum: ['annual', 'quarterly'] })
  @UseGuards(CapabilityGuard)
  @RequiresCapability('ai_research')
  @Get(':symbol/analysis')
  analyse(@Param('symbol') symbol: string, @Query('period') period?: string) {
    return this.analysis.analyse(cleanSymbol(symbol), periodType(period));
  }
}

/**
 * Symbol sanitisation.
 *
 * The value is interpolated into an outbound vendor URL, so it is constrained
 * to the character set real tickers use — letters, digits, dot, dash, colon and
 * underscore (BRK.B, RELIANCE, 500325, XNSE:INFY). Anything else is rejected
 * rather than encoded through, so this route can never be used to shape a
 * request to a path the vendor client did not intend.
 */
function cleanSymbol(raw: string): string {
  const symbol = (raw ?? '').trim().toUpperCase();
  if (!symbol) throw new BadRequestException('A symbol is required');
  if (symbol.length > 32) throw new BadRequestException('That symbol is too long to be real');
  if (!/^[A-Z0-9.\-:_]+$/.test(symbol)) {
    throw new BadRequestException('A symbol may contain only letters, digits, and . - : _');
  }
  return symbol;
}

function periodType(raw?: string): PeriodType {
  return raw === 'quarterly' ? 'quarterly' : 'annual';
}

function statementType(raw: string): StatementType {
  const normalized = raw.replace(/-/g, '_').toLowerCase();
  if (normalized === 'income' || normalized === 'balance' || normalized === 'cash_flow') return normalized;
  throw new BadRequestException("Statement type must be one of: income, balance, cash-flow");
}
