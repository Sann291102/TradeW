/**
 * The closed semantic relation vocabulary of the Sentinel Concept Knowledge
 * Graph.
 *
 * The existing entity graph (`GraphNode`/`GraphEdge`, written by
 * ConceptLearningEngine) uses two structural relations — `mentions` and
 * `co_occurs_with` — which record that two things appeared together. They
 * carry no meaning, so nothing can be reasoned from them. This vocabulary is
 * the opposite: every relation states *how* two concepts relate, which is
 * what lets the reasoner walk an edge and produce a sentence explaining the
 * step.
 *
 * The vocabulary is closed. Authors pick from these thirteen; a genuinely new
 * relation is an ontology change reviewed on its own, not a free-text string,
 * because `polarity` and `transitive` below are load-bearing for reasoning —
 * an unknown relation would silently weight a conclusion wrong.
 */
export const RELATION_TYPES = [
  'is_a',
  'part_of',
  'causes',
  'precedes',
  'confirms',
  'contradicts',
  'invalidates',
  'depends_on',
  'similar_to',
  'measured_by',
  'mitigates',
  'amplifies',
  'example_of',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * How traversing an edge affects the confidence of the conclusion being
 * assembled: `supporting` raises it, `opposing` lowers it, `neutral` moves
 * laterally (taxonomy and analogy steps navigate without asserting).
 */
export type RelationPolarity = 'supporting' | 'opposing' | 'neutral';

export interface RelationSpec {
  readonly type: RelationType;
  /** Reading of `from → to`, used verbatim when narrating a reasoning path. */
  readonly reads: string;
  /** Reading of the same edge traversed backwards, `to → from`. */
  readonly readsInverse: string;
  /** True when the relation holds identically in both directions. */
  readonly symmetric: boolean;
  /**
   * Whether the reasoner may chain this relation across multiple hops.
   * Causal and structural relations chain (with per-hop decay); analogical
   * and contradictory ones do not — "A contradicts B, B contradicts C" says
   * nothing about A and C, and chaining it would manufacture false conflict.
   */
  readonly transitive: boolean;
  readonly polarity: RelationPolarity;
  readonly description: string;
}

export const RELATIONS: Record<RelationType, RelationSpec> = {
  is_a: {
    type: 'is_a',
    reads: 'is a kind of',
    readsInverse: 'has subtype',
    symmetric: false,
    transitive: true,
    polarity: 'neutral',
    description: 'Taxonomic parent. A liquidity sweep is_a false-breakout variant.',
  },
  part_of: {
    type: 'part_of',
    reads: 'is part of',
    readsInverse: 'contains',
    symmetric: false,
    transitive: true,
    polarity: 'neutral',
    description: 'Compositional membership — a component of a larger named configuration.',
  },
  causes: {
    type: 'causes',
    reads: 'causes',
    readsInverse: 'is caused by',
    symmetric: false,
    transitive: true,
    polarity: 'supporting',
    description: 'A mechanically produces B. The strongest claim in the vocabulary; use sparingly.',
  },
  precedes: {
    type: 'precedes',
    reads: 'typically precedes',
    readsInverse: 'typically follows',
    symmetric: false,
    transitive: true,
    polarity: 'neutral',
    description: 'Temporal ordering with no causal claim. Use when sequence is observed but mechanism is not established.',
  },
  confirms: {
    type: 'confirms',
    reads: 'confirms',
    readsInverse: 'is confirmed by',
    symmetric: false,
    transitive: false,
    polarity: 'supporting',
    description: 'A raises confidence that B is genuinely present. Corroboration, not proof.',
  },
  contradicts: {
    type: 'contradicts',
    reads: 'contradicts',
    readsInverse: 'contradicts',
    symmetric: true,
    transitive: false,
    polarity: 'opposing',
    description: 'Mutually weakening. Both present means the reading is ambiguous, not that one is false.',
  },
  invalidates: {
    type: 'invalidates',
    reads: 'invalidates',
    readsInverse: 'is invalidated by',
    symmetric: false,
    transitive: false,
    polarity: 'opposing',
    description: 'A stronger, directional contradiction — A being present means B no longer holds at all.',
  },
  depends_on: {
    type: 'depends_on',
    reads: 'depends on',
    readsInverse: 'is a precondition for',
    symmetric: false,
    transitive: true,
    polarity: 'neutral',
    description: 'B must hold for A to be meaningful. Absent B, A should not be asserted.',
  },
  similar_to: {
    type: 'similar_to',
    reads: 'is similar to',
    readsInverse: 'is similar to',
    symmetric: true,
    transitive: false,
    polarity: 'neutral',
    description: 'Analogical resemblance — the backbone of historical-similarity retrieval.',
  },
  measured_by: {
    type: 'measured_by',
    reads: 'is measured by',
    readsInverse: 'measures',
    symmetric: false,
    transitive: false,
    polarity: 'supporting',
    description: 'Links an abstract concept to the concrete indicator or metric that quantifies it.',
  },
  mitigates: {
    type: 'mitigates',
    reads: 'mitigates',
    readsInverse: 'is mitigated by',
    symmetric: false,
    transitive: false,
    polarity: 'opposing',
    description: 'A risk-management control that reduces the impact of a risk concept.',
  },
  amplifies: {
    type: 'amplifies',
    reads: 'amplifies',
    readsInverse: 'is amplified by',
    symmetric: false,
    transitive: false,
    polarity: 'supporting',
    description: 'A increases the magnitude or reach of B without being its cause.',
  },
  example_of: {
    type: 'example_of',
    reads: 'is an example of',
    readsInverse: 'has example',
    symmetric: false,
    transitive: false,
    polarity: 'neutral',
    description: 'A dated historical instance illustrating a concept. Instance level, not concept level.',
  },
};

const RELATION_SET: ReadonlySet<string> = new Set(RELATION_TYPES);

export function isRelationType(value: unknown): value is RelationType {
  return typeof value === 'string' && RELATION_SET.has(value);
}

/**
 * Confidence multiplier applied per hop when a reasoning path chains through
 * this relation. Causal chains decay fastest — three hops of `causes` is a
 * much weaker claim than one, and the reasoner must show that.
 */
export const RELATION_HOP_DECAY: Record<RelationType, number> = {
  is_a: 0.95,
  part_of: 0.95,
  causes: 0.75,
  precedes: 0.7,
  confirms: 0.85,
  contradicts: 1,
  invalidates: 1,
  depends_on: 0.9,
  similar_to: 0.6,
  measured_by: 0.9,
  mitigates: 0.85,
  amplifies: 0.8,
  example_of: 0.7,
};

/** Narrate one traversal step in plain English, for explanation output. */
export function readEdge(relation: RelationType, fromLabel: string, toLabel: string, reversed = false): string {
  const spec = RELATIONS[relation];
  return reversed
    ? `${toLabel} ${spec.readsInverse} ${fromLabel}`
    : `${fromLabel} ${spec.reads} ${toLabel}`;
}
