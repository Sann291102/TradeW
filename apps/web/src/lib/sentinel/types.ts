/**
 * Shared Sentinel types + constants — the raw `ObserveResponse` shape both
 * the full `/sentinel` page and the locked dock-panel teaser
 * (`terminal/panels/SentinelPanel.tsx`) build on, so the two surfaces never
 * drift on the observation-only disclaimer. See
 * docs/product-architecture/SENTINEL.md §5 (pending a rewrite — see
 * archive/README.md's 2026-07-21 entry).
 *
 * `AGENT_LABEL`/`AGENT_COLOR` below are kept for potential future
 * developer-mode tooling but are deliberately NOT used by the redesigned
 * production UI (`lib/sentinel/deriveContext.ts`'s `SOURCE_LABEL` replaces
 * them there with neutral, non-implementation-revealing labels).
 */

export type Synthesis = {
  content: string;
  pattern: string;
  confidence: number;
  disclaimer: string;
  /** non-directive headline, e.g. "Bullish side in focus" (Master Plan Module 10) */
  status?: string;
  state?: MarketStateValue;
};
export type Observation = {
  agent: string;
  category: string;
  pattern?: string | null;
  symbol?: string | null;
  content: string;
  evidence: string[];
  confidence: number;
  createdAt?: string;
  surfaced?: boolean;
};
export type Signal = { name: string; agent: string; triggered: boolean; weight: number; evidence: string[] };

// ---------------------------------------------------------------------------
// Sentinel Master Plan modules. Mirrors services/sentinel/src/domain.ts, which
// services/api proxies through verbatim. Every field is optional here: the
// offline/demo fixture below and any older cached response must still satisfy
// the type, and each panel already has a signal-derived fallback path.

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

export type MarketProfile = {
  type: MarketProfileType;
  description: string;
  trend: 'bullish' | 'bearish' | 'neutral' | 'choppy';
  volatility: 'high' | 'low' | 'normal';
  structure: 'trending' | 'ranging' | 'consolidating' | 'breaking-out';
  evidence: string[];
};

export type StrategyMatch = {
  strategyId: string;
  strategyName: string;
  confidence: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  rulesMatched: string[];
  rulesUnmet: string[];
  invalidationsTriggered: string[];
  detectedAt: string;
};

export type RiskFactor = { name: string; score: number; weight: number; evidence: string[] };
export type RiskAssessment = {
  overallRisk: number;
  level: 'very_low' | 'low' | 'moderate' | 'high' | 'extreme';
  factors: RiskFactor[];
  assessedAt: string;
};

export type ConfidenceFactor = { name: string; label: string; score: number; weight: number; evidence: string[] };
export type ConfidenceBreakdown = {
  score: number;
  weightedScore: number;
  threshold: number;
  meetsThreshold: boolean;
  factors: ConfidenceFactor[];
  deductions: { reason: string; points: number }[];
  computedAt: string;
};

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

export type MarketStateSnapshot = {
  current: MarketStateValue;
  previous: MarketStateValue | null;
  since: string;
  sessionPhase: 'pre-market' | 'active' | 'closing' | 'closed';
  history: { from: MarketStateValue; to: MarketStateValue; at: string; trigger: string }[];
};

export type TimelineLevel = 'info' | 'observation' | 'setup' | 'guidance' | 'transition';
export type TimelineEntry = {
  at: string;
  /** HH:mm IST, precomputed server-side so every surface renders it identically */
  time: string;
  event: string;
  level: TimelineLevel;
  confidence?: number;
  state?: MarketStateValue;
};

/** The "Why?" inspector payload (Master Plan §5). */
export type ConfidenceExplanation = {
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
  learningReferences: string[];
  /** SentinelIntelligence's book/document corpus — verbatim, citable quotes backing the active setup */
  bookCitations: KnowledgeCitation[];
  factorScores: Record<string, number>;
};

export type KnowledgeCitation = {
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
};

// ------------------------------------------------------ Phase 3 strategy focus

export type MarketSuitability = 'high' | 'moderate' | 'low' | 'unknown';

export type StrategyValidation = {
  regimeCompatible: boolean;
  volatilityOk: boolean;
  liquidityOk: boolean;
  requiredConfirmations: string[];
  missingConfirmations: string[];
  passed: boolean;
};

