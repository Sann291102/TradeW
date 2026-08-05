/**
 * Sentinel internal domain — signals, observations, and the observe contract.
 *
 * Single source of truth for every type that crosses a module boundary or
 * appears on the wire (services/api proxies this JSON straight through to
 * apps/web). Engine-internal shapes stay inside their engine; anything the
 * orchestrator returns lives here.
 */

/** Which intelligence engine produced a signal. */
export type SignalAgent =
  | 'market-technical'
  | 'emotion'
  | 'trap-safety'
  | 'strategy'
  | 'risk';

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

/**
 * Which side the corroborated evidence favours, surfaced only above the
 * confidence threshold. `side` is CE or PE for the educational option lens;
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
  detectedAt: string; // ISO
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
}

/** Mirrors `SupportingConcept` from sentinel-intelligence/types — duplicated here so `domain.ts` has no dependency on that module. */
export interface CrossValidationConcept {
  conceptId: string;
  name: string;
  relevance: string;
  weight: number;
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
}

export const SENTINEL_DISCLAIMER =
  'Sentinel shares observations and educational context only. It is not investment advice and never recommends trades.';
