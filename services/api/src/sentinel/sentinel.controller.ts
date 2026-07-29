import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CapabilityGuard, RequiresCapability } from '../entitlements/capability.guard';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { SentinelApiService } from './sentinel.service';

type AuthedRequest = { user: { sub: string } };

/**
 * Public Sentinel endpoints. Every route requires the 'sentinel' entitlement,
 * decided by the centralized EntitlementsService (never a hardcoded check),
 * and premium AI requests are metered against the plan's quota.
 */
@UseGuards(AuthGuard, CapabilityGuard)
@RequiresCapability('sentinel')
@Controller('sentinel')
export class SentinelController {
  constructor(
    private readonly sentinel: SentinelApiService,
    private readonly entitlements: EntitlementsService,
  ) {}

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
    },
  ) {
    const result = await this.sentinel.observe(req.user.sub, body?.symbol, body?.context, {
      clientTrades: body?.clientTrades,
      clientPositions: body?.clientPositions,
    });
    await this.entitlements.recordUsage(req.user.sub, 'sentinel_requests');
    return result;
  }

  @Post('explain')
  async explain(@Req() req: AuthedRequest, @Body() body: { question: string; context?: string }) {
    const result = await this.sentinel.explain(req.user.sub, body.question, body?.context);
    await this.entitlements.recordUsage(req.user.sub, 'ai_requests');
    return result;
  }

  /** Knowledge Center — query surface over the Brain's accumulated memory. */
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

  @Post('journal')
  addJournal(@Req() req: AuthedRequest, @Body() body: { content: string; mood?: string; tags?: string[] }) {
    return this.sentinel.addJournal(req.user.sub, body);
  }
}
