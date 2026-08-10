import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CapabilityGuard, RequiresCapability } from '../entitlements/capability.guard';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { SECURITY } from '../swagger/swagger.setup';
import { SentinelApiService } from './sentinel.service';

type AuthedRequest = { user: { sub: string } };

/**
 * DOCUMENTATION MODELS ONLY — see the equivalent note in
 * `entitlements.controller.ts`. The handlers keep their inline `@Body()` types
 * so the global `ValidationPipe` continues to skip them; these classes exist to
 * give the generated reference a real schema and are attached with
 * `@ApiBody({ type })`.
 */
class ObserveBody {
  @ApiProperty({ required: false, default: 'NIFTY', example: 'NIFTY' })
  symbol?: string;

  @ApiProperty({ required: false, description: 'Free-text context for this observation.' })
  context?: string;

  @ApiProperty({
    required: false,
    type: [Object],
    description:
      'Demo/paper bridge. Client-side simulator trades, used for THIS call only and never persisted. ' +
      'A brokerage-linked account omits these — its trades are read from Postgres instead.',
  })
  clientTrades?: unknown[];

  @ApiProperty({ required: false, type: [Object], description: 'As `clientTrades`, for open positions.' })
  clientPositions?: unknown[];

  @ApiProperty({ required: false, enum: ['auto', 'manual'], default: 'auto' })
  strategyMode?: 'auto' | 'manual';

  @ApiProperty({ required: false, type: [String], description: 'Strategy ids to focus on when `strategyMode` is manual.' })
  selectedStrategyIds?: string[];

  @ApiProperty({ required: false, deprecated: true, description: 'Singular predecessor of `selectedStrategyIds`.' })
  selectedStrategyId?: string;

  @ApiProperty({ required: false, description: 'Override the confidence gate for this call.', example: 0.7 })
  confidenceThreshold?: number;
}

class ExplainBody {
  @ApiProperty({ example: 'Why did NIFTY reverse at the open?' })
  question!: string;

  @ApiProperty({ required: false })
  context?: string;
}

class BrainSearchBody {
  @ApiProperty({ example: 'opening range breakout' })
  query!: string;

  @ApiProperty({ required: false, description: 'Restrict the search to one memory namespace.' })
  namespace?: string;

  @ApiProperty({ required: false, example: 20 })
  limit?: number;
}

class MarketCloseReviewBody {
  @ApiProperty({ required: false, default: 'NIFTY', example: 'NIFTY' })
  symbol?: string;
}

class JournalEntryBody {
  @ApiProperty({ description: 'The entry itself.' })
  content!: string;

  @ApiProperty({ required: false, example: 'calm' })
  mood?: string;

  @ApiProperty({ required: false, type: [String] })
  tags?: string[];
}

/**
 * Public Sentinel endpoints. Every route requires the 'sentinel' entitlement,
 * decided by the centralized EntitlementsService (never a hardcoded check),
 * and premium AI requests are metered against the plan's quota.
 */
