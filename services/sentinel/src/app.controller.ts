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
import { timingSafeEqual } from 'node:crypto';
import { MarketDataUnavailableError } from './market-data/candle-market-data.provider';
import { KnowledgeCenterService } from './brain/knowledge-center.service';
import { StrategyIntelligenceService } from './brain/strategy-intelligence.service';
import { ComplianceService } from './compliance/compliance.service';
import { ObserveRequest, TradeSummary } from './domain';
import { ExecutionEvaluationService } from './execution/execution-evaluation.service';
import { BacktestScanService } from './backtest/backtest-scan.service';
import type { BacktestScanRequest } from './backtest/replay-contract';
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
/** Placeholder values that must never authenticate the internal channel — the
 *  committed dev default was `dev-sentinel-token` (2026-08-10 finding). */
const WEAK_SERVICE_TOKENS = new Set(['', 'dev-sentinel-token', 'dev-sentinel-service-token', 'changeme', 'secret']);

@Injectable()
export class ServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.SERVICE_TOKEN ?? '';
    // Fail closed on an unset OR placeholder/too-short token. A weak shared
    // secret on the api→sentinel hop is not a boundary; treat it as unconfigured
    // so the surface is disabled until a real value is set, rather than guarded
    // by a value that is public in the repo history.
    if (!expected || expected.length < 24 || WEAK_SERVICE_TOKENS.has(expected.toLowerCase())) {
      throw new UnauthorizedException('SERVICE_TOKEN not configured');
    }
    const req = context.switchToHttp().getRequest();
    const presented = req.headers['x-service-token'];
    // Constant-time compare: the token never rotates per request, so a
    // short-circuiting `!==` would let a network-adjacent caller search it
    // byte-by-byte across many requests.
    if (typeof presented !== 'string' || !constantTimeEquals(presented, expected)) {
      throw new UnauthorizedException('Invalid service token');
    }
    return true;
  }
}

/** timingSafeEqual throws on length mismatch, so length is checked first. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

@Controller()
export class AppController {
  constructor(
    private readonly orchestrator: SentinelOrchestratorService,
    private readonly executionEvaluation: ExecutionEvaluationService,
    private readonly backtestScan: BacktestScanService,
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

  /**
   * The execution-facing read of one observation: everything `/observe`
   * produces, plus the three-strike evaluation.
   *
   * SEPARATE FROM `/observe` ON PURPOSE. `/observe`'s response is proxied
   * verbatim to `apps/web`, and a selected strike shown to a trader is a
   * directive (CLAUDE.md Rule 2). This route selects one contract out of three,
   * so it is reachable only by `services/api`'s paper-execution loop holding
   * the service token, and its output is rendered only in the admin console.
   *
   * It is a READ. Sentinel still cannot place an order — this service has no
   * binding to Order/Trade/Position and no client to the OMS. The caller
   * decides what, if anything, to do with the evaluation.
   */
  @UseGuards(ServiceTokenGuard)
  @Post('execution/evaluate')
  async evaluateForExecution(
    @Body() body: { symbol: string; userId: string; strategyId?: string | null; minConfidence?: number },
  ) {
    try {
      return await this.executionEvaluation.evaluate({
        symbol: body.symbol,
        userId: body.userId,
        strategyId: body.strategyId ?? null,
        minConfidence: body.minConfidence,
      });
    } catch (err) {
      // Same 503-not-500 distinction `/observe` makes: "Sentinel is
      // disconnected from its data source" is a different operational fact from
      // "Sentinel crashed", and the execution loop must treat only the second
      // as a fault worth alerting on.
      if (err instanceof MarketDataUnavailableError) {
        throw new ServiceUnavailableException(err.message);
      }
      throw err;
    }
  }

  /**
   * Replay a strategy over stored historical bars and report where it fired.
   *
   * SERVICE-TOKEN ONLY, like `/execution/evaluate`, and for a related reason:
   * the response names bar indices and biases across a whole window, which is
   * an analysis surface for the backtest engine rather than anything a trader
   * should be handed directly. `services/api` turns it into a portfolio
   * simulation, applies ownership, and persists the result.
   *
   * It is a READ over the `Candle` table. Sentinel places nothing, writes
   * nothing here, and this route cannot reach the OMS — there is no client to
   * it in this service.
   */
  @UseGuards(ServiceTokenGuard)
  @Post('backtest/scan')
  async backtestScanRoute(@Body() body: BacktestScanRequest) {
    return this.backtestScan.scan(body);
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
