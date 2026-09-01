import type { OptionPositioningRead } from '../../execution/option-positioning';
import type { MarketSnapshot } from '../../intelligence/market-intelligence.service';
import type { StrategyDetection } from '../../intelligence/strategy-engine.service';
import type { RiskAssessment, Signal } from '../../domain';
import type { KnowledgeIndexService } from '../knowledge/knowledge-index.service';
import type { ReasoningGraphService } from '../knowledge/reasoning-graph.service';
import type {
  AgentId,
  AgentVerdict,
  EvidenceItem,
  KnowledgeCitation,
  KnowledgeSourceKind,
  Stance,
  Subtask,
  SupportingConcept,
  TradeLike,
  UnderstoodRequest,
  VerdictVeto,
  VerdictVetoCode,
} from '../types';

/**
 * Everything an agent is allowed to see.
 *
 * The deterministic market computations are performed ONCE by the engine and
 * handed to all ten agents through this context. Ten agents each calling
 * `market.snapshot()` would issue ten identical candle fetches per request and,
 * worse, could observe ten slightly different markets — an agent disagreeing
 * with another because it read a fresher tick is a fake conflict, and the
 * cross-checker cannot tell it apart from a real one.
 *
 * `snapshot` and friends come from the EXISTING intelligence engines, unchanged
 * and uncopied. This module adds knowledge grounding on top of that math; it
 * does not reimplement it.
 */
export interface AgentContext {
  understood: UnderstoodRequest;
  subtask: Subtask;
  /** Shared market read — computed once per run. Null when data was unavailable. */
  snapshot: MarketSnapshot | null;
  /**
   * The option book read as DEFENDED LEVELS plus today's change at each —
   * where support and resistance actually are, whether their defenders added
   * or reduced today, and which way the whole structure migrated.
   *
   * On the shared context rather than inside the options agent because it is
   * not only the options agent's business. A trap read is a different read
   * when price is pressed against a wall that is being reinforced; a risk read
   * is a different read when the support behind price is being abandoned; and
   * a strategy read that quoted different levels from the options agent's,
   * inside one run, would be a fake disagreement the cross-checker could not
   * tell from a real one. One computation, one set of levels, ten readers.
   *
   * Null when the instrument published no chain or spot was unusable. An agent
   * must treat null as "no positioning read" and abstain on it, never as
   * balanced positioning.
   */
  positioning: OptionPositioningRead | null;
  /** Signals from the existing deterministic engines, already computed. */
  signals: Signal[];
  /** Strategy detections from the existing Strategy Engine. */
  detections: StrategyDetection[];
  /** Risk assessment from the existing Risk Intelligence engine. */
  risk: RiskAssessment | null;
  trades: TradeLike[];
  account: { marginUsed?: number; marginAvailable?: number; totalCapital?: number } | undefined;
  /**
   * The Brain's measured live-market track record for the patterns this run's
   * detections are about, resolved ONCE by the engine before any agent runs.
   *
   * Keyed by pattern name — `strategyId` with dashes as underscores, the same
   * string `PatternRecognitionService` writes and
   * `StrategyIntelligenceService.baseRateFor` matches on. A pattern with no
   * recorded occurrences is present with `sample: 0`, so an agent never has to
   * distinguish "not looked up" from "looked up and found nothing".
   *
   * Pre-computed for the same reason `snapshot` is: this is a Postgres read,
   * and an agent that performed it would be doing I/O inside what is otherwise
   * a pure function over shared state — and ten agents wanting it would issue
   * ten scans of one table. Empty when the lookup failed or there were no
   * detections; an agent must treat absence as "no live record", never as
   * corroboration.
   */
  baseRates: ReadonlyMap<string, LiveBaseRate>;
  /** Corpus retrieval. */
  index: KnowledgeIndexService;
  /** Concept ontology + grounding. */
  graph: ReasoningGraphService;
  at: Date;
}

/**
 * A pattern's measured performance in the live market.
 *
 * Deliberately a narrow projection of the Brain's `BaseRateResult` rather than
 * the type itself: an agent needs the sample, the distribution and whether the
 * sample is big enough to mean anything, and giving it the Brain's own type
 * would invite an agent to start depending on the Brain's shape and, from
 * there, on the Brain.
 */
