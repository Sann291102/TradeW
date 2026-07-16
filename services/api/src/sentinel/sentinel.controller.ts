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
  async observe(@Req() req: AuthedRequest, @Body() body: { symbol?: string; context?: string }) {
    const result = await this.sentinel.observe(req.user.sub, body?.symbol, body?.context);
    await this.entitlements.recordUsage(req.user.sub, 'sentinel_requests');
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
