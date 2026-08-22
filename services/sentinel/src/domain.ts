/**
 * Sentinel internal domain — signals, observations, and the observe contract.
 *
 * Single source of truth for every type that crosses a module boundary or
 * appears on the wire (services/api proxies this JSON straight through to
 * apps/web). Engine-internal shapes stay inside their engine; anything the
 * orchestrator returns lives here.
 */

/**
 * Which intelligence engine produced a signal.
 *
 * `news` was added 2026-08-21. `NewsIntelligenceService` had been emitting its
 * one signal under `market-technical` because this union had no member for it,
 * which cost two things: the cross-validator had to exclude
 * `news_driven_volatility` BY NAME to stop one piece of evidence voting twice
 * (once as a technical, once as its own dimension), and news contribution was
 * unattributable in the signal stream. Both are structural now rather than
 * maintained by a name list.
 */
export type SignalAgent =
  | 'market-technical'
  | 'emotion'
  | 'trap-safety'
  | 'strategy'
  | 'risk'
  | 'news';

/** A single deterministic signal computed by an intelligence engine. */
export interface Signal {
  /** e.g. 'low_volume_breakout', 'revenge_trading', 'elevated_vix' */
  name: string;
  /** which engine produced it */
  agent: SignalAgent;
  triggered: boolean;
  /** 0..1 contribution toward the composite warning threshold */
  weight: number;
  /** human-readable evidence lines, cited in the final output */
  evidence: string[];
  /** structured values backing the evidence (for the audit trail) */
  data?: Record<string, unknown>;
}

/** Trade summary passed in by services/api (Sentinel never queries trading tables). */
export interface TradeSummary {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  fillPrice: number;
  realizedPnl?: number;
  createdAt: string; // ISO
}

export interface PositionSummary {
  symbol: string;
  quantity: number;
  avgPrice: number;
  realizedPnl: number;
}

/**
 * Account context for Risk Intelligence factor 3 (Position Risk). Supplied by
 * services/api when it knows them; every field is optional and the engine
 * degrades to "unknown, stay conservative" rather than inventing numbers.
 */
export interface AccountSummary {
  marginUsed?: number;
  marginAvailable?: number;
  totalCapital?: number;
  leverage?: number;
}

export interface ObserveRequest {
  userId: string;
  /** primary symbol in focus (chart open / order ticket), optional */
  symbol?: string;
  /** recent trades, most recent first — supplied by services/api, read-only */
  recentTrades?: TradeSummary[];
  positions?: PositionSummary[];
  /** margin/sizing context for the Position Risk factor, when available */
  account?: AccountSummary;
  /** free-form UI context, e.g. 'order_ticket_open' */
  context?: string;
  /** overrides the trader's configured confidence threshold for this call (0-100) */
  confidenceThreshold?: number;
  /**
   * Phase 3 — strategy focus. 'auto' (default) lets Sentinel pick the
   * best-corroborated setup as reasoning context; 'manual' pins one or more
   * specific educational strategies from the registry and validates each
   * against live conditions independently. Neither mode ever forces a setup
   * or emits a directive.
   */
  strategyMode?: 'auto' | 'manual';
  /**
   * Phase 2 (multi-strategy) — registry strategy ids to track simultaneously
   * when strategyMode === 'manual'. Preferred over `selectedStrategyId`.
   */
  selectedStrategyIds?: string[];
  /**
   * @deprecated singular predecessor of `selectedStrategyIds`. Still read —
   * treated as `[selectedStrategyId]` — when `selectedStrategyIds` is absent,
   * so existing single-strategy callers are unaffected.
   */
  selectedStrategyId?: string;
  /**
   * Attach the front-expiry option chain this observation was actually built
   * on to the response (`ObserveResponse.optionChain`).
   *
   * Off by default and set by exactly ONE caller: the paper-execution loop's
   * evaluation path, which needs per-strike premiums to evaluate candidate
   * contracts. A chain is ~50-100 rows and the workspace polls `/observe` every
   * 10-30 s, so shipping it unconditionally would be a real payload cost for a
   * field no browser reads.
   *
   * It exists as a flag rather than a second endpoint because the alternative
   * — re-reading the chain in the execution layer — would be a read at a
   * DIFFERENT moment, and a candidate premium that disagrees with the PCR
   * computed beside it is worse than no candidate at all.
   */
  includeOptionChain?: boolean;
}

