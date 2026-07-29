import { Injectable, Logger } from '@nestjs/common';
import {
  CORE_GUARDRAILS,
  ProviderManager,
  ProviderNotAvailableError,
  createProviderManager,
  loadProvidersConfigFromEnv,
} from '@tradew/ai-core';
import { HistoricalSimilarityResult, HistoricalSimilarityService } from '../brain/historical-similarity.service';
import { MarketContextService } from '../brain/market-context.service';
import { OutcomeLearningService } from '../brain/outcome-learning.service';
import { PatternRecognitionService } from '../brain/pattern-recognition.service';
import { ResearchTriggerService } from '../brain/research-trigger.service';
import { ComplianceService } from '../compliance/compliance.service';
import { ConfidenceEngine } from '../confidence/confidence.engine';
import {
  ConfidenceBreakdown,
  ObserveRequest,
  ObserveResponse,
  SENTINEL_DISCLAIMER,
  SentinelObservationOut,
  Signal,
  StrategyMatch,
} from '../domain';
import { ExplainService } from '../explain/explain.service';
import { EmotionIntelligenceService } from '../intelligence/emotion-intelligence.service';
import { MarketIntelligenceService, MarketSnapshot } from '../intelligence/market-intelligence.service';
import { NewsIntelligenceService } from '../intelligence/news-intelligence.service';
import { RiskIntelligenceService } from '../intelligence/risk-intelligence.service';
import { StrategyDetection, StrategyEngineService } from '../intelligence/strategy-engine.service';
import { TrapIntelligenceService } from '../intelligence/trap-intelligence.service';
import { MarketStateMachineService, StateEvaluation } from '../state-machine/state-machine.service';
import { MarketTimelineEngine, RecordInput } from '../timeline/timeline.engine';
import { enforceVocabulary, statusHeadline } from '../vocabulary/vocabulary';

/**
 * Sentinel Orchestrator — the only component that produces user-facing copy.
 *
 * It runs the Master Plan's end-to-end workflow (§3) for one observation:
 * classify the regime (Module 1) → scan the strategy handbook (Module 2) →
 * compare against history (Module 3) → score eight risk factors (Module 6) →
 * compute one transparent confidence figure (Module 7) → advance the state
 * machine (Module 9) → append to the session narrative (Module 8) → and only
 * then decide whether anything is worth saying at all.
 *
 * Two independent gates can produce a surfaced message, and both must be
 * cleared on their own terms:
 *
 *  - **Confidence gate** (Master Plan principle 3): market guidance is
 *    surfaced only when the aggregate confidence clears the trader's
 *    threshold. Below it Sentinel stays in Wait and Watch. Silence is a
 *    feature, not a gap.
 *  - **Composite risk gate** (SENTINEL.md §2-3, retained): a behavioural or
 *    trap warning is surfaced when several independent signals corroborate.
 *    This is a different product surface from market guidance and predates
 *    the confidence engine — a revenge-trading warning must not be gated on
 *    a technical setup existing.
 *
 * LLM polish is optional throughout: with no provider configured a
 * deterministic template composes the same structure, so the service is fully
 * functional in dev without keys and can never be blocked by a provider
 * outage. Every generated string passes through the Module 10 vocabulary
 * enforcer before it reaches a trader.
 */
@Injectable()
export class SentinelOrchestratorService {
  private readonly logger = new Logger(SentinelOrchestratorService.name);
  /** Composite corroboration needed before a *risk* warning is surfaced. */
  private static readonly SURFACE_THRESHOLD = 0.7;
  private providers: ProviderManager;

  /**
   * Polished-prose cache — the single biggest LLM-token saver here.
   *
   * `polish()` rewrites a DETERMINISTIC draft (`fallback`): identical market
   * evidence produces a byte-identical draft, so re-polishing it returns the
   * same prose while spending tokens again. That happens constantly — a user
   * flipping between two symbols, several viewers observing the same index,
   * an unchanged market between two observes. Keying the cache on the draft
   * text (plus the system prompt, so guidance vs risk-warning never collide)
   * turns every repeat into a free hit with zero behaviour change.
   *
   * Bounded by a short TTL so genuinely new evidence is always re-polished,
   * and by a hard entry cap so the map cannot grow without limit.
   */
  private readonly polishCache = new Map<string, { text: string; at: number }>();
  private static readonly POLISH_TTL_MS = 5 * 60 * 1000;
  private static readonly POLISH_CACHE_MAX = 500;

