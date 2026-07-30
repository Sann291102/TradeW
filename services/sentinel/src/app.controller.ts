import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Post,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { MarketDataUnavailableError } from './market-data/candle-market-data.provider';
import { KnowledgeCenterService } from './brain/knowledge-center.service';
import { StrategyIntelligenceService } from './brain/strategy-intelligence.service';
import { ComplianceService } from './compliance/compliance.service';
import { ObserveRequest, TradeSummary } from './domain';
import { ExplainService } from './explain/explain.service';
import { ContinuousImprovementService } from './improvement/continuous-improvement.service';
import { StrategyEngineService } from './intelligence/strategy-engine.service';
import { MarketCloseAnalysisService } from './market-close/market-close-analysis.service';
import { SentinelOrchestratorService } from './orchestrator/sentinel-orchestrator.service';
import { MarketStateMachineService } from './state-machine/state-machine.service';
import { MarketTimelineEngine } from './timeline/timeline.engine';

/**
 * Internal-only ingress: every request must carry the shared service token.
 * Only services/api holds it — apps never call Sentinel directly
 * (ARCHITECTURE.md §1 single-public-ingress rule).
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.SERVICE_TOKEN;
    if (!expected) throw new UnauthorizedException('SERVICE_TOKEN not configured');
    const req = context.switchToHttp().getRequest();
    if (req.headers['x-service-token'] !== expected) throw new UnauthorizedException('Invalid service token');
    return true;
  }
}

@Controller()
export class AppController {
  constructor(
    private readonly orchestrator: SentinelOrchestratorService,
    private readonly compliance: ComplianceService,
    private readonly explainSvc: ExplainService,
    private readonly knowledgeCenter: KnowledgeCenterService,
    private readonly strategyIntelligence: StrategyIntelligenceService,
    private readonly strategyEngine: StrategyEngineService,
    private readonly timeline: MarketTimelineEngine,
    private readonly marketClose: MarketCloseAnalysisService,
    private readonly improvement: ContinuousImprovementService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'sentinel' };
  }

  /** The single observation entrypoint. Sentinel comments in parallel with the order flow — it is never a gate in it. */
  @UseGuards(ServiceTokenGuard)
  @Post('observe')
  async observe(@Body() body: ObserveRequest) {
    try {
      return await this.orchestrator.observe(body);
    } catch (err) {
      // No real market data. 503 (not 500) so the caller can tell "Sentinel is
      // disconnected from its data source" from "Sentinel crashed", and the
      // message reaches the workspace verbatim instead of a generic error.
      if (err instanceof MarketDataUnavailableError) {
        throw new ServiceUnavailableException(err.message);
      }
      throw err;
    }
  }

  /** Compliance-audit trail backing the Observation Feed / Agent Activity Timeline. */
  @UseGuards(ServiceTokenGuard)
  @Get('observations')
  observations(@Query('userId') userId: string, @Query('limit') limit?: string) {
    return this.compliance.feed(userId, limit ? Number(limit) : 50);
  }

  /** Real Neural Brain explanation for a module/observation — never buy/sell language. */
  @UseGuards(ServiceTokenGuard)
  @Post('explain')
  explain(@Body() body: { question: string; context?: string }) {
    return this.explainSvc.explain(body.question, body?.context);
  }

  /** Knowledge Center — query surface over everything the Brain has learned. */
  @UseGuards(ServiceTokenGuard)
  @Post('brain/search')
  brainSearch(@Body() body: { query: string; userId?: string | null; namespace?: string; limit?: number }) {
    return this.knowledgeCenter.search(body.query, { userId: body.userId, namespace: body.namespace, limit: body.limit });
  }

  @UseGuards(ServiceTokenGuard)
  @Get('brain/stats')
  brainStats() {
    return this.knowledgeCenter.stats();
  }

  /** Strategy Intelligence Framework — cross-symbol historical base rate for a pattern, sample-size gated. */
  @UseGuards(ServiceTokenGuard)
  @Get('brain/strategy')
  async brainStrategy(@Query('pattern') pattern: string) {
    const result = await this.strategyIntelligence.baseRateFor(pattern);
    return { ...result, description: this.strategyIntelligence.describe(result) };
  }

  // ------------------------------------------------- Master Plan modules

  /** Module 2 — the trader's strategy handbook, built-ins plus their own YAML. */
  @UseGuards(ServiceTokenGuard)
  @Get('strategies')
  strategies() {
    return this.strategyEngine.getStrategies();
  }

  /** Module 2 — enable/disable one strategy for detection. */
  @UseGuards(ServiceTokenGuard)
  @Post('strategies/toggle')
  toggleStrategy(@Body() body: { id: string; enabled: boolean }) {
    const ok = this.strategyEngine.setStrategyEnabled(body.id, body.enabled);
    return { id: body.id, enabled: body.enabled, applied: ok };
  }

  /**
   * Module 8 — the running session narrative. `since` returns only entries
   * after that ISO timestamp, so a polling client appends rather than
   * re-rendering the whole day.
   */
  @UseGuards(ServiceTokenGuard)
  @Get('timeline')
  timelineFor(
    @Query('userId') userId: string,
    @Query('symbol') symbol: string,
    @Query('since') since?: string,
  ) {
    const key = MarketTimelineEngine.sessionKey(userId, symbol ?? 'NIFTY');
    return { entries: since ? this.timeline.since(key, since) : this.timeline.entries(key) };
  }

  /** Module 11 — end-of-day review of the session Sentinel just narrated. */
  @UseGuards(ServiceTokenGuard)
  @Post('market-close/review')
  async marketCloseReview(@Body() body: { userId: string; symbol?: string; recentTrades?: TradeSummary[] }) {
    const review = await this.marketClose.review({
      userId: body.userId,
      symbol: body.symbol ?? 'NIFTY',
      trades: body.recentTrades,
    });
    return { ...review, formatted: this.marketClose.format(review) };
  }

  /**
   * Module 12 — replay every configured strategy over recent history, measure
   * it, and recalibrate the confidence weights. Pass `apply=false` to measure
   * without changing anything.
   */
  @UseGuards(ServiceTokenGuard)
  @Post('improvement/run')
  runImprovement(@Body() body: { symbol?: string; days?: number; apply?: boolean }) {
    return this.improvement.run({
      symbol: body?.symbol,
      days: body?.days,
      applyRecalibration: body?.apply !== false,
    });
  }
}