// ------------------------------------------------------ Phase 3 strategy focus

/** Whether the selected/auto strategy is a good fit for the live market. */
export type MarketSuitability = 'high' | 'moderate' | 'low' | 'unknown';

/** Validation of a manually-selected strategy against live conditions. */
export interface StrategyValidation {
  regimeCompatible: boolean;
  volatilityOk: boolean;
  liquidityOk: boolean;
  /** rule names the strategy needs confirmed */
  requiredConfirmations: string[];
  /** required rules not yet confirmed on the live setup */
  missingConfirmations: string[];
  /** true only when every gate passed AND confidence cleared its threshold */
  passed: boolean;
}

/**
 * The strategy-focus read attached to every observation. Educational context,
 * never a directive: `activeStrategyId` is what the Brain treats as additional
 * reasoning context, not an instruction to trade it.
 */
export interface StrategyAdvice {
  mode: 'auto' | 'manual';
  /** null in auto mode */
  requestedStrategyId: string | null;
  /** the strategy the Brain is currently reasoning with, if any */
  activeStrategyId: string | null;
  activeStrategyName: string | null;
  /** true when the Brain chose the strategy (auto mode with a live match) */
  aiSelected: boolean;
  /** 0..100 — the observation's aggregate confidence */
  confidence: number;
  meetsThreshold: boolean;
  marketSuitability: MarketSuitability;
  /** compact status line, e.g. "AI Selected: ICT Liquidity Sweep" */
  status: string;
  /** one-line human-readable explanation */
  message: string;
  /** present only in manual mode */
  validation?: StrategyValidation;
}

/** Educational trade-management framing. Never an order, never a guarantee. */
export interface TradeManagementGuidance {
  /** default risk:reward framing, e.g. "1:3" */
  riskReward: string;
  /** trailing progression, e.g. ["1:1","1:2","1:3"] */
  trailing: string[];
  note: string;
}

export interface LiveValidationStatus {
  status: 'developing' | 'target_reached' | 'invalidated' | 'observing';
  label: string;
  pnlPoints: number;
  entryPrice: number;
  currentPrice: number;
}

/**
 * Which side the corroborated evidence favours, surfaced only above the
 * confidence threshold (>= 70%). `side` is CE or PE for the educational option lens;
 * it is never a buy/sell instruction.
 */
export interface SideInFocus {
  side: 'CE' | 'PE';
  bias: 'bullish' | 'bearish';
  /** nearest at-the-money strike in the favoured direction, or null if unknown */
  strike: number | null;
  confidence: number;
  rationale: string[];
  tradeManagement: TradeManagementGuidance;
  disclaimer: string;
  /** Live validation status tracking post-signal movement */
  liveValidation?: LiveValidationStatus;
  /**
   * Phase 3 — the option-chain context this structural read concerns.
   */
  optionContext?: {
    underlying: string;
    atmStrike: number | null;
    focusStrike: number | null;
    side: 'CE' | 'PE';
    pcr: number | null;
    maxPain: number | null;
    callOIWall: number | null;
    putOIWall: number | null;
    notes: string[];
    unavailable: boolean;
    unavailableReason: string | null;
  };
}

// ---------------------------------------------------------------- Module 1
// Market Intelligence Engine — today's regime and structural profile.

export type MarketProfileType =
  | 'Bullish Trend Day'
  | 'Bearish Trend Day'
  | 'High Volatility Range'
  | 'Low Volatility Compression'
  | 'Gap & Go'
  | 'Gap Fill / Mean Reversion'
  | 'Inside Day'
  | 'Outside Day / Expansion'
  | 'Rally Continuation'
  | 'Descent Continuation';

