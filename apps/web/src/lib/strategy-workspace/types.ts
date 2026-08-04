/**
 * Client-side mirror of the SentinelIntelligence workspace payload.
 *
 * Hand-maintained rather than generated: `packages/types` is the source of
 * truth for API contracts the whole platform shares, and this shape belongs to
 * one workspace. Keep it in step with
 * `services/sentinel/src/sentinel-intelligence/types.ts` — the fields below are
 * a strict subset of what the service returns, so an addition there is
 * backward-compatible here.
 */

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

export type Pane = 'price' | 'rsi' | 'macd' | 'volume';

export interface SerializedCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest?: number;
}

export interface ChartPoint {
  time: number;
  price: number;
}

export interface KnowledgeCitation {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  sourcePath: string;
  sourceKind: 'user-rule' | 'book' | 'knowledge-base' | 'vault' | 'doc' | 'generated';
  locator: string;
  charStart: number;
  charEnd: number;
  quote: string;
  relevance: number;
}

export interface TriggeringRule {
  ruleId: string;
  ruleName: string;
  origin: 'builtin' | 'user-tradingview' | 'learned-corpus';
  conditionMet: string;
}

export interface ProjectedLevel {
  price: number;
  role: 'entry-zone' | 'invalidation' | 'objective';
  derivedFrom: string;
  rMultiple: number | null;
}

export interface ChartAnnotation {
  id: string;
  kind: AnnotationKind;
  label: string;
  points: ChartPoint[];
  band: { top: number; bottom: number } | null;
  pane: Pane;
  style: { color: string; width: number; dash: 'solid' | 'dashed' | 'dotted'; opacity: number };
  /** Why it was drawn. Always present — the service cannot construct one without it. */
  explanation: string;
  /** Which learned rule placed it. Always present. */
  triggeredBy: TriggeringRule;
  /** 0..1 confidence in this specific annotation. Always present. */
  confidence: number;
  citations: KnowledgeCitation[];
  levels: ProjectedLevel[];
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
  selected: boolean;
  stepsFromSpot: number;
}

export interface OptionContextPanel {
  underlying: string;
  spot: number;
  selectedStrike: number | null;
  selectedRight: 'CE' | 'PE' | null;
  /** Whether the user named the strike or the system snapped to ATM. */
  strikeSource: 'user' | 'atm-snap' | 'none';
  expiry: string | null;
  rows: OptionContextRow[];
  summary: {
    pcr: number;
    maxPain: number;
    callOIWall: number | null;
    putOIWall: number | null;
    strikesAnalysed: number;
  } | null;
}

export interface SupportingConcept {
  conceptId: string;
  name: string;
  relevance: string;
  weight: number;
  citations: KnowledgeCitation[];
}

export interface EvidenceItem {
  statement: string;
  kind: 'measured' | 'derived' | 'knowledge';
  value?: number | string | boolean | null;
  citations: KnowledgeCitation[];
  strength: number;
}

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

export type Stance = 'bullish' | 'bearish' | 'neutral' | 'risk-elevated' | 'no-read';

export interface AgentVerdict {
  agent: AgentId;
  subtaskId: string;
  stance: Stance;
  confidence: number;
  headline: string;
  evidence: EvidenceItem[];
  supportingConcepts: SupportingConcept[];
  citations: KnowledgeCitation[];
  abstained: boolean;
  abstentionReason: string | null;
  dataQuality: number;
  latencyMs: number;
}

export interface Conflict {
  kind: 'directional' | 'confidence-outlier' | 'evidence-contradiction' | 'knowledge-contradiction';
  between: AgentId[];
  detail: string;
  resolution: string;
  favoured: AgentId | null;
  penalty: number;
}

export interface SynthesisResult {
  surfaced: boolean;
  observation: {
    status: string;
    content: string;
    confidence: number;
    pattern: string;
    citations: KnowledgeCitation[];
    supportingConcepts: SupportingConcept[];
    disclaimer: string;
  } | null;
  /** Why nothing was surfaced. Null when it was. */
  silenceReason: string | null;
  confidence: number;
  threshold: number;
  corroboratingAgents: number;
  requiredCorroboration: number;
  leadingStance: Stance;
  corroboration: { agent: AgentId; stance: Stance; confidence: number; effectiveWeight: number; distinctSources: number }[];
  conflicts: Conflict[];
  validationFailures: { agent: AgentId; subtaskId: string; rule: string; detail: string }[];
}

export interface UnderstoodRequest {
  rawText: string;
  market: { symbol: string; name: string; kind: string; hasOptionChain: boolean; strikeStep: number | null };
  strike: number | null;
  right: 'CE' | 'PE' | null;
  expiry: string | null;
  expiryPhrase: string | null;
  timeframe: string;
  strategyIds: string[];
  indicators: string[];
  style: string;
  riskProfile: string;
  intent: string;
  assumptions: { field: string; value: string; reason: string }[];
  parseConfidence: number;
}

export interface ReasoningRun {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  understood: UnderstoodRequest;
  plan: {
    subtasks: { id: string; agent: AgentId; question: string; rationale: string; weight: number }[];
    skipped: { agent: AgentId; reason: string }[];
  };
  verdicts: AgentVerdict[];
  synthesis: SynthesisResult;
  corpus: { documents: number; chunks: number; concepts: number; indexedAt: string | null };
}

export interface WorkspacePayload {
  runId: string;
  symbol: string;
  timeframe: string;
  candles: SerializedCandle[];
  optionContext: OptionContextPanel | null;
  annotations: ChartAnnotation[];
  reasoning: ReasoningRun;
  panes: Pane[];
  ruleMatches: { id: string; name: string; matched: boolean; score: number; met: string[]; unmet: string[] }[];
}

/** Human-readable agent labels, used across every panel. */
export const AGENT_LABELS: Record<AgentId, string> = {
  'market-intelligence': 'Market',
  'strategy-intelligence': 'Strategy',
  'news-intelligence': 'News',
  'options-chain-intelligence': 'Options Chain',
  'risk-intelligence': 'Risk',
  'emotion-intelligence': 'Emotion',
  'trap-intelligence': 'Trap',
  'historical-pattern-intelligence': 'Historical Pattern',
  'compliance-intelligence': 'Compliance',
  'learning-intelligence': 'Learning',
};

export const STANCE_LABELS: Record<Stance, string> = {
  bullish: 'Bullish',
  bearish: 'Bearish',
  neutral: 'Neutral',
  'risk-elevated': 'Risk elevated',
  'no-read': 'No read',
};
