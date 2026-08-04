import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CapabilityGuard, RequiresCapability } from '../entitlements/capability.guard';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { SentinelIntelligenceApiService, type ReasonBody } from './sentinel-intelligence.service';

type AuthedRequest = { user: { sub: string } };

/**
 * Public SentinelIntelligence endpoints.
 *
 * Gated by the same `sentinel` entitlement as the orchestrator surface and
 * metered against the same quota — this is a second way into the same premium
 * capability, not a free side door around it. The decision stays with
 * `EntitlementsService`; there is no hardcoded plan check here.
 */
@UseGuards(AuthGuard, CapabilityGuard)
@RequiresCapability('sentinel')
@Controller('sentinel-intelligence')
export class SentinelIntelligenceController {
  constructor(
    private readonly intelligence: SentinelIntelligenceApiService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * One reasoning pass.
   *
   * Returns the full run even when nothing is surfaced —
   * `synthesis.surfaced === false` with a `silenceReason` is the designed
   * outcome below the gates, and the client renders no observation for it.
   */
  @Post('reason')
  async reason(@Req() req: AuthedRequest, @Body() body: ReasonBody) {
    const result = await this.intelligence.reason(req.user.sub, body ?? {});
    await this.entitlements.recordUsage(req.user.sub, 'sentinel_requests');
    return result;
  }

  /** The three synchronized panels: chart, option context, AI visualization. */
  @Post('workspace')
  async workspace(@Req() req: AuthedRequest, @Body() body: ReasonBody) {
    const result = await this.intelligence.workspace(req.user.sub, body ?? {});
    await this.entitlements.recordUsage(req.user.sub, 'sentinel_requests');
    return result;
  }

  /** Corpus, graph, agent roster and active gates. */
  @Get('status')
  status() {
    return this.intelligence.status();
  }

  @Get('rules')
  listRules() {
    return this.intelligence.listRules();
  }

  /**
   * Teach a TradingView strategy: rules, indicator logic, drawing specs.
   *
   * Not metered — authoring knowledge is not a premium AI request, and
   * charging a quota unit for saving a rule would discourage exactly the
   * behaviour that makes the engine better.
   */
  @Post('rules')
  learnRule(@Body() body: unknown) {
    return this.intelligence.learnRule(body);
  }

  @Delete('rules/:id')
  retireRule(@Param('id') id: string) {
    return this.intelligence.retireRule(id);
  }

  /** Rebuild the learned corpus. Incremental unless `force=true`. */
  @Post('reindex')
  reindex(@Query('force') force?: string) {
    return this.intelligence.reindex(force === 'true');
  }
}
