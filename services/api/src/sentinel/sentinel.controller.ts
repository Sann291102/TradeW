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

  @Get('observations')
  observations(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.sentinel.observations(req.user.sub, limit ? Number(limit) : 50);
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