export interface LiveBaseRate {
  pattern: string;
  /** Outcome-tagged occurrences recorded across all symbols. */
  sample: number;
  /** outcome → count. Empty when `sample` is 0. */
  distribution: Record<string, number>;
  /** True once the sample clears the Brain's own significance floor. */
  reliable: boolean;
}

/** Every specialist agent implements exactly this. */
export interface IntelligenceAgent {
  readonly id: AgentId;
  /** One line describing what this agent is responsible for. */
  readonly remit: string;
  reason(context: AgentContext): Promise<AgentVerdict> | AgentVerdict;
}

/**
 * Fluent builder that makes a well-formed verdict the path of least resistance.
 *
 * The validator rejects any `knowledge`-kind evidence with no citation. Rather
 * than leaving each of ten agents to remember that, `knowledge()` requires the
 * citations as an argument, so the invalid state is not constructible.
 */
export class VerdictBuilder {
  private readonly evidence: EvidenceItem[] = [];
  private concepts: SupportingConcept[] = [];
  private stance: Stance = 'no-read';
  private confidence = 0;
  private headline = '';
  private dataQuality = 1;
  private abstained = false;
  private abstentionReason: string | null = null;
  private vetoed: VerdictVeto | null = null;
  private readonly startedAt = Date.now();

  constructor(
    private readonly agent: AgentId,
    private readonly subtaskId: string,
  ) {}

  /** A directly observed value from live market data. */
  measured(statement: string, value: number | string | boolean | null, strength = 0.5): this {
    this.evidence.push({ statement, kind: 'measured', value, citations: [], strength: clamp01(strength) });
    return this;
  }

  /** A value computed from measured inputs. */
  derived(statement: string, value: number | string | boolean | null, strength = 0.5): this {
    this.evidence.push({ statement, kind: 'derived', value, citations: [], strength: clamp01(strength) });
    return this;
  }

  /**
   * A claim drawn from the learned corpus. Citations are mandatory — an
   * uncitable knowledge claim is exactly the thing this module exists to
   * prevent, so it cannot be expressed.
   */
  knowledge(statement: string, citations: KnowledgeCitation[], strength = 0.5): this {
    if (citations.length === 0) {
      throw new Error(
        `${this.agent}: knowledge evidence "${statement.slice(0, 60)}" was built with no citations. ` +
          'Use measured()/derived() for claims that do not come from the corpus.',
      );
    }
    this.evidence.push({ statement, kind: 'knowledge', value: null, citations, strength: clamp01(strength) });
    return this;
  }

  supporting(concepts: SupportingConcept[]): this {
    this.concepts = concepts;
    return this;
  }

  /** Set the verdict. `confidence` is the agent's own, before any weighting. */
  conclude(stance: Stance, confidence: number, headline: string): this {
    this.stance = stance;
    this.confidence = clamp01(confidence);
    this.headline = headline;
    return this;
  }

  /** 0..1 — how complete the inputs were. Scales this verdict at synthesis. */
  quality(dataQuality: number): this {
    this.dataQuality = clamp01(dataQuality);
    return this;
  }

  /**
   * Decline to answer.
   *
   * An abstention carries zero confidence and never counts toward
   * corroboration. It is a first-class result: "I have no data" must never be
   * expressible as "I found nothing wrong".
   */
  abstain(reason: string): this {
    this.abstained = true;
    this.abstentionReason = reason;
    this.stance = 'no-read';
    this.confidence = 0;
    this.headline = reason;
    return this;
  }

  /**
   * Raise a veto: a finding the synthesis gate must honour rather than weigh.
   *
   * Deliberately separate from `conclude()`. A stance and a confidence are an
   * opinion the cross-checker is entitled to outvote; a veto is not an opinion,
   * and expressing it as a very confident stance would leave it subject to
   * exactly the weighting that makes it advisory. An agent that vetoes should
   * normally also `conclude()` so the run's audit trail still reads sensibly.
   */
  veto(code: VerdictVetoCode, reason: string): this {
    this.vetoed = { code, reason };
    return this;
  }

