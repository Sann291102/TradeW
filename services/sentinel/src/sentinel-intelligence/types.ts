/**
 * SentinelIntelligence — shared contracts.
 *
 * This module is ADDITIVE. It does not modify, wrap, or replace
 * `orchestrator/sentinel-orchestrator.service.ts`; that service keeps its own
 * `/observe` contract (`../domain.ts`) and remains the production observation
 * path. SentinelIntelligence is a second, independent reasoning engine that
 * *composes* the same deterministic engines read-only and adds what the
 * orchestrator deliberately does not have:
 *
 *  1. a request-understanding layer (market / strike / expiry / timeframe /
 *     strategy / indicators / style / risk profile),
 *  2. explicit task decomposition onto ten named specialist agents,
 *  3. knowledge-grounded verdicts where every claim carries a citation back
 *     into the learned corpus,
 *  4. cross-checking and conflict resolution across agents, and
 *  5. an auditable annotation/drawing layer for the visual workspace.
 *
 * Every type here is either an input to that pipeline or a piece of its audit
 * trail. Nothing in this file carries a directive field — no entry, no exit,
 * no target-as-instruction. `ProjectedLevel` exists because a *drawing* has to
 * be placed somewhere on a chart, and it is explicitly labelled as geometry
 * derived from a rule, not as an instruction to act.
 */

import type { Candle } from '@tradew/types';

// ---------------------------------------------------------------------------
// 1. Knowledge citations — the spine of the whole module
// ---------------------------------------------------------------------------

/**
 * Where a piece of learned knowledge physically lives.
 *
 * A citation must be resolvable back to a byte range in a real file, because
 * the alternative — an agent asserting "the books say X" with no way to check
 * — is exactly the failure mode this module exists to prevent. `locator` is
 * human-readable ("§3.2 Liquidity Sweeps", "p. 148"); `charStart`/`charEnd`
 * are the machine-checkable coordinates into the parsed text.
 */
export interface KnowledgeCitation {
  /** Stable id of the cited chunk: `<source-checksum>:<chunk-index>`. */
  chunkId: string;
  /** Stable id of the source document (its content checksum). */
  sourceId: string;
  /** Human-readable document title. */
  sourceTitle: string;
  /** Repo-relative path, e.g. `docs/Trading Books/Trading in the Zone.pdf`. */
  sourcePath: string;
  /** Which corpus this came from — books rank above generated notes. */
  sourceKind: KnowledgeSourceKind;
  /** Human-readable position: section heading, or `p. N`, or `chunk N`. */
  locator: string;
  /** Character offsets into the parsed document text. */
  charStart: number;
  charEnd: number;
  /** Verbatim supporting fragment, trimmed. Never paraphrased. */
  quote: string;
  /** 0..1 — how strongly this chunk matched the query that retrieved it. */
  relevance: number;
}

/**
 * Corpus tiers, ordered by how much authority a citation from each carries.
 *
 * `book` is a published trading text; `user-rule` is something the trader
 * taught the system directly (a TradingView strategy spec), which outranks a
 * book for *that trader* because it is their own stated method; `vault` is the
 * repo's engineering knowledge; `generated` is anything Sentinel wrote itself
 * and is deliberately ranked last so the system cannot bootstrap confidence
 * out of its own prior output.
 */
export type KnowledgeSourceKind = 'user-rule' | 'book' | 'knowledge-base' | 'vault' | 'doc' | 'generated';

/** Authority multiplier applied to a citation's relevance during ranking. */
export const SOURCE_AUTHORITY: Record<KnowledgeSourceKind, number> = {
  'user-rule': 1.0,
  book: 0.95,
  'knowledge-base': 0.9,
  vault: 0.7,
  doc: 0.65,
  generated: 0.4,
};

// ---------------------------------------------------------------------------
// 2. Request understanding
// ---------------------------------------------------------------------------

export type TradingStyle = 'scalping' | 'intraday' | 'swing' | 'positional' | 'unspecified';
export type RiskProfile = 'conservative' | 'balanced' | 'aggressive' | 'unspecified';
export type OptionRight = 'CE' | 'PE';
export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '1d';