  constructor(
    private readonly market: MarketIntelligenceService,
    private readonly emotion: EmotionIntelligenceService,
    private readonly traps: TrapIntelligenceService,
    private readonly news: NewsIntelligenceService,
    private readonly strategies: StrategyEngineService,
    private readonly risk: RiskIntelligenceService,
    private readonly confidence: ConfidenceEngine,
    private readonly stateMachine: MarketStateMachineService,
    private readonly timeline: MarketTimelineEngine,
    private readonly compliance: ComplianceService,
    private readonly explain: ExplainService,
    private readonly patternRecognition: PatternRecognitionService,
    private readonly historicalSimilarity: HistoricalSimilarityService,
    private readonly marketContext: MarketContextService,
    private readonly researchTrigger: ResearchTriggerService,
    private readonly outcomeLearning: OutcomeLearningService,
  ) {
    this.providers = createProviderManager(loadProvidersConfigFromEnv());
  }

  async observe(request: ObserveRequest): Promise<ObserveResponse> {
    const at = new Date();
    const symbol = request.symbol ?? 'NIFTY';
    const trades = request.recentTrades ?? [];
    const sessionKey = MarketStateMachineService.sessionKey(request.userId, symbol, at);

    // Continuous Research Engine: event-driven, fire-and-forget so it never
    // adds latency to this response — enriches the Brain for next time.
    void this.researchTrigger.researchIfUnfamiliar(symbol).catch(() => undefined);
    // Continuous Learning from Outcomes: piggybacks on this same continuous
    // cadence rather than a new scheduler — a small batch per call.
    void this.outcomeLearning.evaluatePending(5).catch(() => undefined);

    // ---- Modules 1, 2, 4 and the behavioural agents ---------------------
    const snapshot = await this.market.snapshot(symbol);
    const signals: Signal[] = [
      ...this.market.signals(snapshot),
      ...this.emotion.signals(trades),
      ...this.traps.signals(snapshot, trades),
      ...(await this.news.signals(symbol)),
    ];
    const detections = this.strategies.scan(snapshot, at);
    signals.push(...strategySignals(detections));

    // ---- Module 6, then Module 7 ---------------------------------------
    const riskAssessment = this.risk.assess(snapshot, signals, request.account, at);
    signals.push(...this.risk.signals(riskAssessment));

    const leadingPattern = detections[0]?.strategyId ?? dominantSignal(signals)?.name ?? null;
    const historical = leadingPattern
      ? await this.historicalSimilarity.similarPast(symbol, leadingPattern).catch((err) => {
          this.logger.warn(`historical similarity lookup failed (non-fatal): ${err}`);
          return null;
        })
      : null;

    const confidence = this.confidence.compute({
      snapshot,
      detections,
      risk: riskAssessment,
      signals,
      historical,
      threshold: request.confidenceThreshold,
      at,
    });

    // ---- Module 9, then Module 8 ---------------------------------------
    const stateEval = this.stateMachine.advance(sessionKey, { snapshot, detections, confidence, at });
    const bias = detections[0]?.bias ?? snapshot.trendAnalysis?.direction ?? 'neutral';
    const status = statusHeadline(stateEval.snapshot.current, bias);

    this.timeline.recordAll(
      sessionKey,
      this.narrate(symbol, snapshot, detections, confidence, stateEval, at),
    );

    // ---- observation feed ----------------------------------------------
    const triggered = signals.filter((s) => s.triggered);
    const observations: SentinelObservationOut[] = triggered.map((s) => ({
      agent: s.agent,
      category: this.compliance.categoryFor(s),
      pattern: s.name,
      symbol,
      content: s.evidence.join('; '),
      evidence: s.evidence,
      confidence: Math.min(1, 0.4 + s.weight),
    }));

    // Pattern Recognition Engine: every triggered signal becomes durable,
    // queryable knowledge — wrapped so a Brain hiccup never breaks /observe.
    try {
      await Promise.all(triggered.map((s) => this.patternRecognition.recordOccurrence(symbol, s, snapshot.lastPrice)));
    } catch (err) {
      this.logger.warn(`pattern recognition persistence failed (non-fatal): ${err}`);
    }

    // ---- what, if anything, is worth saying -----------------------------
    const synthesis = await this.decide({
      symbol,
      status,
      snapshot,
      signals,
      triggered,
      detections,
      confidence,
      stateEval,
      historical,
      sessionKey,
      at,
    });

    if (synthesis) {
      observations.push({
        agent: 'orchestrator',
        category: confidence.meetsThreshold ? 'synthesized_market_guidance' : 'synthesized_risk_awareness',
        pattern: synthesis.pattern,
        symbol,
        content: synthesis.content,
        evidence: triggered.flatMap((s) => s.evidence),
        confidence: synthesis.confidence,
      });
    }

    await this.compliance.record(request.userId, observations, synthesis?.content ?? null);

    // Market Context Engine: additive narrative, never blocks the response.
    const marketContext = await this.marketContext.contextFor(symbol, snapshot).catch(() => undefined);

    const explanation = await this.explain.buildWhy({
      status,
      snapshot,
      confidence,
      detections,
      risk: riskAssessment,
      signals,
      historical,
      at,
    });

    return {
      synthesis,
      observations,
      signals,
      marketContext,
      marketProfile: snapshot.marketProfile,
      strategyMatches: detections.map(toStrategyMatch),
      risk: riskAssessment,
      confidence,
      marketState: stateEval.snapshot,
      timeline: this.timeline.entries(sessionKey),
      explanation,
    };
  }

