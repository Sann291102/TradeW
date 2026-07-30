/**
 * Shared types for the Reasoning module (Phase 2).
 *
 * Every type describes a stage of runtime knowledge use — retrieval,
 * ranking, and explanation composition. All output types are educational
 * only; nothing here carries directive fields (entry/exit/target/action).
 */
import { MemorySearchHit } from '@tradew/ai-core';

/** A retrieved memory record augmented with the multi-factor rank score. */
export interface RankedKnowledge {
  hit: MemorySearchHit;
  /** Combined 0..1 score after all ranking factors are applied. */
  score: number;
  /** Individual factor contributions — inspectable so an explanation can cite them. */
  breakdown: RankBreakdown;
}

export interface RankBreakdown {
  /** Raw retriever similarity (0..1). */
  similarity: number;
  /** Author confidence stored on the memory record (0..1). */
  confidence: number;
  /** Freshness factor (0..1). Falls with age and past staleAfter. */
  freshness: number;
  /** Concept-maturity factor (0..1). established > emerging > contested. */
  maturity: number;
  /** Concept-importance factor (0..1). Strategy/pattern knowledge weighs more than glossary. */
  importance: number;
  /** User-relevance factor (0..1). userId match on the record boosts the score. */
  userRelevance: number;
}

/** Named tag/keyword hints to boost during ranking. */
export interface RankingHints {
  /** Tags whose presence boosts the record's score (e.g. `domain:trading-psychology`). */
  boostTags?: string[];
  /** Tags whose absence penalises the record (rare). */
  requireTags?: string[];
  /** Concept ids to strongly prefer. */
  preferConceptIds?: string[];
  /** userId for user-relevance factor. */
  userId?: string | null;
}

export interface RetrievalRequest {
  query: string;
  /** Semantic namespaces to search across; merged with dedupe. */
  namespaces?: string[];
  limit?: number;
  hints?: RankingHints;
  /** Skip cache lookup even if a fresh entry exists. */
  bypassCache?: boolean;
}

export interface RetrievalResult {
  query: string;
  items: RankedKnowledge[];
  /** Raw hit count before dedup + limit. */
  rawHitCount: number;
  /** Namespaces that were actually queried. */
  namespaces: string[];
  /** True if this result was served from the cache. */
  cached: boolean;
  /** Wall-clock milliseconds for the retrieval. */
  latencyMs: number;
}

/** Input contract for the ReasoningContextBuilder — every field is optional so partial contexts still produce useful output. */
export interface ContextInput {
  symbol?: string;
  timeframe?: string;
  /** Free-text description of the current pattern (e.g. `orb_retest`, `Liquidity Sweep`). */
  patternName?: string;
  /** Free-text description of the current market regime, if the caller has classified one. */
  marketRegime?: string;
  /** Snapshot-derived indicator strings (`RSI(14): 62.1`, `VWAP 24350.5`, …). */
  indicators?: string[];
  /** Free-text description of recent memory or session events. */
  recentMemory?: string[];
  /** Detected psychology cues from the caller, if any. */
  psychologyCues?: string[];
  /** userId for user-relevance ranking. */
  userId?: string | null;
}

/** Composed reasoning context — the intermediate structure the ExplanationEngine consumes. */
export interface ReasoningContext {
  input: ContextInput;
  /** Human-readable synthesis of every input field. */
  synthesis: string;
  /** Retrieved knowledge relevant to the market/technical context. */
  marketKnowledge: RankedKnowledge[];
  /** Retrieved knowledge relevant to the current pattern/strategy. */
  strategyKnowledge: RankedKnowledge[];
  /** Retrieved knowledge relevant to the detected psychology cues. */
  psychologyKnowledge: RankedKnowledge[];
  /** Retrieved knowledge relevant to the regime (e.g. accumulation, volatility). */
  regimeKnowledge: RankedKnowledge[];
  /** Milliseconds spent building this context. */
  latencyMs: number;
}

export interface ExplanationDraft {
  /** Non-directive one-line status. Never contains buy/sell/entry/exit. */
  headline: string;
  /** Deterministic reasoning summary — the "Why". */
  why: string;
  /** Concepts that support the reading, ranked. */
  supportingConcepts: string[];
  /** Psychology observations to keep in mind. */
  relatedPsychology: string[];
  /** Risk-awareness notes derived from ranked risk concepts. */
  riskAwareness: string[];
  /** Failure/invalidation scenarios sourced from the ontology. */
  failureScenarios: string[];
  /** Learning references (concept ids or summaries). */
  learningReferences: string[];
  /** True when every source came from the Brain (no LLM prose). */
  deterministic: boolean;
}

export interface SimilarityResult {
  sourceId: string;
  neighbours: RankedKnowledge[];
  /** Milliseconds to compute. */
  latencyMs: number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
}

/**
 * Market-regime taxonomy used by the RegimeIntelligenceService.
 * Deliberately a closed set — a regime that fits none of these is a signal to
 * discuss the taxonomy, not to invent a new label in-line.
 */
export const REGIMES = [
  'trending',
  'ranging',
  'volatile',
  'low-volatility',
  'breakout',
  'mean-reversion',
  'accumulation',
  'distribution',
] as const;

export type Regime = (typeof REGIMES)[number];