/** An instrument the request is about, resolved to something tradeable. */
export interface ResolvedMarket {
  /** Canonical underlying symbol, e.g. `NIFTY`, `BANKNIFTY`, `RELIANCE`. */
  symbol: string;
  /** Display name. */
  name: string;
  kind: 'index' | 'stock' | 'commodity' | 'currency' | 'unknown';
  /** True when the symbol has a listed option chain. */
  hasOptionChain: boolean;
  /** Strike interval used to snap an ATM strike, when known. */
  strikeStep: number | null;
}

/**
 * Everything SentinelIntelligence understood about a request.
 *
 * Every field is nullable and carries a matching entry in `assumptions` when
 * it was inferred rather than stated. An agent that needs a field it did not
 * get must abstain rather than invent one — see `AgentVerdict.abstained`.
 */
export interface UnderstoodRequest {
  /** Original free-text question, verbatim. */
  rawText: string;
  market: ResolvedMarket;
  /** Explicit strike if the user named one, else null. */
  strike: number | null;
  /** CE/PE if the user named a side, else null. */
  right: OptionRight | null;
  /** Expiry the user named, resolved to a date, else null. */
  expiry: Date | null;
  /** How the expiry was expressed, e.g. `weekly`, `monthly`, `31 Aug`. */
  expiryPhrase: string | null;
  timeframe: Timeframe;
  /** Strategy ids the user named, matched against the learned corpus. */
  strategyIds: string[];
  /** Indicators the user named, normalised (`ema`, `vwap`, `rsi`, …). */
  indicators: string[];
  style: TradingStyle;
  riskProfile: RiskProfile;
  /** What the user actually wants done. */
  intent: RequestIntent;
  /** Fields that were inferred, each with the reason. */
  assumptions: Assumption[];
  /** 0..1 — how much of the request was understood without guessing. */
  parseConfidence: number;
}

export type RequestIntent =
  | 'market-read' // "what is NIFTY doing"
  | 'strategy-check' // "does my ORB setup confirm"
  | 'option-context' // "what's happening at 24500 CE"
  | 'risk-review' // "how risky is this right now"
  | 'behaviour-review' // "am I revenge trading"
  | 'visual-workspace' // "draw the chart"
  | 'explain' // "why did you say that"
  | 'unknown';

export interface Assumption {
  field: keyof UnderstoodRequest | string;
  value: string;
  /** Why this default was chosen — surfaced verbatim in the audit trail. */
  reason: string;
}

// ---------------------------------------------------------------------------
// 3. Task decomposition
// ---------------------------------------------------------------------------

export type AgentId =
  | 'market-intelligence'
  | 'strategy-intelligence'
  | 'news-intelligence'
  | 'options-chain-intelligence'
  | 'risk-intelligence'
  | 'emotion-intelligence'
  | 'trap-intelligence'
  | 'historical-pattern-intelligence'
  | 'compliance-intelligence'
  | 'learning-intelligence';

export const ALL_AGENT_IDS: AgentId[] = [
  'market-intelligence',
  'strategy-intelligence',
  'news-intelligence',
  'options-chain-intelligence',
  'risk-intelligence',
  'emotion-intelligence',
  'trap-intelligence',
  'historical-pattern-intelligence',
  'compliance-intelligence',
  'learning-intelligence',
];

/** One unit of work assigned to exactly one agent. */
export interface Subtask {
  id: string;
  agent: AgentId;
  /** The specific question this agent must answer. */
  question: string;
  /** Why the decomposer routed this here — part of the audit trail. */
  rationale: string;
  /** Retrieval hints seeded from the understood request. */
  knowledgeQueries: string[];
  /** Subtask ids whose verdicts this one wants available first. */
  dependsOn: string[];
  /** Relative importance when weighting this agent's verdict, 0..1. */
  weight: number;
}

export interface DecompositionPlan {
  subtasks: Subtask[];
  /** Agents deliberately not invoked, with the reason. */
  skipped: { agent: AgentId; reason: string }[];
}