  /**
   * The gate. Market guidance requires the confidence threshold; a risk
   * warning requires composite corroboration. Neither substitutes for the
   * other, and when neither is cleared the correct output is nothing.
   */
  private async decide(ctx: {
    symbol: string;
    status: string;
    snapshot: MarketSnapshot;
    signals: Signal[];
    triggered: Signal[];
    detections: StrategyDetection[];
    confidence: ConfidenceBreakdown;
    stateEval: StateEvaluation;
    historical: HistoricalSimilarityResult | null;
    sessionKey: string;
    at: Date;
  }): Promise<ObserveResponse['synthesis']> {
    const state = ctx.stateEval.snapshot.current;
    const guidanceStates = ['SIDE_IN_FOCUS', 'OPPORTUNITY_ACTIVE', 'MOVE_DEVELOPING', 'MOMENTUM_WEAKENING', 'MOVE_COMPLETE'];

    // --- confidence-gated market guidance (Master Plan principle 3) ------
    if (ctx.confidence.meetsThreshold && guidanceStates.includes(state)) {
      const leading = ctx.detections[0];
      const content = await this.composeGuidance(ctx.symbol, ctx.status, ctx.confidence, leading, ctx.historical);
      this.timeline.record(ctx.sessionKey, {
        event: `${ctx.status} — ${ctx.confidence.score}% confidence across ${ctx.confidence.factors.length} factors`,
        level: 'guidance',
        confidence: ctx.confidence.score,
        state,
        at: ctx.at,
        dedupeKey: `guidance:${state}:${ctx.status}`,
      });
      return {
        content,
        pattern: leading?.strategyId ?? state.toLowerCase(),
        confidence: ctx.confidence.score / 100,
        disclaimer: SENTINEL_DISCLAIMER,
        status: ctx.status,
        state,
      };
    }

    // --- composite risk warning (SENTINEL.md §2-3, retained) -------------
    // Behavioural and trap warnings are independent of any technical setup:
    // a revenge-trading pattern matters whether or not a strategy confirmed.
    const riskySignals = ctx.triggered.filter((s) => s.agent === 'emotion' || s.agent === 'trap-safety' || s.agent === 'risk');
    const compositeWeight = riskySignals.reduce((sum, s) => sum + s.weight, 0);
    if (compositeWeight >= SentinelOrchestratorService.SURFACE_THRESHOLD && riskySignals.length >= 2) {
      const dominant = [...riskySignals].sort((a, b) => b.weight - a.weight)[0];
      let content = await this.composeRiskWarning(ctx.symbol, riskySignals, dominant);
      if (ctx.historical && ctx.historical.occurrences > 0) {
        content += ' ' + this.historicalSimilarity.describe(ctx.historical);
      }
      this.timeline.record(ctx.sessionKey, {
        event: `Risk awareness: ${dominant.name.replace(/_/g, ' ')} corroborated by ${riskySignals.length} signals`,
        level: 'guidance',
        state,
        at: ctx.at,
        dedupeKey: `risk:${dominant.name}`,
      });
      return {
        content,
        pattern: dominant.name,
        confidence: Math.min(0.95, compositeWeight / 2 + 0.3),
        disclaimer: SENTINEL_DISCLAIMER,
        status: ctx.status,
        state,
      };
    }

    return null;
  }

