import { Injectable, Logger } from '@nestjs/common';
import {
  CORE_GUARDRAILS,
  ProviderManager,
  ProviderNotAvailableError,
  createProviderManager,
  emitAgentActivity,
  loadProvidersConfigFromEnv,
  runAgentRun,
  trackAgent,
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
  CrossValidationConcept,
  KnowledgeCitation,
  ObserveRequest,
  ObserveResponse,
  SENTINEL_DISCLAIMER,
  SentinelObservationOut,
  Signal,
  StrategyAdvice,
  StrategyMatch,
} from '../domain';
import { deriveSentinelEvents } from '../events/sentinel-event';
import { ExplainService } from '../explain/explain.service';
import { EmotionIntelligenceService } from '../intelligence/emotion-intelligence.service';
import { MarketBehaviourService, type MarketBehaviourRead } from '../intelligence/market-behaviour.service';
import { MarketIntelligenceService, MarketSnapshot, liveCandles } from '../intelligence/market-intelligence.service';
import { NewsIntelligenceService } from '../intelligence/news-intelligence.service';
import { RiskIntelligenceService } from '../intelligence/risk-intelligence.service';
import { StrategyDetection, StrategyEngineService } from '../intelligence/strategy-engine.service';
import { TrapIntelligenceService } from '../intelligence/trap-intelligence.service';
import {
  GUIDANCE_STATES,
  PublicationDecision,
  evaluatePublication,
} from './publication-gate';
import { buildInstitutionalCrossValidation } from './institutional-cross-validation';
import { buildReasoningAnnotations } from '../sentinel-intelligence/visual/reasoning-annotations';
import { AdaptiveCalibrationService } from '../improvement/adaptive-calibration.service';
import { buildOptionContext } from '../strategy/option-context';
import { StrategyLifecycleService } from '../strategy/strategy-lifecycle.service';
import { MarketStateMachineService, StateEvaluation } from '../state-machine/state-machine.service';
import { MarketTimelineEngine, RecordInput } from '../timeline/timeline.engine';

/**
 * One observation, with the internals the execution path needs.
 *
 * `response` is exactly what `observe()` has always returned and what the API
 * proxies to the workspace. The other two are the artefacts it was computed
 * FROM, exposed so the execution evaluation can read index direction and
 * strategy evidence off the same market read rather than taking a second one.
 * See `observeInternal`.
 */