  build(): AgentVerdict {
    const citations = dedupeCitations(this.evidence.flatMap((e) => e.citations));
    return {
      agent: this.agent,
      subtaskId: this.subtaskId,
      stance: this.stance,
      confidence: this.abstained ? 0 : this.confidence,
      headline: this.headline,
      evidence: this.evidence,
      supportingConcepts: this.concepts,
      citations,
      abstained: this.abstained,
      abstentionReason: this.abstentionReason,
      dataQuality: this.dataQuality,
      latencyMs: Date.now() - this.startedAt,
      veto: this.vetoed,
    };
  }
}

/**
 * Retrieve the corpus passages backing a subtask, ranked and deduped.
 *
 * Runs every query the decomposer attached and merges the results, keeping the
 * best-scoring copy of any chunk that several queries both found — a chunk two
 * independent queries agree on is more relevant, not twice as relevant.
 */
export function gatherCitations(
  context: AgentContext,
  extraQueries: string[] = [],
  opts: { limit?: number; preferKinds?: KnowledgeSourceKind[] } = {},
): KnowledgeCitation[] {
  const limit = opts.limit ?? 4;
  const queries = [...context.subtask.knowledgeQueries, ...extraQueries].filter((q) => q.trim().length > 0);
  const byChunk = new Map<string, KnowledgeCitation>();

  for (const query of queries) {
    for (const hit of context.index.search(query, { limit, preferKinds: opts.preferKinds })) {
      const citation = context.index.toCitation(hit);
      const existing = byChunk.get(citation.chunkId);
      if (!existing || citation.relevance > existing.relevance) byChunk.set(citation.chunkId, citation);
    }
  }

  return [...byChunk.values()].sort((a, b) => b.relevance - a.relevance).slice(0, limit);
}

/** Concepts supporting this subtask, from the ontology. */
export function gatherConcepts(context: AgentContext, extraQuery = '', limit = 4): SupportingConcept[] {
  const query = [context.subtask.question, extraQuery, ...context.subtask.knowledgeQueries].join(' ');
  return context.graph.supportFor(query, limit);
}

/**
 * How well-grounded a verdict is in the corpus, 0..1.
 *
 * Breadth of sources matters more than depth: three books mentioning something
 * once each is stronger corroboration than one book mentioning it three times,
 * because the second is a single author's opinion counted thrice.
 */
export function groundingScore(citations: KnowledgeCitation[]): number {
  if (citations.length === 0) return 0;
  const distinctSources = new Set(citations.map((c) => c.sourceId)).size;
  const avgRelevance = citations.reduce((s, c) => s + c.relevance, 0) / citations.length;
  const breadth = Math.min(1, distinctSources / 3);
  return clamp01(avgRelevance * (0.55 + 0.45 * breadth));
}

export function dedupeCitations(citations: KnowledgeCitation[]): KnowledgeCitation[] {
  const byChunk = new Map<string, KnowledgeCitation>();
  for (const citation of citations) {
    const existing = byChunk.get(citation.chunkId);
    if (!existing || citation.relevance > existing.relevance) byChunk.set(citation.chunkId, citation);
  }
  return [...byChunk.values()].sort((a, b) => b.relevance - a.relevance);
}

/** Signals produced by one of the existing engines, triggered only. */
export function triggeredFrom(signals: Signal[], agent: Signal['agent']): Signal[] {
  return signals.filter((s) => s.agent === agent && s.triggered);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Blend an agent's structural confidence with how well the corpus supports it.
 *
 * The floor of 0.55 is deliberate: a genuinely measured market fact does not
 * become untrue because no book in the corpus happens to discuss it, so
 * grounding modulates confidence rather than gating it. What grounding *does*
 * gate is whether the claim can be phrased as knowledge at all — that is
 * enforced separately, in `VerdictBuilder.knowledge()`.
 */
export function blendConfidence(structural: number, grounding: number): number {
  return clamp01(structural * (0.55 + 0.45 * grounding));
}