  /** Module 8 — the session narrative entries this observation produced. */
  private narrate(
    symbol: string,
    snapshot: MarketSnapshot,
    detections: StrategyDetection[],
    confidence: ConfidenceBreakdown,
    stateEval: StateEvaluation,
    at: Date,
  ): RecordInput[] {
    const out: RecordInput[] = [];

    if (snapshot.sessionCandles.length > 0) {
      const open = snapshot.sessionCandles[0];
      const gap = snapshot.priorDay ? open.open - snapshot.priorDay.close : null;
      out.push({
        event:
          `Market open: ${symbol} opened at ${open.open.toFixed(1)}` +
          (gap !== null ? ` (${gap >= 0 ? '+' : ''}${gap.toFixed(1)} from the prior close)` : '') +
          (snapshot.vix !== null ? `. India VIX ${snapshot.vix.toFixed(1)}.` : '.'),
        level: 'info',
        at,
        dedupeKey: 'session:open',
      });
    }

    if (snapshot.openingRange) {
      out.push({
        event: `Opening range established: ${snapshot.openingRange.low.toFixed(1)} – ${snapshot.openingRange.high.toFixed(1)}.`,
        level: 'observation',
        at,
        dedupeKey: 'session:orb',
      });
    }

    if (snapshot.marketProfile) {
      out.push({
        event: `Session classified as ${snapshot.marketProfile.type} — ${snapshot.marketProfile.description}.`,
        level: 'observation',
        at,
        dedupeKey: `profile:${snapshot.marketProfile.type}`,
      });
    }

    for (const d of detections) {
      out.push({
        event: d.validated
          ? `${d.strategyName} confirmed — all ${d.rulesMatched.length} rules met. ${d.rulesMatched.join('; ')}.`
          : `${d.strategyName} forming — ${d.rulesMatched.length} of ${d.rulesMatched.length + d.rulesUnmet.length} rules confirmed.`,
        level: 'setup',
        confidence: d.confidence,
        at,
        dedupeKey: `detect:${d.strategyId}:${d.validated ? 'confirmed' : d.rulesMatched.length}`,
      });
      if (d.invalidationsTriggered.length > 0) {
        out.push({
          event: `${d.strategyName} invalidated — ${d.invalidationsTriggered.join('; ')}.`,
          level: 'setup',
          at,
          dedupeKey: `invalid:${d.strategyId}`,
        });
      }
    }

    if (stateEval.transition) {
      out.push({
        event: `${stateEval.transition.to.replace(/_/g, ' ').toLowerCase()} — ${stateEval.transition.trigger}.`,
        level: 'transition',
        state: stateEval.transition.to,
        confidence: confidence.score,
        at,
      });
    }

    return out;
  }

  /**
   * Market guidance copy: status → the evidence behind it → the fact that it
   * is an observation. Never a directive, in either the generated or the
   * deterministic path.
   */
  private async composeGuidance(
    symbol: string,
    status: string,
    confidence: ConfidenceBreakdown,
    leading: StrategyDetection | undefined,
    historical: HistoricalSimilarityResult | null,
  ): Promise<string> {
    const topFactors = [...confidence.factors]
      .sort((a, b) => b.score * b.weight - a.score * a.weight)
      .slice(0, 3)
      .map((f) => `${f.label} ${f.score}/100`);
    const evidence = [
      ...(leading ? [`${leading.strategyName}: ${leading.rulesMatched.join('; ')}`] : []),
      ...topFactors,
      ...(historical && historical.occurrences > 0 && !historical.sampleTooSmall
        ? [this.historicalSimilarity.describe(historical)]
        : []),
    ];
    const deductions = confidence.deductions.map((d) => `${d.reason} (−${d.points.toFixed(1)}%)`);

    const fallback =
      `${status} on ${symbol} at ${confidence.score}% confidence, against a ${confidence.threshold}% threshold. ` +
      `${evidence.join('. ')}.` +
      (deductions.length ? ` Confidence was reduced by: ${deductions.join('; ')}.` : '') +
      ' This is an observation of current market state, not advice.';

    return this.polish(
      fallback,
      `You are the Sentinel Orchestrator, an observation-only market intelligence desk. Rewrite the supplied evidence into one short, calm paragraph following exactly: status -> the evidence that produced it -> a reminder that it is an observation. Keep every number. Educational tone.\n\nNon-negotiable rules:\n` +
        CORE_GUARDRAILS.map((g) => `- ${g}`).join('\n'),
      `Symbol: ${symbol}\nStatus: ${status}\nConfidence: ${confidence.score}% (threshold ${confidence.threshold}%)\nEvidence:\n${evidence.map((e) => `- ${e}`).join('\n')}` +
        (deductions.length ? `\nDeductions:\n${deductions.map((d) => `- ${d}`).join('\n')}` : ''),
    );
  }