// ---------------------------------------------------------------------------
// 4. Agent verdicts
// ---------------------------------------------------------------------------

/**
 * The directional axis every agent reports on, so cross-checking can compare
 * verdicts that were produced from completely different data.
 *
 * `risk-elevated` is deliberately NOT a direction — an agent saying "this is
 * dangerous" is not disagreeing with an agent saying "structure is bullish",
 * and collapsing the two onto one axis would manufacture a conflict that does
 * not exist.
 */
export type Stance = 'bullish' | 'bearish' | 'neutral' | 'risk-elevated' | 'no-read';

/** One checkable claim. Every claim that leans on the corpus must cite it. */
export interface EvidenceItem {
  /** The claim, phrased observationally. */
  statement: string;
  /**
   * `measured` came from live data, `derived` from computation over it,
   * `knowledge` from the learned corpus. A `knowledge` item with no citation
   * is rejected by the validator.
   */
  kind: 'measured' | 'derived' | 'knowledge';
  /** Structured backing value, when there is one. */
  value?: number | string | boolean | null;
  citations: KnowledgeCitation[];
  /** 0..1 — how much this individual item supports the verdict. */
  strength: number;
}

/** A concept from the knowledge graph that underpins the verdict. */
export interface SupportingConcept {
  conceptId: string;
  name: string;
  /** How this concept relates to the verdict, in one line. */
  relevance: string;
  /** 0..1 — graph-derived maturity/importance of the concept. */
  weight: number;
  citations: KnowledgeCitation[];
}