export interface MarketProfile {
  type: MarketProfileType;
  description: string;
  trend: 'bullish' | 'bearish' | 'neutral' | 'choppy';
  volatility: 'high' | 'low' | 'normal';
  structure: 'trending' | 'ranging' | 'consolidating' | 'breaking-out';
  /** the observations that led to this classification */
  evidence: string[];
}

export interface TrendAnalysis {
  /** session change from the first bar in view, in percent */
  sessionChangePct: number;
  /** 0..1 — how one-directional the recent bars are */
  momentumScore: number;
  /** last bar volume / 20-bar average */
  volumeStrength: number;
  direction: 'bullish' | 'bearish' | 'neutral';
}

// ---------------------------------------------------------------- Module 2
// Strategy Engine — the trader's own strategy handbook, evaluated live.

/** A strategy match, in serializable form (the wire/audit shape). */
export interface StrategyMatch {
  strategyId: string;
  strategyName: string;
  /** 0..100 — base weight scaled by how much of the rule set confirmed */
  confidence: number;
  /** directional bias the setup implies — described, never prescribed */
  bias: 'bullish' | 'bearish' | 'neutral';
  rulesMatched: string[];
  rulesUnmet: string[];
  invalidationsTriggered: string[];
  /**
   * MARKET time — the bar the rules were evaluated against, not the clock time
   * of the scan. See `observedAt` for the difference and why both are kept.
   */
  detectedAt: string; // ISO
  /**
   * EXECUTION time — when the scan that produced this match actually ran.
   *
   * Optional because it was added after the shape was in use; every scan
   * produced by `StrategyEngineService` populates it. Kept alongside
   * `detectedAt` because collapsing the two is what made a setup formed on an
   * earlier bar read as if it had appeared at whatever moment the dashboard
   * last polled — the session narrative orders by market time, while an
   * auditor needs to know when Sentinel looked.
   */
  observedAt?: string; // ISO
}

// ---------------------------------------------------------------- Module 6
// Risk Intelligence Engine — 8 factors, scored 0-100 where higher = riskier.

export type RiskLevel = 'very_low' | 'low' | 'moderate' | 'high' | 'extreme';

export interface RiskFactor {
  name: string;
  /** 0-100, higher is riskier */
  score: number;
  /** relative importance; weights across all factors sum to 1 */
  weight: number;
  evidence: string[];
  data?: Record<string, unknown>;
}

export interface RiskAssessment {
  /** weighted 0-100, higher is riskier */
  overallRisk: number;
  level: RiskLevel;
  factors: RiskFactor[];
  assessedAt: string; // ISO
}

// ---------------------------------------------------------------- Module 7
// Confidence Engine — 7 weighted factors into one transparent percentage.

export interface ConfidenceFactor {
  name: string;
  label: string;
  /** 0-100 */
  score: number;
  /** relative weight; weights sum to 1 */
  weight: number;
  evidence: string[];
}

export interface ConfidenceDeduction {
  reason: string;
  /** percentage points removed from the weighted score */
  points: number;
}

export interface ConfidenceBreakdown {
  /** 0-100 after deductions */
  score: number;
  /** the score before deductions were applied */
  weightedScore: number;
  threshold: number;
  meetsThreshold: boolean;
  factors: ConfidenceFactor[];
  deductions: ConfidenceDeduction[];
  computedAt: string; // ISO
}

// ---------------------------------------------------------------- Module 9
// Market State Machine — Sentinel is always in exactly one state.

export type MarketStateValue =
  | 'PRE_MARKET'
  | 'OBSERVATION'
  | 'MARKET_UNDERSTANDING'
  | 'STRATEGY_DETECTION'
  | 'VALIDATION'
  | 'WAIT_AND_WATCH'
  | 'SIDE_IN_FOCUS'
  | 'OPPORTUNITY_ACTIVE'
  | 'MOVE_DEVELOPING'
  | 'MOMENTUM_WEAKENING'
  | 'MOVE_COMPLETE'
  | 'MARKET_CLOSE';