  /** evidence → pattern name → soft suggestion; never a directive. */
  private async composeRiskWarning(symbol: string, triggered: Signal[], dominant: Signal): Promise<string> {
    const patternName = dominant.name.replace(/_/g, ' ');
    const evidence = triggered.flatMap((s) => s.evidence).slice(0, 6);
    const fallback = `${evidence.join('. ')}. Together these resemble a ${patternName} pattern on ${symbol}. This is an observation, not advice — consider waiting for confirmation before acting.`;

    return this.polish(
      fallback,
      `You are the Sentinel Orchestrator, an observation-only trading intelligence desk. Rewrite the evidence into one short, calm paragraph following exactly: evidence -> pattern name -> soft suggestion (e.g. "Consider waiting for confirmation."). Educational tone.\n\nNon-negotiable rules:\n` +
        CORE_GUARDRAILS.map((g) => `- ${g}`).join('\n'),
      `Symbol: ${symbol}\nPattern: ${patternName}\nEvidence:\n${evidence.map((e) => `- ${e}`).join('\n')}`,
    );
  }

  /**
   * Optional LLM polish over a deterministic draft. The draft is always a
   * complete, compliant message on its own, so a missing provider, a provider
   * outage or a model that produces directive language all resolve to the
   * same safe outcome.
   */
  private async polish(fallback: string, system: string, user: string): Promise<string> {
    // Draft + system prompt identify the output uniquely. The user message is
    // derived from the same evidence as the draft, so it adds nothing to the
    // key — but the system prompt distinguishes guidance from risk-warning.
    const cacheKey = `${system.length}:${fallback}`;
    const hit = this.polishCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SentinelOrchestratorService.POLISH_TTL_MS) {
      return hit.text;
    }

    try {
      const llm = this.providers.getLlm();
      const response = await llm.complete({
        tier: 'fast',
        maxTokens: 260,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const text = response.text.trim();
      if (!text) return fallback;
      const { clean, violations } = enforceVocabulary(text);
      if (violations.length > 0) {
        this.logger.warn(
          `orchestrator: model produced ${violations.length} directive phrase(s) (${violations.join(', ')}) — rewritten by the vocabulary enforcer`,
        );
      }
      // Cache only a successful, compliance-cleaned result. Evict oldest first
      // once the cap is hit (insertion order — Map preserves it).
      if (this.polishCache.size >= SentinelOrchestratorService.POLISH_CACHE_MAX) {
        const oldest = this.polishCache.keys().next().value;
        if (oldest !== undefined) this.polishCache.delete(oldest);
      }
      this.polishCache.set(cacheKey, { text: clean, at: Date.now() });
      return clean;
    } catch (err) {
      if (!(err instanceof ProviderNotAvailableError)) {
        this.logger.warn(`LLM synthesis failed, using deterministic composition: ${err}`);
      }
      return fallback;
    }
  }
}

/** Strategy detections as signals, so they appear in the Agent Activity Timeline. */
function strategySignals(detections: StrategyDetection[]): Signal[] {
  return detections.map((d) => ({
    name: d.strategyId.replace(/-/g, '_'),
    agent: 'strategy' as const,
    triggered: d.validated,
    // Scale the strategy's own confidence into the 0..1 signal weight space
    // the composite gate uses, so one number governs both representations.
    weight: Math.min(0.5, d.confidence / 200),
    evidence: [
      `${d.strategyName} (${d.bias} side): ${d.rulesMatched.length}/${d.rulesMatched.length + d.rulesUnmet.length} rules confirmed`,
      ...d.rulesMatched,
      ...d.invalidationsTriggered.map((i) => `Invalidation — ${i}`),
    ],
    data: { strategyId: d.strategyId, bias: d.bias, validated: d.validated, source: d.source },
  }));
}

function toStrategyMatch(d: StrategyDetection): StrategyMatch {
  return {
    strategyId: d.strategyId,
    strategyName: d.strategyName,
    confidence: d.confidence,
    bias: d.bias,
    rulesMatched: d.rulesMatched,
    rulesUnmet: d.rulesUnmet,
    invalidationsTriggered: d.invalidationsTriggered,
    detectedAt: d.detectedAt,
  };
}

function dominantSignal(signals: Signal[]): Signal | null {
  const triggered = signals.filter((s) => s.triggered);
  if (triggered.length === 0) return null;
  return [...triggered].sort((a, b) => b.weight - a.weight)[0];
}