export interface AgentVerdict {
  agent: AgentId;
  subtaskId: string;
  stance: Stance;
  /** 0..1 — the agent's own confidence in its verdict. */
  confidence: number;
  /** One-line observational summary. Never directive. */
  headline: string;
  evidence: EvidenceItem[];
  supportingConcepts: SupportingConcept[];
  /** Flattened, deduped citations across all evidence — for quick display. */
  citations: KnowledgeCitation[];
  /**
   * True when the agent could not answer — missing data, missing knowledge,
   * or a question outside its remit. An abstention is a first-class result and
   * never counts toward corroboration.
   */
  abstained: boolean;
  abstentionReason: string | null;
  /** 0..1 — how complete the inputs were. Scales the verdict's weight. */
  dataQuality: number;
  /** Milliseconds the agent took. */
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// 5. Cross-checking, conflicts, synthesis
// ---------------------------------------------------------------------------

/** A verdict rejected by the validator, with the rule it broke. */
export interface ValidationFailure {
  agent: AgentId;
  subtaskId: string;
  rule: string;
  detail: string;
}

export type ConflictKind =
  | 'directional' // one agent bullish, another bearish
  | 'confidence-outlier' // one agent far more confident than corroborators
  | 'evidence-contradiction' // two agents cite incompatible measured values
  | 'knowledge-contradiction'; // two citations from the corpus disagree

export interface Conflict {
  kind: ConflictKind;
  between: AgentId[];
  detail: string;
  /** How it was settled, and why. Always recorded, even when unresolved. */
  resolution: string;
  /** Agent whose verdict survived, or null when the conflict forced neutrality. */
  favoured: AgentId | null;
  /** Confidence penalty applied to the synthesis, in points of the 0..1 scale. */
  penalty: number;
}

/** Contribution of one agent to the final confidence figure. */
export interface CorroborationEntry {
  agent: AgentId;
  stance: Stance;
  confidence: number;
  /** subtask weight × dataQuality × knowledge grounding. */
  effectiveWeight: number;
  /** How many distinct sources this agent's verdict cited. */
  distinctSources: number;
}

/**
 * The synthesized result.
 *
 * `surfaced` is the whole point: SentinelIntelligence is silent unless the
 * confidence gate AND the corroboration gate both clear. When `surfaced` is
 * false, `observation` is null and the caller has nothing to show — that is a
 * designed outcome, not an error, and `silenceReason` says which gate held.
 */
export interface SynthesisResult {
  surfaced: boolean;
  /** Null whenever `surfaced` is false. */
  observation: SurfacedObservation | null;
  /** Which gate held the observation back. Null when surfaced. */
  silenceReason: string | null;
  /** 0..1 aggregate across corroborating agents, after conflict penalties. */
  confidence: number;
  /** The gate this run was judged against (default 0.70). */
  threshold: number;
  /** Number of non-abstaining agents that agreed with the leading stance. */
  corroboratingAgents: number;
  /** Minimum agreeing agents required to surface (default 2). */
  requiredCorroboration: number;
  leadingStance: Stance;
  corroboration: CorroborationEntry[];
  conflicts: Conflict[];
  validationFailures: ValidationFailure[];
}

export interface SurfacedObservation {
  /** Non-directive status headline, drawn from the allowed vocabulary. */
  status: string;
  /** The observation itself — one calm paragraph. */
  content: string;
  /** 0..1. */
  confidence: number;
  /** Named pattern/regime this observation is about. */
  pattern: string;
  /** Every citation behind the observation, deduped and ranked. */
  citations: KnowledgeCitation[];
  supportingConcepts: SupportingConcept[];
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// 6. The full reasoning run — the auditable record
// ---------------------------------------------------------------------------

export interface ReasoningRun {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  understood: UnderstoodRequest;
  plan: DecompositionPlan;
  verdicts: AgentVerdict[];
  synthesis: SynthesisResult;
  /** Corpus state this run reasoned against — makes a run reproducible. */
  corpus: { documents: number; chunks: number; concepts: number; indexedAt: string | null };
}

export interface ReasonRequest {
  /** Free-text question. Optional when the structured fields carry the request. */
  query?: string;
  userId: string;
  /** Structured overrides — these win over anything parsed from `query`. */
  symbol?: string;
  strike?: number;
  right?: OptionRight;
  expiry?: string;
  timeframe?: Timeframe;
  strategyIds?: string[];
  indicators?: string[];
  style?: TradingStyle;
  riskProfile?: RiskProfile;
  /** Recent trades, for the emotion and risk agents. Read-only, never stored. */
  recentTrades?: TradeLike[];
  account?: { marginUsed?: number; marginAvailable?: number; totalCapital?: number };
  /** Override the 0..1 confidence gate for this run. */
  confidenceThreshold?: number;
  /** Override the minimum number of corroborating agents. */
  requiredCorroboration?: number;
}

/** Structurally compatible with the orchestrator's `TradeSummary`. */
export interface TradeLike {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  fillPrice: number;
  realizedPnl?: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 7. Visual layer — annotations and drawings
// ---------------------------------------------------------------------------

export type AnnotationKind =
  | 'trendline'
  | 'support'
  | 'resistance'
  | 'supply-zone'
  | 'demand-zone'
  | 'liquidity-pool'
  | 'fair-value-gap'
  | 'order-block'
  | 'fibonacci'
  | 'ema'
  | 'vwap'
  | 'rsi'
  | 'macd'
  | 'cpr'
  | 'opening-range'
  | 'projected-entry'
  | 'projected-invalidation'
  | 'projected-objective'
  | 'marker';

/** A point in chart space. `time` is epoch ms so the client needs no parsing. */
export interface ChartPoint {
  time: number;
  price: number;
}

/**
 * A price level the geometry engine projected from a rule.
 *
 * Deliberately named `ProjectedLevel`, not `Entry`/`StopLoss`/`Target`: it is
 * where a *drawing* goes, derived from the learned rule named in `derivedFrom`.
 * The vocabulary enforcer rewrites any directive phrasing in `explanation`
 * before it reaches a trader.
 */
export interface ProjectedLevel {
  price: number;
  /** Which projection this is — geometry role, not an instruction. */
  role: 'entry-zone' | 'invalidation' | 'objective';
  /** Rule id from the learned corpus that placed it. */
  derivedFrom: string;
  /** Multiple of the invalidation distance, for objectives. */
  rMultiple: number | null;
}

/**
 * One drawing on the chart, with its full justification.
 *
 * Every annotation is auditable by construction: it cannot be built without
 * `explanation`, `triggeredBy` and `confidence`, and `citations` ties the rule
 * that placed it back to the corpus it was learned from.
 */
export interface ChartAnnotation {
  id: string;
  kind: AnnotationKind;
  /** Short display label, e.g. `EMA 20`, `Demand 24 310–24 348`. */
  label: string;
  /** Geometry. A line has 2+ points; a zone has 2; a series has many. */
  points: ChartPoint[];
  /** Upper/lower bounds for zone-type annotations. */
  band: { top: number; bottom: number } | null;
  /** Which sub-chart this belongs to — RSI/MACD render in their own pane. */
  pane: 'price' | 'rsi' | 'macd' | 'volume';
  style: AnnotationStyle;
  /** WHY this was drawn, in plain language. Required. */
  explanation: string;
  /** WHICH learned rule triggered it. Required. */
  triggeredBy: TriggeringRule;
  /** 0..1 confidence in this specific annotation. Required. */
  confidence: number;
  /** Citations for the rule that placed it. */
  citations: KnowledgeCitation[];
  /** Projected levels attached to this annotation, when it implies any. */
  levels: ProjectedLevel[];
}

export interface AnnotationStyle {
  color: string;
  /** 1–4 px. */
  width: number;
  dash: 'solid' | 'dashed' | 'dotted';
  /** 0..1 for zone fills. */
  opacity: number;
}

export interface TriggeringRule {
  /** Rule id, e.g. `orb_breakout`, `user:my-tv-strategy#3`. */
  ruleId: string;
  /** Human-readable rule name. */
  ruleName: string;
  /** Where the rule came from. */
  origin: 'builtin' | 'user-tradingview' | 'learned-corpus';
  /** The rule's condition, restated with the live numbers that satisfied it. */
  conditionMet: string;
}

/** The full three-panel payload for the visual strategy workspace. */
export interface WorkspaceView {
  runId: string;
  symbol: string;
  timeframe: Timeframe;
  /** Panel 1 — the price series the annotations are anchored to. */
  candles: SerializedCandle[];
  /** Panel 2 — option-chain context around the selected strike. */
  optionContext: OptionContextPanel | null;
  /** Panel 3 — the AI strategy visualization. */
  annotations: ChartAnnotation[];
  /** The reasoning run that produced the annotations. */
  reasoning: ReasoningRun;
  /** Indicator panes present in `annotations`, so the client can lay out. */
  panes: ('price' | 'rsi' | 'macd' | 'volume')[];
}

/** `Candle` with the Date flattened to epoch ms for JSON transport. */
export interface SerializedCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest?: number;
}

export function serializeCandle(c: Candle): SerializedCandle {
  return {
    time: c.timestamp.getTime(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    ...(c.openInterest !== undefined ? { openInterest: c.openInterest } : {}),
  };
}

export interface OptionContextPanel {
  underlying: string;
  spot: number;
  /** The strike in focus — user-selected, or the ATM strike. */
  selectedStrike: number | null;
  selectedRight: OptionRight | null;
  /** Whether the strike was chosen by the user or snapped to ATM. */
  strikeSource: 'user' | 'atm-snap' | 'none';
  expiry: string | null;
  rows: OptionContextRow[];
  /** PCR / max pain / OI walls for the front expiry. */
  summary: {
    pcr: number;
    maxPain: number;
    callOIWall: number | null;
    putOIWall: number | null;
    strikesAnalysed: number;
  } | null;
}

export interface OptionContextRow {
  strike: number;
  callOI: number;
  putOI: number;
  callVolume: number;
  putVolume: number;
  callLtp: number | null;
  putLtp: number | null;
  callIV: number | null;
  putIV: number | null;
  /** True for the row in focus. */
  selected: boolean;
  /** Distance from spot in strike steps — drives the ATM highlight. */
  stepsFromSpot: number;
}

export const SI_DISCLAIMER =
  'SentinelIntelligence produces observations and educational context grounded in its learned knowledge base. ' +
  'It is not investment advice, it never recommends trades, and it never places orders.';