export type SessionPhase = 'pre-market' | 'active' | 'closing' | 'closed';

export interface StateTransition {
  from: MarketStateValue;
  to: MarketStateValue;
  at: string; // ISO
  /** why the machine moved — always an observation, never an instruction */
  trigger: string;
}

export interface MarketStateSnapshot {
  current: MarketStateValue;
  previous: MarketStateValue | null;
  since: string; // ISO
  sessionPhase: SessionPhase;
  /** transitions recorded for this session key, oldest first */
  history: StateTransition[];
}

// ------------------------------------------------------- Sentinel events
// The validated contract that leaves this service for delivery channels.
// Shapes live here (and the derivation in `events/sentinel-event.ts`) for the
// same reason `PublicationDecision` is mirrored inline above: `domain.ts` must
// not depend on a module that depends on it. Read that file's header before
// adding a field — the ABSENCE of side/bias/strike here is the safety
// property, not an oversight.

export type SentinelEventKind =
  | 'guidance-published'
  | 'risk-elevated'
  | 'emotional-risk'
  | 'state-transition'
  | 'safety-warning';

export type SentinelEventSeverity = 'info' | 'warning' | 'critical';

export interface SentinelEvent {
  kind: SentinelEventKind;
  severity: SentinelEventSeverity;
  /** short, non-directive headline */
  title: string;
  /** the body a channel renders; already vocabulary-enforced where synthesized */
  body: string;
  symbol: string;
  /** collapses repeats of the same kind across polls; shares the timeline's vocabulary */
  dedupeKey: string;
  at: string; // ISO
  /** 0-100 as the confidence engine reports it; null when the kind has no confidence */
  confidence: number | null;
  state: MarketStateValue;
}

// ---------------------------------------------------------------- Module 8
// Market Timeline Engine — one continuous session narrative.

export type TimelineLevel = 'info' | 'observation' | 'setup' | 'guidance' | 'transition';

export interface TimelineEntry {
  /** ISO timestamp */
  at: string;
  /** HH:mm in IST, precomputed so every surface renders it identically */
  time: string;
  event: string;
  level: TimelineLevel;
  confidence?: number;
  state?: MarketStateValue;
  data?: Record<string, unknown>;
}

// ------------------------------------------------------------------- §5
// Confidence Explainability ("Why?" Inspector).

export interface ConfidenceExplainResult {
  /** the non-directive status line this explains, e.g. 'Bullish side in focus' */
  status: string;
  score: number;
  threshold: number;
  meetsThreshold: boolean;
  matchedStrategies: string[];
  confirmingIndicators: string[];
  historicalPrecedent: string;
  newsEnvironment: string;
  riskNotes: string[];
  deductions: string[];
  timingRationale: string;
  /** Module 5 — educational principles from the Learning Hub that apply here */
  learningReferences: string[];
  /** SentinelIntelligence's book/document corpus — verbatim, citable quotes backing the active setup */
  bookCitations: KnowledgeCitation[];
  /** factor label → score, for the breakdown table */
  factorScores: Record<string, number>;
}

/** Mirrors `KnowledgeCitation` from sentinel-intelligence/types — duplicated here so `domain.ts` has no dependency on that module. */
export interface KnowledgeCitation {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  sourcePath: string;
  sourceKind: string;
  locator: string;
  charStart: number;
  charEnd: number;
  quote: string;
  relevance: number;
}

// ------------------------------------------------------------- observe I/O

export interface SentinelObservationOut {
  agent: string;
  category: string;
  pattern?: string;
  symbol?: string;
  content: string;
  evidence: string[];
  confidence: number;
  createdAt?: string;
}

/** Mirrors `SupportingConcept` from sentinel-intelligence/types — duplicated here so `domain.ts` has no dependency on that module. */
export interface CrossValidationConcept {
  conceptId: string;
  name: string;
  relevance: string;
  weight: number;
}