@ApiTags('Sentinel')
@ApiBearerAuth(SECURITY.bearer)
@ApiResponse({
  status: 403,
  description:
    'Missing the `sentinel` entitlement, or the plan’s quota is spent. The body carries ' +
    '`capability`, `reason` and the quota state so the client can render an upgrade prompt.',
})
@UseGuards(AuthGuard, CapabilityGuard)
@RequiresCapability('sentinel')
@Controller('sentinel')
export class SentinelController {
  constructor(
    private readonly sentinel: SentinelApiService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @ApiBody({ type: ObserveBody })
  @Post('observe')
  async observe(
    @Req() req: AuthedRequest,
    @Body()
    body: {
      symbol?: string;
      context?: string;
      // Demo/paper-account bridge: apps/terminal runs its own client-side
      // paper-trading simulator, so its trades never land in this service's
      // Trade/Position tables. When supplied, these take priority over the
      // DB-derived history for THIS call only — nothing is persisted from
      // them. A real brokerage-linked account never sends these; its trades
      // already live in Postgres and are read there instead.
      clientTrades?: unknown[];
      clientPositions?: unknown[];
      // Phase 3 strategy focus — auto (default) or one or more manually
      // selected educational strategies, plus an optional confidence-
      // threshold override.
      strategyMode?: 'auto' | 'manual';
      /** Phase 2 (multi-strategy) — preferred over `selectedStrategyId`. */
      selectedStrategyIds?: string[];
      /** @deprecated singular predecessor of `selectedStrategyIds`. */
      selectedStrategyId?: string;
      confidenceThreshold?: number;
    },
  ) {
    const result = await this.sentinel.observe(
      req.user.sub,
      body?.symbol,
      body?.context,
      { clientTrades: body?.clientTrades, clientPositions: body?.clientPositions },
      {
        strategyMode: body?.strategyMode,
        selectedStrategyIds: body?.selectedStrategyIds,
        selectedStrategyId: body?.selectedStrategyId,
        confidenceThreshold: body?.confidenceThreshold,
      },
    );
    await this.entitlements.recordUsage(req.user.sub, 'sentinel_requests');
    return result;
  }

  /** Phase 3 — the educational strategy registry driving the strategy selector. */
  @Get('strategies/registry')
  strategyRegistry(@Query('exposed') exposed?: string) {
    return this.sentinel.strategyRegistry(exposed === undefined ? true : exposed === 'true');
  }

  @ApiBody({ type: ExplainBody })
  @Post('explain')
  async explain(@Req() req: AuthedRequest, @Body() body: { question: string; context?: string }) {
    const result = await this.sentinel.explain(req.user.sub, body.question, body?.context);
    await this.entitlements.recordUsage(req.user.sub, 'ai_requests');
    return result;
  }

  /** Knowledge Center — query surface over the Brain's accumulated memory. */
  @ApiBody({ type: BrainSearchBody })
  @Post('brain/search')
  async brainSearch(@Req() req: AuthedRequest, @Body() body: { query: string; namespace?: string; limit?: number }) {
    const result = await this.sentinel.brainSearch(req.user.sub, body.query, body.namespace, body.limit);
    await this.entitlements.recordUsage(req.user.sub, 'ai_requests');
    return result;
  }

  /** Strategy Intelligence Framework — cross-symbol historical base rate for a pattern. */
  @Get('brain/strategy')
  async brainStrategy(@Query('pattern') pattern: string) {
    return this.sentinel.brainStrategy(pattern);
  }

  @Get('observations')
  observations(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.sentinel.observations(req.user.sub, limit ? Number(limit) : 50);
  }

  /**
   * Module 8 — the running session narrative. `since` returns only entries
   * after that ISO timestamp, so a polling client appends rather than
   * re-rendering the whole session.
   */
  @Get('timeline')
  timeline(@Req() req: AuthedRequest, @Query('symbol') symbol?: string, @Query('since') since?: string) {
    return this.sentinel.timeline(req.user.sub, symbol ?? 'NIFTY', since);
  }

  /** Module 2 — the strategy handbook Sentinel is currently monitoring. */
  @Get('strategies')
  strategies() {
    return this.sentinel.strategies();
  }

  /** Module 11 — end-of-day review of the session Sentinel narrated. */
  @ApiBody({ type: MarketCloseReviewBody, required: false })
  @Post('market-close/review')
  marketCloseReview(@Req() req: AuthedRequest, @Body() body: { symbol?: string }) {
    return this.sentinel.marketCloseReview(req.user.sub, body?.symbol ?? 'NIFTY');
  }

  @Get('session-summary')
  sessionSummary(@Req() req: AuthedRequest) {
    return this.sentinel.sessionSummary(req.user.sub);
  }

  @Get('journal')
  journal(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.sentinel.listJournal(req.user.sub, limit ? Number(limit) : 50);
  }

  @ApiBody({ type: JournalEntryBody })
  @Post('journal')
  addJournal(@Req() req: AuthedRequest, @Body() body: { content: string; mood?: string; tags?: string[] }) {
    return this.sentinel.addJournal(req.user.sub, body);
  }
}
