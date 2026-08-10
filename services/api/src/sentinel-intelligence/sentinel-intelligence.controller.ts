import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiBody, ApiProperty, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { EXPENSIVE_LIMIT } from '../common/throttling';
import { AuthGuard } from '../auth/auth.guard';
import { CapabilityGuard, RequiresCapability } from '../entitlements/capability.guard';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { SECURITY } from '../swagger/swagger.setup';
import { SentinelIntelligenceApiService, type ReasonBody } from './sentinel-intelligence.service';

type AuthedRequest = { user: { sub: string } };

/**
 * DOCUMENTATION MODEL ONLY — the schema shape of `ReasonBody`, which is an
 * interface and so leaves no runtime type for the generator to read. Attached
 * with `@ApiBody({ type })`; the handler signatures are untouched. Keep in step
 * with `ReasonBody` in sentinel-intelligence.service.ts.
 */
class ReasonRequestBody {
  @ApiProperty({ required: false, description: 'The question to reason about.' })
  query?: string;

  @ApiProperty({ required: false, example: 'NIFTY' })
  symbol?: string;

  @ApiProperty({ required: false, description: 'Option strike, when reasoning about a contract.' })
  strike?: number;

  @ApiProperty({ required: false, enum: ['CE', 'PE'] })
  right?: 'CE' | 'PE';

  @ApiProperty({ required: false, description: 'Contract expiry.', example: '2026-08-27' })
  expiry?: string;

  @ApiProperty({ required: false, example: '15m' })
  timeframe?: string;

  @ApiProperty({ required: false, type: [String] })
  strategyIds?: string[];

  @ApiProperty({ required: false, type: [String], example: ['RSI', 'VWAP'] })
  indicators?: string[];

  @ApiProperty({ required: false, description: 'Trading style to reason in.' })
  style?: string;

  @ApiProperty({ required: false })
  riskProfile?: string;

  @ApiProperty({ required: false, description: 'Below this, the run stays silent.', example: 0.7 })
  confidenceThreshold?: number;

  @ApiProperty({ required: false, description: 'How many agents must agree before anything is surfaced.', example: 2 })
  requiredCorroboration?: number;
}

/**
 * Public SentinelIntelligence endpoints.
 *
 * Gated by the same `sentinel` entitlement as the orchestrator surface and
 * metered against the same quota — this is a second way into the same premium
 * capability, not a free side door around it. The decision stays with
 * `EntitlementsService`; there is no hardcoded plan check here.
 */
@ApiTags('Sentinel Intelligence')
@ApiBearerAuth(SECURITY.bearer)
@ApiResponse({
  status: 403,
  description: 'Missing the `sentinel` entitlement, or the plan’s quota is spent.',
})
// See SentinelController: an operational per-minute ceiling beside the
// commercial per-period quota. `reindex` in particular rebuilds the whole
// citation corpus, which is the single most expensive call in the API.
@Throttle(EXPENSIVE_LIMIT)
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
  @ApiBody({ type: ReasonRequestBody })
  @Post('reason')
  async reason(@Req() req: AuthedRequest, @Body() body: ReasonBody) {
    const result = await this.intelligence.reason(req.user.sub, body ?? {});
    await this.entitlements.recordUsage(req.user.sub, 'sentinel_requests');
    return result;
  }

  /** The three synchronized panels: chart, option context, AI visualization. */
  @ApiBody({ type: ReasonRequestBody })
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
  @ApiBody({
    description: 'A free-form strategy specification: rules, indicator logic and drawing specs. '
      + 'Passed through to the Sentinel service unmodified, so it has no fixed schema here.',
    schema: { type: 'object', additionalProperties: true },
  })
  @Post('rules')
  learnRule(@Body() body: unknown) {
    return this.intelligence.learnRule(body);
  }

  @Delete('rules/:id')
  retireRule(@Param('id') id: string) {
    return this.intelligence.retireRule(id);
  }

  /** Rebuild the learned corpus. Incremental unless `force=true`. */
  @ApiQuery({ name: 'force', required: false, type: Boolean, description: 'Rebuild from scratch rather than incrementally.' })
  @Post('reindex')
  reindex(@Query('force') force?: string) {
    return this.intelligence.reindex(force === 'true');
  }
}