export type StrategyAdvice = {
  mode: 'auto' | 'manual';
  requestedStrategyId: string | null;
  activeStrategyId: string | null;
  activeStrategyName: string | null;
  aiSelected: boolean;
  confidence: number;
  meetsThreshold: boolean;
  marketSuitability: MarketSuitability;
  status: string;
  message: string;
  validation?: StrategyValidation;
};

export type TradeManagementGuidance = {
  riskReward: string;
  trailing: string[];
  note: string;
};

export type SideInFocus = {
  side: 'CE' | 'PE';
  bias: 'bullish' | 'bearish';
  strike: number | null;
  confidence: number;
  rationale: string[];
  tradeManagement: TradeManagementGuidance;
  disclaimer: string;
};

/** One entry from the educational strategy registry (GET /sentinel/strategies/registry). */
export type RegistryStrategy = {
  id: string;
  name: string;
  detectionStrategyId: string | null;
  exposed: boolean;
  order: number;
  purpose: string;
  marketConditions: string[];
  timeframes: string[];
  requiredIndicators: string[];
  riskConsiderations: string[];
  confidenceFactors: string[];
  whenNotToUse: string[];
  educational: string;
  regimes: string[];
};

/** Strategy focus the UI drives observe with. */
export type StrategyMode = 'auto' | 'manual';

export type ObserveResponse = {
  synthesis: Synthesis | null;
  observations: Observation[];
  signals: Signal[];
  marketContext?: string;
  marketProfile?: MarketProfile | null;
  strategyMatches?: StrategyMatch[];
  risk?: RiskAssessment;
  confidence?: ConfidenceBreakdown;
  marketState?: MarketStateSnapshot;
  timeline?: TimelineEntry[];
  explanation?: ConfidenceExplanation;
  /** Mirrors the first entry of `strategyAdvices` — kept for single-strategy callers. */
  strategyAdvice?: StrategyAdvice;
  /** Phase 2 (multi-strategy) — one entry per pinned strategy in manual mode, or a single auto-mode entry. */
  strategyAdvices?: StrategyAdvice[];
  sideInFocus?: SideInFocus | null;
  /**
   * The four-condition publication gate's record for this observation.
   * Present whether or not anything was published — when `publish` is false,
   * `waitAndWatchReason` names the binding constraint and `conditions` shows
   * every check that ran, which is what makes Wait and Watch explainable
   * rather than merely silent.
   */
  publication?: PublicationDecision;
  /** Phase 2 — what the market is doing, as opposed to what its indicators read. */
  marketBehaviour?: MarketBehaviourRead;
  /** Phase 3 — where each strategy sits in its own lifecycle. */
  strategyLifecycles?: StrategyLifecycle[];
  /** Phase 5 — every element used in the reasoning, as chart drawings. */
  chartAnnotations?: ChartAnnotation[];
  /** Phase 6 — whether the independent evidence dimensions agree. */
  institutionalCrossValidation?: InstitutionalCrossValidation;
};