export interface InternalObservation {
  response: ObserveResponse;
  snapshot: MarketSnapshot;
  detections: StrategyDetection[];
}
import { enforceVocabulary, statusHeadline } from '../vocabulary/vocabulary';
import { StrategyAdvisorService } from '../reasoning/strategy-advisor.service';
import { RegimeIntelligenceService } from '../reasoning/regime-intelligence.service';
import { SentinelIntelligenceService } from '../sentinel-intelligence/sentinel-intelligence.service';
import type { ReasoningRun } from '../sentinel-intelligence/types';

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
 *
 * `decide()` additionally reads `SentinelIntelligenceService.latestRun()` —
 * the cached verdict from the second, citation-grounded reasoning engine's
 * background watch, when one exists for this symbol. This is corroboration,
 * not a third gate: a null or non-agreeing cache entry never blocks or
 * changes this method's own two gates above, it only adds citations and a
 * `crossValidation` note to an answer this method was already going to give.
 * SentinelIntelligence's own pipeline is never invoked synchronously here —
 * only its already-computed, already-gated cache is read, so this adds zero
 * latency and zero LLM/data cost to `/observe`.
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
    private readonly behaviour: MarketBehaviourService,
    private readonly lifecycle: StrategyLifecycleService,
    private readonly calibration: AdaptiveCalibrationService,
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
    private readonly strategyAdvisor: StrategyAdvisorService,
    private readonly regimeIntel: RegimeIntelligenceService,
    private readonly sentinelIntelligence: SentinelIntelligenceService,
  ) {
    this.providers = createProviderManager(loadProvidersConfigFromEnv());
  }

  /**
   * Telemetry wrapper around the real workflow.
   *
   * Split from `runObservation` so the instrumentation is one readable block
   * instead of a `runAgentRun(` that opens at the top of a 200-line method and
   * closes off-screen. `runAgentRun` opens an AgentRun row, establishes the
   * ambient correlation context every nested agent and LLM call inherits, and
   * closes the run on BOTH the return and the throw path — a Sentinel run that
   * fails is the row an operator most wants and the one a naive
   * emit-at-the-end would never write.
   *
   * `surfaced` is reported from the response rather than assumed: Sentinel
   * choosing to stay silent is the designed outcome, not a failure, and the
   * portal has to be able to tell the two apart to judge whether the
   * confidence gate is tuned right.
   */
  async observe(request: ObserveRequest): Promise<ObserveResponse> {
    return (await this.observeInternal(request)).response;
  }

  /**
   * The same observation, plus the two internal artefacts it was built from.
   *
   * ## Why this exists rather than fields on `ObserveResponse`
   *
   * `ExecutionEvaluationService` needs the `MarketSnapshot` (to read index
   * direction and the strategy's declared evidence) and the full
   * `StrategyDetection[]` (to find a VALIDATED agent-tradable setup —
   * `strategyMatches` on the wire is the trimmed `StrategyMatch` shape and has
   * dropped `validated`). Neither may be obtained by observing again: a second
   * read is a second point in time, so the evidence would describe a market
   * fractionally different from the one the decision was published for.
   *
   * They are also not fields on `ObserveResponse`, and that is deliberate:
   * that object is proxied VERBATIM to `apps/web`, so anything added to it is
   * added to a trader's payload. The snapshot carries every candle in the
   * five-day window, and the detections carry unvalidated setups that the
   * publication gate exists to keep off a trader's screen.
   *
   * So: one read, two consumers, and the heavier consumer uses a method the
   * proxy does not call. Internal by convention AND by reachability — nothing
   * outside this service and `ExecutionEvaluationService` invokes it, and
   * `ExecutionEvaluationService` is itself reachable only from the
   * service-token-guarded `POST /execution/evaluate`.
   */
  async observeInternal(request: ObserveRequest): Promise<InternalObservation> {
    let observation!: InternalObservation;
    await runAgentRun(
      { system: 'sentinel', trigger: 'observe', symbol: request.symbol ?? 'NIFTY', userId: request.userId },
      async (runId) => {
        observation = await this.runObservation(request);
        const response = observation.response;
        // The run's own id, echoed to the caller. `runAgentRun` has always
        // passed it to this callback and always written it to AgentRun; it was
        // simply never returned, so a caller holding a response could not name
        // the run behind it. The paper-execution loop records this on every
        // ExecutionIntent, which is what makes "which Sentinel run produced
        // this order?" a foreign key rather than a timestamp search.
        response.runId = runId;
        return {
          surfaced: response.synthesis !== null,
          confidence: response.confidence?.score,
        };
      },
    );
    return observation;
  }

  private async runObservation(request: ObserveRequest): Promise<InternalObservation> {
    const at = new Date();
    const symbol = request.symbol ?? 'NIFTY';
    const trades = request.recentTrades ?? [];
    const sessionKey = MarketStateMachineService.sessionKey(request.userId, symbol, at);

    // Continuous Research Engine: event-driven, fire-and-forget so it never
    // adds latency to this response — enriches the Brain for next time.
    void this.researchTrigger.researchIfUnfamiliar(symbol).catch(() => undefined);
    // Continuous Learning from Outcomes: a small batch per call, on top of
    // `OutcomeLearningService`'s own timer. Kept rather than replaced by the
    // timer — it costs nothing when the backlog is empty, and it means request
    // traffic helps drain the backlog instead of only adding to it. The timer
    // is what makes tagging keep up on a quiet day, when the watch is writing
    // occurrences and nobody is calling this route at all.
    void this.outcomeLearning.evaluatePending(5).catch(() => undefined);

    // ---- Modules 1, 2, 4 and the behavioural agents ---------------------
    //
    // Each agent's computation is wrapped in `trackAgent`, which emits its
    // thinking → sending transitions to the telemetry bus. That is what the
    // admin portal's orbit renders: real work, in the order it actually
    // happened, rather than a decorative loop. The wrappers are pure
    // observation — they do not change ordering, error handling, or results.
    const snapshot = await trackAgent(
      'market-technical',
      () => this.market.snapshot(symbol),
      { detail: `snapshot ${symbol}` },
    );

    // ---- autonomy: an observation is what puts a symbol under watch --------
    //
    // Placed after the snapshot on purpose: a symbol whose data could not be
    // fetched throws above this line, so the watch list only ever contains
    // symbols Sentinel has actually managed to read.
    //
    // Without this, `MarketWatchService`'s only production caller was
    // `/intelligence/reason` — a route no app calls — so the watch list stayed
    // empty, every sweep exited at its `no-symbols` guard, and Sentinel noticed
    // nothing at all unless a browser was polling this endpoint. Registration
    // is in-memory, synchronous and idempotent (see `register()`), so this
    // neither slows the response nor waits on the sweep it enables; the sweep
    // stays on its own 60 s loop inside the service.
    //
    // Wrapped because watch bookkeeping must never be able to fail an
    // observation: Sentinel's read of the market is the product, the watch list
    // is housekeeping.
    try {
      this.sentinelIntelligence.watchSymbol(symbol, at);
    } catch (err) {
      this.logger.warn(`could not put ${symbol} under continuous watch (non-fatal): ${(err as Error).message}`);
    }

    // ---- what Sentinel is reading, per instrument ------------------------
    //
    // The underlying AND the two option legs at the at-the-money strike, all
    // on `SNAPSHOT_INTERVAL`. The workspace draws three charts; until this
    // landed only the first was read, so the other two claimed an engine that
    // was not running.
    //
    // STARTED HERE, AWAITED AT THE BOTTOM. Two live HTTP reads against the
    // market-data bridge (one per leg, each with its own 4s abort) would add
    // seconds to an observation that runs ~1.6s if they sat on the critical
    // path — and this is the one part of the response that nothing else
    // consumes, so nothing below needs to wait for it. Kicking it off beside
    // the agent work costs a floating promise and buys back its whole latency.
    //
    // Additive and non-fatal by construction: it contributes no signal, gates
    // nothing, and a failure leaves `contractWatch` undefined rather than
    // failing an observation of the underlying that is otherwise fine. The
    // `.catch` is attached IMMEDIATELY, not at the await — an unhandled
    // rejection between here and the bottom of this method would be an
    // unhandled rejection in the service, not a caught one.
    const contractWatchPromise = trackAgent(
      'market-technical',
      () =>
        this.market.contracts(snapshot).catch((err) => {
          this.logger.warn(`contract read failed for ${symbol} (non-fatal): ${(err as Error).message}`);
          return undefined;
        }),
      { detail: `reading option legs at the money — ${symbol}` },
    ).catch(() => undefined);

    const signals: Signal[] = [
      ...(await trackAgent(
        'market-technical',
        async () => this.market.signals(snapshot),
        { detail: 'scanning structure — EMA / RSI / VWAP / CPR' },
      )),
      ...(await trackAgent(
        'emotion',
        async () => this.emotion.signals(trades),
        { detail: `reading ${trades.length} recent trades` },
      )),
      ...(await trackAgent(
        'trap-safety',
        async () => this.traps.signals(snapshot, trades),
        { detail: 'checking sweeps, false breakouts, expiry traps' },
      )),
      ...(await trackAgent('news', () => this.news.signals(symbol), { detail: `newswire scan — ${symbol}` })),
    ];
    // ---- Phase 2 — market behaviour understanding -----------------------
    // Structure, liquidity and continuation/reversal, composed from the
    // snapshot already fetched. Emitted as signals so it reaches the
    // confidence engine, the activity timeline and the publication gate
    // through the paths that already exist.
    const behaviourRead = await trackAgent(
      'market-technical',
      async () => this.behaviour.analyse(snapshot),
      { detail: 'reading structure, liquidity and market behaviour' },
    );
    signals.push(...this.behaviour.signals(behaviourRead));

    const rawDetections = this.strategies.scan(snapshot, at);

    // ---- Phase 4 — apply learned per-regime reliability ------------------
    // A strategy that has repeatedly failed in this regime contributes less
    // confidence than the same rule match in a regime where it works. Scaling
    // only — a poorly-performing strategy is never suppressed, because a
    // silenced strategy can never demonstrate that it recovered, and hiding it
    // would also remove it from the trader's own judgement.
    const detections = rawDetections.map((detection) => {
      const calibration = this.calibration.reliabilityFor(detection.strategyId, behaviourRead.regime);
      if (!calibration || calibration.successRate === null) return detection;
      return {
        ...detection,
        confidence: Math.max(0, Math.min(100, detection.confidence * calibration.reliability)),
        rulesMatched: [...detection.rulesMatched, `Learned calibration: ${calibration.rationale}`],
      };
    });
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

    // The compliance agent produces no user-facing text, so without an explicit
    // transition it would be the one agent that never appears in the orbit —
    // indistinguishable, to an operator, from an agent that is broken.
    emitAgentActivity('compliance-audit', 'thinking', { detail: `labelling ${observations.length} observations` });

    // ---- what, if anything, is worth saying -----------------------------
    const { synthesis, crossValidation, publication } = await trackAgent(
      'orchestrator',
      () =>
        this.decide({
          symbol,
          status,
          snapshot,
          signals,
          triggered,
          detections,
          confidence,
          stateEval,
          historical,
          behaviour: behaviourRead,
          sessionKey,
          at,
        }),
      { detail: `synthesising from ${triggered.length} corroborating signals` },
    );

    emitAgentActivity('compliance-audit', 'sending', { peer: 'orchestrator', detail: 'labels attached' });

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

    // Merge observations persisted in DB over the last 24 hours
    const past24hDbObservations = await this.compliance.feed(request.userId, 100);
    const observationMap = new Map<string, SentinelObservationOut>();
    for (const obs of [...observations, ...past24hDbObservations]) {
      const key = `${obs.agent}:${obs.pattern ?? obs.category}:${obs.content}`;
      if (!observationMap.has(key)) {
        observationMap.set(key, obs);
      }
    }
    const all24hObservations = Array.from(observationMap.values());

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

    // ---- Phase 3: strategy focus + side-in-focus ------------------------
    // Pure, synchronous framing over what was already computed — no extra
    // retrieval, no second scan. Auto picks the leading corroborated setup as
    // context; manual validates the user's pick against live conditions. Side
    // in focus surfaces only above the confidence threshold.
    const currentState = stateEval.snapshot.current;
    const regime = this.regimeIntel.classify(snapshot.marketProfile);
    const mode = request.strategyMode ?? 'auto';
    const requestedIds = resolveRequestedStrategyIds(request);
    const strategyAdvices: StrategyAdvice[] =
      mode === 'manual' && requestedIds.length > 0
        ? requestedIds.map((id) =>
            this.strategyAdvisor.advise({
              mode: 'manual',
              requestedStrategyId: id,
              detections,
              confidence,
              snapshot,
              regime,
              state: currentState,
            }),
          )
        : [
            this.strategyAdvisor.advise({
              mode: 'auto',
              requestedStrategyId: null,
              detections,
              confidence,
              snapshot,
              regime,
              state: currentState,
            }),
          ];
    const strategyAdvice = strategyAdvices[0];
    const sideInFocus = this.strategyAdvisor.sideInFocus({
      symbol,
      detections,
      confidence,
      snapshot,
      state: currentState,
      // One authority on what surfaces. See `StrategyAdvisorService.sideInFocus`.
      publication,
    });

    // ---- Phase 3 — option-chain context on the surfaced side -------------
    // Attached only when a side is actually in focus. Building it for a read
    // that was never surfaced would put a strike in the response that nothing
    // in the UI is entitled to show.
    if (sideInFocus) {
      sideInFocus.optionContext = buildOptionContext(snapshot, sideInFocus.bias);
    }

    // ---- Phase 3 — advance each strategy's own lifecycle -----------------
    // Runs after the publication decision so SIDE_IN_FOCUS is reachable only
    // by a strategy that actually cleared the gate, never by rule match alone.
    const strategyLifecycles = await this.lifecycle.advance({
      sessionKey,
      symbol,
      detections,
      publishedStrategyId: publication.publish ? (detections[0]?.strategyId ?? null) : null,
      behaviour: {
        read: behaviourRead.behaviour.read,
        direction: behaviourRead.behaviour.direction,
        strength: behaviourRead.behaviour.strength,
      },
      lastPrice: snapshot.lastPrice,
      regime: behaviourRead.regime,
      at,
    });

    // ---- Phase 6 — do the independent evidence dimensions agree? --------
    // Transparency, never a sixth gate: the four-condition publication gate
    // remains the only authority on what reaches a trader. Hoisted out of the
    // response literal so the observation log below reads the same object the
    // response carries, rather than recomputing it.
    const institutionalCrossValidation = buildInstitutionalCrossValidation({
      leadingBias: detections[0]?.bias ?? snapshot.trendAnalysis?.direction ?? 'neutral',
      signals,
      optionChain: snapshot.optionChain,
      historical,
      behaviour: {
        read: behaviourRead.behaviour.read,
        direction: behaviourRead.behaviour.direction,
        strength: behaviourRead.behaviour.strength,
      },
      lastPrice: snapshot.lastPrice,
    });

    // ---- validated events for delivery channels --------------------------
    // Derived from the gate's decision, NOT from `sideInFocus` — which is in
    // scope right here and must stay out of this call. See the header of
    // `events/sentinel-event.ts`: an event cannot carry a direction, and the
    // way that stays true is that the deriving function is never handed one.
    const events = deriveSentinelEvents({
      symbol,
      at,
      state: stateEval.snapshot.current,
      transition: stateEval.transition,
      published: publication.publish,
      synthesis,
      risk: riskAssessment,
      confidence,
    });

    // ---- live-validation observability ----------------------------------
    // One structured line per observation, covering every event the live
    // validation needs to capture: detections, the publication decision and
    // its binding constraint, the confidence figure, lifecycle transitions,
    // and whether an outcome reached the Brain. Instrumentation only — it
    // reads state that was already computed and changes nothing.
    //
    // The contract read started right after the snapshot and has been running
    // alongside every agent above. Collected here, at the last possible
    // moment, so its two HTTP reads overlap the work rather than delay it.
    const contractWatch = await contractWatchPromise;

    // Set SENTINEL_OBSERVATION_LOG=false to silence it.
    if (process.env.SENTINEL_OBSERVATION_LOG !== 'false') {
      const transitions = strategyLifecycles.filter((l) => l.changed);
      this.logger.log(
        `OBSERVE ${symbol} | state=${stateEval.snapshot.current}` +
          ` confidence=${confidence.score}/${confidence.threshold}` +
          ` published=${publication.publish}` +
          (publication.publish ? '' : ` blockedBy=${publication.conditions.find((c) => !c.passed)?.id ?? 'unknown'}`) +
          ` corroboration=${publication.corroboratingSources.length}` +
          ` conflicts=${publication.conflicts.length}` +
          ` detections=[${detections.map((d) => `${d.strategyId}:${d.validated ? 'validated' : 'forming'}`).join(',') || 'none'}]` +
          ` structure=${behaviourRead.structure.state}` +
          `/${behaviourRead.structure.event ?? 'no-event'}` +
          ` behaviour=${behaviourRead.behaviour.read}@${behaviourRead.behaviour.strength}` +
          ` regime=${behaviourRead.regime ?? 'unclassified'}` +
          ` consensus=${institutionalCrossValidation.consensus ?? 'none'}` +
          `(${institutionalCrossValidation.agreeing}/${institutionalCrossValidation.voting},` +
          `abstain=${institutionalCrossValidation.abstaining.length})` +
          ` lifecycleChanges=[${transitions.map((t) => `${t.strategyId}→${t.state}`).join(',') || 'none'}]` +
          ` contracts=${contractWatch ? `${contractWatch.strike ?? 'none'}@${contractWatch.alignment ?? 'unread'}` : 'unavailable'}` +
          ` sideInFocus=${sideInFocus ? sideInFocus.side : 'null'}` +
          ` events=[${events.map((e) => `${e.kind}:${e.severity}`).join(',') || 'none'}]`,
      );
    }

    const response: ObserveResponse = {
      synthesis,
      crossValidation,
      publication,
      events,
      marketBehaviour: {
        regime: behaviourRead.regime,
        structure: {
          state: behaviourRead.structure.state,
          event: behaviourRead.structure.event,
          eventDirection: behaviourRead.structure.eventDirection,
          lastSwingHigh: behaviourRead.structure.lastSwingHigh?.price ?? null,
          lastSwingLow: behaviourRead.structure.lastSwingLow?.price ?? null,
        },
        liquidity: {
          pools: behaviourRead.liquidity.pools.slice(0, 5),
          recentSweep: behaviourRead.liquidity.recentSweep,
        },
        behaviour: {
          read: behaviourRead.behaviour.read,
          direction: behaviourRead.behaviour.direction,
          strength: behaviourRead.behaviour.strength,
        },
        narrative: behaviourRead.narrative,
        evidence: behaviourRead.evidence,
      },
      contractWatch,
      // Opt-in only (see ObserveRequest.includeOptionChain). `undefined` when
      // not asked for so the field is absent from the wire entirely; `null`
      // when asked for and the instrument published no chain — a caller that
      // requested the chain must be able to tell "you didn't ask" from "there
      // wasn't one", because the second is a reason not to execute.
      optionChain: request.includeOptionChain
        ? snapshot.optionChain
          ? {
              frontExpiry: snapshot.optionChain.frontExpiry.toISOString(),
              entries: snapshot.optionChain.entries.map((e) => ({
                strike: e.strike,
                callOI: e.callOI,
                putOI: e.putOI,
                callVolume: e.callVolume,
                putVolume: e.putVolume,
                callIV: e.callIV,
                putIV: e.putIV,
                callLtp: e.callLtp,
                putLtp: e.putLtp,
              })),
            }
          : null
        : undefined,
      observations: all24hObservations,
      signals,
      marketContext,
      marketProfile: snapshot.marketProfile,
      strategyMatches: detections.map(toStrategyMatch),
      risk: riskAssessment,
      confidence,
      marketState: stateEval.snapshot,
      timeline: this.timeline.entries(sessionKey),
      explanation,
      strategyAdvice,
      strategyAdvices,
      sideInFocus,
      strategyLifecycles,
      institutionalCrossValidation,
      // ---- Phase 5 — every element used in the reasoning, as chart drawings.
      // Uses the existing `ChartAnnotation` contract so the TradingView
      // Charting Library binding, when it lands, has one shape to render and
      // one audit guarantee to honour.
      chartAnnotations: buildReasoningAnnotations({
        symbol,
        // Live bars, forming one included. These set the time SPAN a drawing
        // is stretched across, and the browser draws its own candles from the
        // bridge — which include the forming bar. A level line that stopped
        // one bar short of the chart it is drawn on would look like the level
        // had expired when it had not.
        candles: liveCandles(snapshot),
        behaviour: behaviourRead,
        lifecycles: strategyLifecycles,
        support: snapshot.support,
        resistance: snapshot.resistance,
        openingRange: snapshot.openingRange
          ? { high: snapshot.openingRange.high, low: snapshot.openingRange.low }
          : null,
      }),
    };

    // The wire response is unchanged from what this method has always
    // returned; `snapshot` and `detections` ride alongside it for the
    // execution path only. See `observeInternal`.
    return { response, snapshot, detections };
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
    behaviour: MarketBehaviourRead;
    sessionKey: string;
    at: Date;
  }): Promise<{
    synthesis: ObserveResponse['synthesis'];
    crossValidation: ObserveResponse['crossValidation'];
    publication: PublicationDecision;
  }> {
    const state = ctx.stateEval.snapshot.current;

    // Read-only, zero-latency: SentinelIntelligence's own background watch
    // already computed and gated this, or hasn't reasoned about this symbol
    // recently — either way nothing is invoked here, only a cache read.
    const backgroundRun = this.sentinelIntelligence.latestRun(ctx.symbol);
    const leadingBias = ctx.detections[0]?.bias ?? ctx.snapshot.trendAnalysis?.direction ?? 'neutral';
    const leadingPatternId = ctx.detections[0]?.strategyId ?? null;
    const crossValidation = buildCrossValidation(backgroundRun, leadingBias, leadingPatternId);

    // --- the four-condition publication gate -----------------------------
    // Confidence alone never publishes. See `publication-gate.ts` for why the
    // threshold is fixed while the weights feeding it adapt.
    const publication = evaluatePublication({
      state,
      confidence: ctx.confidence,
      detections: ctx.detections,
      marketProfile: ctx.snapshot.marketProfile,
      historical: ctx.historical,
      crossValidation,
      behaviour: {
        read: ctx.behaviour.behaviour.read,
        direction: ctx.behaviour.behaviour.direction,
        strength: ctx.behaviour.behaviour.strength,
        structureState: ctx.behaviour.structure.state,
      },
      requestedThreshold: ctx.confidence.threshold,
    });

    if (publication.publish) {
      const leading = ctx.detections[0];
      const content = await this.composeGuidance(
        ctx.symbol,
        ctx.status,
        ctx.confidence,
        leading,
        ctx.historical,
        crossValidation?.agreesWithConclusion ? crossValidation.citations : [],
      );
      this.timeline.record(ctx.sessionKey, {
        event: `${ctx.status} — ${ctx.confidence.score}% confidence across ${ctx.confidence.factors.length} factors`,
        level: 'guidance',
        confidence: ctx.confidence.score,
        state,
        at: ctx.at,
        dedupeKey: `guidance:${state}:${ctx.status}`,
      });
      return {
        synthesis: {
          content,
          pattern: leading?.strategyId ?? state.toLowerCase(),
          confidence: ctx.confidence.score / 100,
          disclaimer: SENTINEL_DISCLAIMER,
          status: ctx.status,
          state,
        },
        crossValidation,
        publication,
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
        synthesis: {
          content,
          pattern: dominant.name,
          confidence: Math.min(0.95, compositeWeight / 2 + 0.3),
          disclaimer: SENTINEL_DISCLAIMER,
          status: ctx.status,
          state,
        },
        crossValidation,
        publication,
      };
    }

    // --- Wait and Watch --------------------------------------------------
    // Nothing cleared. Record WHY on the timeline so the session narrative
    // shows the evidence that was missing, not just an absence of guidance.
    if (!publication.publish && publication.waitAndWatchReason && GUIDANCE_STATES.includes(state)) {
      this.timeline.record(ctx.sessionKey, {
        event: publication.waitAndWatchReason,
        level: 'observation',
        confidence: ctx.confidence.score,
        state,
        at: ctx.at,
        dedupeKey: `wait:${state}:${publication.conditions.find((c) => !c.passed)?.id ?? 'unknown'}`,
      });
    }

    return { synthesis: null, crossValidation, publication };
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
      const openTime = new Date(open.timestamp);
      const gap = snapshot.priorDay ? open.open - snapshot.priorDay.close : null;
      out.push({
        event:
          `Market open: ${symbol} opened at ${open.open.toFixed(1)}` +
          (gap !== null ? ` (${gap >= 0 ? '+' : ''}${gap.toFixed(1)} from the prior close)` : '') +
          (snapshot.vix !== null ? `. India VIX ${snapshot.vix.toFixed(1)}.` : '.'),
        level: 'info',
        at: openTime,
        dedupeKey: 'session:open',
      });
    }

    if (snapshot.openingRange) {
      const openTime = snapshot.sessionCandles[0] ? new Date(snapshot.sessionCandles[0].timestamp) : at;
      out.push({
        event: `Opening range established: ${snapshot.openingRange.low.toFixed(1)} – ${snapshot.openingRange.high.toFixed(1)}.`,
        level: 'observation',
        at: openTime,
        dedupeKey: 'session:orb',
      });
    }

    if (snapshot.marketProfile) {
      const profileTime = snapshot.sessionCandles.length > 0
        ? new Date(snapshot.sessionCandles[snapshot.sessionCandles.length - 1].timestamp)
        : at;
      out.push({
        event: `Session classified as ${snapshot.marketProfile.type} — ${snapshot.marketProfile.description}.`,
        level: 'observation',
        at: profileTime,
        dedupeKey: `profile:${snapshot.marketProfile.type}`,
      });
    }

    const latestBarTime = snapshot.sessionCandles.length > 0
      ? new Date(snapshot.sessionCandles[snapshot.sessionCandles.length - 1].timestamp)
      : at;

    for (const d of detections) {
      // `detectedAt` is the bar the rules matched on (see `StrategyEngineService.scan`),
      // so a timeline entry is placed at the market event rather than at the
      // poll that happened to notice it. `observedAt` rides along in `data` so
      // the audit trail can still answer "when did Sentinel look?" — the two
      // used to be the same value, which is why the narrative bunched every
      // setup at refresh time.
      const eventTime = d.detectedAt ? new Date(d.detectedAt) : latestBarTime;
      const provenance = { observedAt: d.observedAt ?? at.toISOString() };
      out.push({
        event: d.validated
          ? `${d.strategyName} confirmed — all ${d.rulesMatched.length} rules met. ${d.rulesMatched.join('; ')}.`
          : `${d.strategyName} forming — ${d.rulesMatched.length} of ${d.rulesMatched.length + d.rulesUnmet.length} rules confirmed.`,
        level: 'setup',
        confidence: d.confidence,
        at: eventTime,
        data: provenance,
        dedupeKey: `detect:${d.strategyId}:${d.validated ? 'confirmed' : d.rulesMatched.length}`,
      });
      if (d.invalidationsTriggered.length > 0) {
        out.push({
          event: `${d.strategyName} invalidated — ${d.invalidationsTriggered.join('; ')}.`,
          level: 'setup',
          at: eventTime,
          data: provenance,
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
    crossValidationCitations: KnowledgeCitation[] = [],
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
      // Cross-validated by SentinelIntelligence's independently-gated,
      // citation-grounded background read — only ever added when it agrees.
      ...crossValidationCitations
        .slice(0, 2)
        .map((c) => `${c.sourceTitle} (${c.locator}): "${c.quote}"`),
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
    // Market time and execution time both reach the client, so the workspace
    // can show when the market did this rather than when it last refreshed.
    observedAt: d.observedAt,
  };
}

/**
 * `selectedStrategyIds` is preferred; `selectedStrategyId` is read only as a
 * fallback for callers that haven't migrated to the multi-strategy field.
 */
function resolveRequestedStrategyIds(request: ObserveRequest): string[] {
  if (request.selectedStrategyIds && request.selectedStrategyIds.length > 0) {
    return request.selectedStrategyIds;
  }
  return request.selectedStrategyId ? [request.selectedStrategyId] : [];
}

function dominantSignal(signals: Signal[]): Signal | null {
  const triggered = signals.filter((s) => s.triggered);
  if (triggered.length === 0) return null;
  return [...triggered].sort((a, b) => b.weight - a.weight)[0];
}

/**
 * Translates SentinelIntelligence's cached `ReasoningRun` (if any exists for
 * this symbol) into the response's `crossValidation` field. Never throws and
 * never returns anything that could change what `decide()` was already going
 * to answer — agreement is judged, not enforced.
 */
export function buildCrossValidation(
  run: ReasoningRun | null,
  leadingBias: string,
  leadingPatternId: string | null,
): ObserveResponse['crossValidation'] {
  if (!run) return null;
  const { synthesis } = run;
  const agreesWithConclusion =
    synthesis.surfaced &&
    (synthesis.leadingStance === leadingBias ||
      (leadingPatternId !== null && synthesis.observation?.pattern === leadingPatternId));
  const citations: KnowledgeCitation[] = (synthesis.observation?.citations ?? []).map((c) => ({
    chunkId: c.chunkId,
    sourceId: c.sourceId,
    sourceTitle: c.sourceTitle,
    sourcePath: c.sourcePath,
    sourceKind: c.sourceKind,
    locator: c.locator,
    charStart: c.charStart,
    charEnd: c.charEnd,
    quote: c.quote,
    relevance: c.relevance,
  }));
  const supportingConcepts: CrossValidationConcept[] = (synthesis.observation?.supportingConcepts ?? []).map((c) => ({
    conceptId: c.conceptId,
    name: c.name,
    relevance: c.relevance,
    weight: c.weight,
  }));
  return {
    surfaced: synthesis.surfaced,
    agreesWithConclusion,
    citations,
    supportingConcepts,
    corroboratingAgents: synthesis.corroboratingAgents,
    silenceReason: synthesis.silenceReason,
  };
}