/** One series' move across the bars Sentinel read. See `contractWatch`. */
export interface ContractSeriesRead {
  bars: number;
  open: number;
  last: number;
  changePct: number;
  direction: 'rising' | 'falling' | 'flat';
}

/**
 * One option leg. `series: null` with a non-null `unavailableReason` is a leg
 * Sentinel could NOT read — never the same thing as a leg that read cleanly
 * and did not move, which is `direction: 'flat'`.
 */
export interface ContractLegRead {
  side: 'CE' | 'PE';
  strike: number;
  series: ContractSeriesRead | null;
  unavailableReason: string | null;
}

export interface ObserveResponse {
  /** the single synthesized, user-facing message (orchestrator only) — null when nothing warrants surfacing */
  synthesis: {
    content: string;
    pattern: string;
    confidence: number;
    disclaimer: string;
    /** non-directive status headline, e.g. 'Bullish side in focus' */
    status: string;
    state: MarketStateValue;
  } | null;
  /**
   * SentinelIntelligence's cached background verdict for this symbol, when one
   * exists — a second, independently-gated engine's corroboration, never a
   * second conclusion. Null when no recent background run exists for this
   * symbol (its watch coverage is deliberately sparse) or the run hasn't
   * cleared its own gates. Purely additive: `synthesis` above remains the only
   * user-facing answer.
   */
  crossValidation?: {
    /** Whether SentinelIntelligence's own three gates (confidence, corroboration, live-performance) cleared for this run. */
    surfaced: boolean;
    /** Whether its leading stance/pattern agrees with this response's own leading detection. */
    agreesWithConclusion: boolean;
    citations: KnowledgeCitation[];
    supportingConcepts: CrossValidationConcept[];
    /** Number of independent agents that agreed with the leading stance. */
    corroboratingAgents: number;
    /** Which of SentinelIntelligence's gates held, when `surfaced` is false. */
    silenceReason: string | null;
  } | null;
  /**
   * The four-condition publication gate's full record for this observation.
   *
   * Present whether or not anything was published: when `publish` is false,
   * `waitAndWatchReason` names the binding constraint and `conditions` shows
   * every check that ran. This is what makes Wait and Watch explainable
   * rather than merely silent.
   *
   * Structurally mirrors `PublicationDecision` in
   * `orchestrator/publication-gate.ts`, declared inline here for the same
   * reason `CrossValidationConcept` is — `domain.ts` must not depend on a
   * module that depends on it.
   */
  publication?: {
    publish: boolean;
    threshold: number;
    confidence: number;
    conditions: { id: string; label: string; passed: boolean; detail: string }[];
    corroboratingSources: string[];
    conflicts: string[];
    waitAndWatchReason: string | null;
  };
  /**
   * Phase 2 — what the market is *doing*, as opposed to what its indicators
   * read. Structure (higher highs / lower lows, breaks of structure and
   * changes of character), resting and swept liquidity, and a
   * continuation-vs-reversal read, each carrying its own evidence.
   *
   * Descriptive only: `read: 'reversal-risk'` names present structural
   * evidence, never a forecast — Master Plan principle 2 forbids predicting
   * where price will be.
   */
  marketBehaviour?: {
    regime: string | null;
    structure: {
      state: 'uptrend' | 'downtrend' | 'range' | 'undefined';
      event: 'break-of-structure' | 'change-of-character' | null;
      eventDirection: 'bullish' | 'bearish' | null;
      lastSwingHigh: number | null;
      lastSwingLow: number | null;
    };
    liquidity: {
      pools: { price: number; side: 'above' | 'below'; touches: number; swept: boolean }[];
      recentSweep: { side: 'above' | 'below'; price: number; reclaimed: boolean } | null;
    };
    behaviour: {
      read: 'continuation' | 'reversal-risk' | 'indecision' | 'undefined';
      direction: 'bullish' | 'bearish' | 'neutral';
      strength: number;
    };
    narrative: string;
    evidence: string[];
  };
  /**
   * What Sentinel read on THIS observation, per instrument — the underlying
   * and the two option legs at the at-the-money strike.
   *
   * Added 2026-08-16. The workspace has drawn three charts (index / CALL /
   * PUT) since 2026-08-05 while the engine snapshotted only the underlying,
   * so two of the three panels asserted an engine that was not running. This
   * field is what makes the panel checkable: it names the interval every
   * series was read on, carries each leg's own move, and reports a leg it
   * could not read as unreadable rather than omitting it.
   *
   * Read `intelligence/contract-alignment.ts` before adding to this. In
   * particular `alignment` is a small closed set and not a score: a number
   * invites ranking strikes, and ranking contracts by attractiveness is a
   * recommendation however it is phrased (Rule 2). Nothing here names an
   * action, a level to act at, or a preference between the two legs as things
   * to hold — the strongest statement available is which leg MOVED with the
   * underlying, in the past tense, over stated bars.
   *
   * Structurally mirrors `ContractAlignment`, declared inline for the same
   * reason `CrossValidationConcept` is — `domain.ts` must not depend on a
   * module that depends on it.
   */
  contractWatch?: {
    underlying: string;
    expiry: string | null;
    strike: number | null;
    /** The bars EVERY series below was read on. */
    interval: string;
    index: ContractSeriesRead | null;
    ce: ContractLegRead | null;
    pe: ContractLegRead | null;
    alignment:
      | 'call-side-tracking'
      | 'put-side-tracking'
      | 'both-sides-bid'
      | 'both-sides-decaying'
      | 'index-flat'
      | 'mixed'
      | null;
    notes: string[];
    /** False when the data provider cannot read contract series at all. */
    contractsReadable: boolean;
  };
  /**
   * Phase 3 — where each strategy sits in its own lifecycle.
   *
   * Distinct from `marketState`, which describes the SESSION. With several
   * strategies pinned at once they are rarely at the same stage, and one
   * global label has to describe all of them — so it describes none.
   */
  strategyLifecycles?: {
    strategyId: string;
    strategyName: string;
    state: string;
    label: string;
    bias: 'bullish' | 'bearish' | 'neutral';
    reason: string;
    evidence: string[];
    changed: boolean;
    enteredAt: string;
    history: { state: string; at: string; reason: string }[];
  }[];
  /**
   * Phase 5 — every element used in Sentinel's reasoning, as chart drawings:
   * swing structure, liquidity pools and sweeps, support/resistance, the
   * opening range, and each confirmed strategy's area and invalidation level.
   *
   * Shaped as `ChartAnnotation` from `sentinel-intelligence/types` so the
   * TradingView Charting Library binding has one contract to render. Typed
   * loosely here for the same reason `CrossValidationConcept` is duplicated —
   * `domain.ts` must not depend on a module that depends on it.
   *
   * Every entry carries `explanation`, `triggeredBy` and `confidence` by
   * construction: there is no code path that produces an unexplained drawing.
   */
  chartAnnotations?: {
    id: string;
    kind: string;
    label: string;
    points: { time: number; price: number }[];
    band: { top: number; bottom: number } | null;
    pane: string;
    style: { color: string; width: number; dash: string; opacity: number };
    explanation: string;
    triggeredBy: { ruleId: string; ruleName: string; origin: string; conditionMet: string };
    confidence: number;
  }[];
  /**
   * Phase 6 — whether the independent evidence dimensions agree.
   *
   * Distinct from `crossValidation`, which asks whether the second reasoning
   * ENGINE agrees. This asks whether technicals, structure, option
   * positioning, historical outcomes and the news environment agree with each
   * other — the question an institutional desk actually asks.
   *
   * A dimension with no data ABSTAINS rather than voting neutral, so
   * `abstaining` shows how much of the picture is dark. Purely informational:
   * `publication` remains the only authority on what surfaces.
   */
  institutionalCrossValidation?: {
    dimensions: {
      id: string;
      label: string;
      stance: 'bullish' | 'bearish' | 'neutral' | 'abstain';
      strength: number;
      evidence: string;
    }[];
    consensus: 'bullish' | 'bearish' | 'neutral' | null;
    voting: number;
    agreeing: number;
    dissenting: string[];
    abstaining: string[];
    agreementScore: number;
    summary: string;
  };
  /** individual agent observations (Observation Feed / Agent Activity Timeline) */
  observations: SentinelObservationOut[];
  /** every computed signal, triggered or not (Agent Activity Timeline transparency) */
  signals: Signal[];
  /** Market Context Engine's narrative for the active symbol — absent if the Brain is unavailable */
  marketContext?: string;
  /** Module 1 — today's regime classification */
  marketProfile: MarketProfile | null;
  /** Module 2 — strategies whose rules currently confirm */
  strategyMatches: StrategyMatch[];
  /** Module 6 — the 8-factor risk read */
  risk: RiskAssessment;
  /** Module 7 — the transparent confidence percentage */
  confidence: ConfidenceBreakdown;
  /** Module 9 — where Sentinel currently is */
  marketState: MarketStateSnapshot;
  /** Module 8 — the running session narrative */
  timeline: TimelineEntry[];
  /** §5 — the "Why?" inspector payload for the current reading */
  explanation: ConfidenceExplainResult;
  /**
   * The validated events this observation produced, for delivery channels
   * (in-app notification, email, push) — derived by
   * `events/sentinel-event.ts`.
   *
   * Structurally distinct from every other field here: the rest of this
   * response describes the market *to the workspace*, where the evidence sits
   * beside the read. An event travels alone, so it carries no direction by
   * construction and never will. A dispatcher must consume THIS and nothing
   * else from this response.
   *
   * Usually empty — most polls of a session produce no event at all, which is
   * the intended resting state.
   */
  events?: SentinelEvent[];
  /**
   * Phase 3 — auto/manual strategy focus read for this observation. In
   * manual mode with multiple strategies pinned, this mirrors the first
   * entry of `strategyAdvices` — kept for existing single-strategy callers.
   */
  strategyAdvice?: StrategyAdvice;
  /**
   * Phase 2 (multi-strategy) — one advice entry per pinned strategy in
   * manual mode, or a single-entry array in auto mode. Always present
   * alongside `strategyAdvice`.
   */
  strategyAdvices?: StrategyAdvice[];
  /** Phase 3 — favoured side, surfaced only above the confidence threshold (null otherwise) */
  sideInFocus?: SideInFocus | null;
  /**
   * `AgentRun.runId` for this observation.
   *
   * Already generated by `runAgentRun` and already the correlation key every
   * nested agent and LLM call is logged against — it simply was not returned,
   * so a caller holding a response had no way to name the run that produced it.
   * Exposing it is what lets the paper-execution loop record which Sentinel run
   * a paper order came from as an ID rather than a timestamp guess.
   */
  runId?: string;
  /**
   * The front-expiry option chain this observation was built on — present only
   * when `ObserveRequest.includeOptionChain` was set. See that field.
   *
   * Raw exchange facts (strike, OI, volume, IV, last traded premium), in chain
   * order. Nothing here ranks or prefers a contract; that judgement lives in
   * `execution/strike-candidates.ts`, which is deliberately not on this
   * contract. `expiry` is ISO so the shape survives JSON transit intact.
   */
  optionChain?: {
    frontExpiry: string;
    entries: {
      strike: number;
      callOI: number;
      putOI: number;
      callVolume: number;
      putVolume: number;
      callIV?: number;
      putIV?: number;
      callLtp?: number;
      putLtp?: number;
    }[];
  } | null;
}

export const SENTINEL_DISCLAIMER =
  'Sentinel shares observations and educational context only. It is not investment advice and never recommends trades.';