/** Mirrors services/sentinel `MarketBehaviourRead`. */
export type MarketBehaviourRead = {
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

/** Mirrors services/sentinel `LifecycleStatus`. */
export type StrategyLifecycle = {
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
};

/** Mirrors services/sentinel `ChartAnnotation`. */
export type ChartAnnotation = {
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
};

/** Mirrors services/sentinel `InstitutionalCrossValidation`. */
export type InstitutionalCrossValidation = {
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

/** Mirrors `PublicationDecision` in services/sentinel/src/orchestrator/publication-gate.ts. */
export type PublicationCondition = {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type PublicationDecision = {
  publish: boolean;
  threshold: number;
  confidence: number;
  conditions: PublicationCondition[];
  corroboratingSources: string[];
  conflicts: string[];
  waitAndWatchReason: string | null;
};
export type SessionSummaryData = { tradesToday: number; flaggedEvents: number; realizedPnl: number };
export type JournalEntry = { id: string; mood?: string | null; content: string; flaggedByAi: boolean; createdAt: string };

export const AGENT_LABEL: Record<string, string> = {
  'market-technical': 'Market & Technical',
  emotion: 'Emotion Intelligence',
  'trap-safety': 'Trap & Safety',
  orchestrator: 'Sentinel Orchestrator',
  'compliance-audit': 'Compliance & Audit',
};

export const AGENT_COLOR: Record<string, string> = {
  'market-technical': '#14b8a6',
  emotion: '#f0a53c',
  'trap-safety': '#ef5350',
  orchestrator: '#8ea0c4',
};

/** The observation-only guardrail language — reused verbatim by the full
 *  page and the locked panel teaser (never a buy/sell instruction). */
export const OBSERVATION_ONLY_DISCLAIMER =
  'Sentinel observes market structure and your behavior in parallel — never a buy/sell instruction.';

export const pretty = (s?: string | null): string => (s ?? '').replace(/_/g, ' ');

export const DEMO: ObserveResponse = {
  synthesis: {
    content:
      'India VIX at 18.8 — elevated. 3 entries within 15 minutes of a losing exit in this session. Position sizing on the last trade was 2.3x your session average. Longest losing streak this session: 3 trades. Together these resemble a revenge trading pattern on NIFTY. This is an observation, not advice — consider waiting for confirmation before acting.',
    pattern: 'revenge_trading',
    confidence: 0.925,
    disclaimer:
      'Sentinel shares observations and educational context only. It is not investment advice and never recommends trades.',
  },
  observations: [
    { agent: 'market-technical', category: 'market_structure_observation', pattern: 'elevated_vix', symbol: 'NIFTY', content: 'India VIX at 18.8 — elevated', evidence: ['India VIX at 18.8 — elevated'], confidence: 0.7, createdAt: '2026-07-21T09:15:00+05:30' },
    { agent: 'emotion', category: 'behavioral_pattern_observation', pattern: 'revenge_trading', symbol: 'NIFTY', content: '3 entries within 15 minutes of a losing exit in this session', evidence: ['3 entries within 15 min of a losing exit'], confidence: 0.75, createdAt: '2026-07-21T09:27:00+05:30' },
    { agent: 'emotion', category: 'behavioral_pattern_observation', pattern: 'position_sizing_drift', symbol: 'NIFTY', content: 'Position sizing on the last trade was 2.3x your session average', evidence: ['Last trade 2.3x session average'], confidence: 0.7, createdAt: '2026-07-21T09:42:00+05:30' },
    { agent: 'emotion', category: 'behavioral_pattern_observation', pattern: 'loss_streak', symbol: 'NIFTY', content: 'Longest losing streak this session: 3 trades', evidence: ['3 consecutive losing trades'], confidence: 0.7, createdAt: '2026-07-21T10:08:00+05:30' },
  ],
  signals: [
    { name: 'elevated_vix', agent: 'market-technical', triggered: true, weight: 0.3, evidence: ['India VIX at 18.8'] },
    { name: 'revenge_trading', agent: 'emotion', triggered: true, weight: 0.35, evidence: ['3 entries within 15 min of a losing exit'] },
    { name: 'position_sizing_drift', agent: 'emotion', triggered: true, weight: 0.3, evidence: ['Last trade 2.3x session average'] },
    { name: 'loss_streak', agent: 'emotion', triggered: true, weight: 0.3, evidence: ['3 consecutive losing trades'] },
    { name: 'low_volume_breakout', agent: 'trap-safety', triggered: false, weight: 0.4, evidence: ['No breakout without participation'] },
    { name: 'bull_trap', agent: 'trap-safety', triggered: false, weight: 0.45, evidence: ['No failed breakout above resistance'] },
    { name: 'overbought_rsi', agent: 'market-technical', triggered: false, weight: 0.2, evidence: ['RSI(14) is 50.1'] },
    { name: 'weak_breadth', agent: 'market-technical', triggered: false, weight: 0.15, evidence: ['Advance/decline ratio 1.04'] },
  ],
};

export const DEMO_SUMMARY: SessionSummaryData = { tradesToday: 7, flaggedEvents: 1, realizedPnl: -10875 };
export const DEMO_JOURNAL: JournalEntry[] = [
  { id: 'demo-j1', mood: 'frustrated', content: 'Kept re-entering after stops. Sentinel flagged my pacing — taking a break.', flaggedByAi: true, createdAt: new Date().toISOString() },
];
