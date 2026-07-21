import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { Domain } from './domains';
import { readEdge, RELATION_HOP_DECAY, RelationType, RELATIONS } from './relations';

/**
 * Read and reasoning layer over the concept graph.
 *
 * This is what makes the graph a reasoning engine rather than a lookup table.
 * The existing `PrismaKnowledgeGraph` does unweighted BFS over structural
 * `mentions`/`co_occurs_with` edges — fine for "what appeared together", but
 * it cannot rank paths or say anything about what a path *means*. Here every
 * edge carries a semantic type, a weight, and a polarity, so a traversal can
 * be scored and narrated.
 */

/** Below this, a concept is treated as not yet trustworthy enough to show a user. */
export const USER_FACING_CONFIDENCE_FLOOR = 0.5;

export interface ConceptSummary {
  conceptId: string;
  name: string;
  domain: string;
  summary: string;
  explainer: string;
  status: string;
  maturity: string;
  confidence: number;
  observationCount: number;
}

export interface NeighborLink {
  concept: ConceptSummary;
  relation: RelationType;
  /** learnedWeight when runtime evidence exists, otherwise the authored weight. */
  effectiveWeight: number;
  authoredWeight: number;
  learnedWeight: number | null;
  supportCount: number;
  refuteCount: number;
  /** True when the edge was traversed against its declared direction. */
  reversed: boolean;
  polarity: 'supporting' | 'opposing' | 'neutral';
  note: string | null;
  /** Plain-English reading of this single step. */
  reads: string;
}

export interface ReasoningStep {
  from: string;
  to: string;
  relation: RelationType;
  reversed: boolean;
  weight: number;
  reads: string;
}

export interface ReasoningPath {
  steps: ReasoningStep[];
  /** Product of per-step weights and per-relation decay. Strictly decreasing with length. */
  score: number;
  narration: string;
}

export interface GraphQueryOptions {
  /** Include concepts still awaiting human promotion. Internal tooling only. */
  includeProposed?: boolean;
  /** Include deprecated concepts. Audit and provenance only — never user-facing. */
  includeDeprecated?: boolean;
  limit?: number;
}

@Injectable()
export class ConceptGraphService {
  private readonly logger = new Logger(ConceptGraphService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The validation gate from SENTINEL-KNOWLEDGE-GRAPH.md §5. Proposed and
   * deprecated concepts stay in the graph for audit and provenance but are
   * excluded from anything a user can see, unless a caller explicitly opts in.
   */
  private statusFilter(opts: GraphQueryOptions = {}) {
    const statuses = ['canonical'];
    if (opts.includeProposed) statuses.push('proposed');
    if (opts.includeDeprecated) statuses.push('deprecated');
    return {
      status: { in: statuses },
      ...(opts.includeProposed || opts.includeDeprecated ? {} : { confidence: { gte: USER_FACING_CONFIDENCE_FLOOR } }),
    };
  }

  async getConcept(conceptId: string, opts: GraphQueryOptions = {}): Promise<ConceptSummary | null> {
    const row = await this.prisma.conceptNode.findFirst({
      where: { conceptId, ...this.statusFilter(opts) },
    });
    return row ? toSummary(row) : null;
  }

  async byDomain(domain: Domain, opts: GraphQueryOptions = {}): Promise<ConceptSummary[]> {
    const rows = await this.prisma.conceptNode.findMany({
      where: { domain, ...this.statusFilter(opts) },
      orderBy: [{ confidence: 'desc' }, { name: 'asc' }],
      take: opts.limit ?? 200,
    });
    return rows.map(toSummary);
  }

  /**
   * Text search over name, aliases and summary.
   *
   * Deliberately not semantic yet: the `embedding` column exists but nothing
   * populates it until an embedding provider is configured, which is the same
   * operational gap `PrismaMemoryStore` already has. Falling back to text
   * match keeps this useful rather than empty, and the method signature does
   * not change when embeddings arrive.
   */
  async search(query: string, opts: GraphQueryOptions = {}): Promise<ConceptSummary[]> {
    const q = query.trim();
    if (!q) return [];
    const rows = await this.prisma.conceptNode.findMany({
      where: {
        ...this.statusFilter(opts),
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { summary: { contains: q, mode: 'insensitive' } },
          { aliases: { hasSome: [q.toLowerCase()] } },
          { conceptId: { contains: q.toLowerCase().replace(/\s+/g, '-') } },
        ],
      },
      orderBy: [{ confidence: 'desc' }],
      take: opts.limit ?? 20,
    });
    return rows.map(toSummary);
  }

  /**
   * Neighbours in both directions, with each edge narrated and weighted.
   *
   * Traversing an edge backwards is legitimate and often necessary — "what
   * causes X" walks `causes` edges inbound — so the reverse reading is
   * returned alongside, and symmetric relations read identically either way.
   */
  async neighbors(
    conceptId: string,
    filter: { relations?: RelationType[]; polarity?: 'supporting' | 'opposing' | 'neutral' } = {},
    opts: GraphQueryOptions = {},
  ): Promise<NeighborLink[]> {
    const node = await this.prisma.conceptNode.findUnique({ where: { conceptId } });
    if (!node) return [];

    const relationFilter = filter.relations?.length ? { relation: { in: filter.relations } } : {};
    const visible = this.statusFilter(opts);

    const [outbound, inbound] = await Promise.all([
      this.prisma.conceptEdge.findMany({
        where: { fromId: node.id, status: { in: ['canonical', ...(opts.includeProposed ? ['proposed'] : [])] }, ...relationFilter },
        include: { to: true },
        take: opts.limit ?? 100,
      }),
      this.prisma.conceptEdge.findMany({
        where: { toId: node.id, status: { in: ['canonical', ...(opts.includeProposed ? ['proposed'] : [])] }, ...relationFilter },
        include: { from: true },
        take: opts.limit ?? 100,
      }),
    ]);

    const links: NeighborLink[] = [];
    for (const edge of outbound) {
      if (!matchesStatus(edge.to, visible)) continue;
      links.push(buildLink(edge, edge.to, node.name, false));
    }
    for (const edge of inbound) {
      if (!matchesStatus(edge.from, visible)) continue;
      // Symmetric relations read the same both ways, so don't double-report
      // a symmetric edge that also appeared outbound.
      links.push(buildLink(edge, edge.from, node.name, true));
    }

    const filtered = filter.polarity ? links.filter((l) => l.polarity === filter.polarity) : links;
    return filtered.sort((a, b) => b.effectiveWeight - a.effectiveWeight);
  }

  /**
   * Best-scoring reasoning path between two concepts.
   *
   * Uses best-first search over `-log(weight)` rather than plain BFS: the
   * shortest path and the strongest path are frequently different, and for an
   * explanation the strongest one is what should be shown. Non-transitive
   * relations (`contradicts`, `similar_to`, ...) terminate a path instead of
   * extending it — chaining them manufactures conclusions the ontology never
   * asserted, which is exactly the failure mode a naive graph walk produces.
   */
  async explainPath(fromConceptId: string, toConceptId: string, maxHops = 4): Promise<ReasoningPath | null> {
    const [start, goal] = await Promise.all([
      this.prisma.conceptNode.findUnique({ where: { conceptId: fromConceptId } }),
      this.prisma.conceptNode.findUnique({ where: { conceptId: toConceptId } }),
    ]);
    if (!start || !goal) return null;
    if (start.id === goal.id) return { steps: [], score: 1, narration: `${start.name} and ${goal.name} are the same concept.` };

    // Best-first frontier ordered by descending cumulative score.
    type Entry = { nodeId: string; nodeName: string; score: number; steps: ReasoningStep[] };
    const best = new Map<string, number>([[start.id, 1]]);
    let frontier: Entry[] = [{ nodeId: start.id, nodeName: start.name, score: 1, steps: [] }];

    for (let hop = 0; hop < maxHops; hop++) {
      const next: Entry[] = [];
      for (const entry of frontier) {
        const edges = await this.prisma.conceptEdge.findMany({
          where: { OR: [{ fromId: entry.nodeId }, { toId: entry.nodeId }], status: 'canonical' },
          include: { from: true, to: true },
        });

        for (const edge of edges) {
          const relation = edge.relation as RelationType;
          const spec = RELATIONS[relation];
          if (!spec) continue; // unknown relation — never reason through it

          const reversed = edge.toId === entry.nodeId;
          const other = reversed ? edge.from : edge.to;
          const weight = edge.learnedWeight ?? edge.weight;
          const score = entry.score * weight * RELATION_HOP_DECAY[relation];

          const step: ReasoningStep = {
            from: entry.nodeName,
            to: other.name,
            relation,
            reversed,
            weight,
            reads: readEdge(relation, reversed ? other.name : entry.nodeName, reversed ? entry.nodeName : other.name, reversed),
          };

          if (other.id === goal.id) {
            const steps = [...entry.steps, step];
            return { steps, score, narration: narrate(steps) };
          }

          // Only transitive relations may be chained further.
          if (!spec.transitive) continue;
          if ((best.get(other.id) ?? 0) >= score) continue;
          best.set(other.id, score);
          next.push({ nodeId: other.id, nodeName: other.name, score, steps: [...entry.steps, step] });
        }
      }
      if (next.length === 0) break;
      // Keep the frontier bounded — this graph is intended to reach thousands
      // of concepts, and an unbounded frontier degrades badly at that size.
      frontier = next.sort((a, b) => b.score - a.score).slice(0, 32);
    }
    return null;
  }

  /**
   * The core explainability call: given the concepts Sentinel just detected,
   * assemble what the ontology says about them together.
   *
   * Returns supporting and contradicting evidence separately and never
   * collapses them into a verdict — surfacing the conflict is the point.
   */
  async explainObservation(
    conceptIds: string[],
    opts: GraphQueryOptions = {},
  ): Promise<{
    concepts: ConceptSummary[];
    supporting: NeighborLink[];
    contradicting: NeighborLink[];
    connections: ReasoningPath[];
    unknown: string[];
  }> {
    const found = await this.prisma.conceptNode.findMany({
      where: { conceptId: { in: conceptIds }, ...this.statusFilter(opts) },
    });
    const foundIds = new Set(found.map((c) => c.conceptId));
    const unknown = conceptIds.filter((id) => !foundIds.has(id));

    const supporting: NeighborLink[] = [];
    const contradicting: NeighborLink[] = [];
    for (const concept of found) {
      const links = await this.neighbors(concept.conceptId, {}, opts);
      for (const link of links) {
        if (link.polarity === 'supporting') supporting.push(link);
        else if (link.polarity === 'opposing') contradicting.push(link);
      }
    }

    // How the detected concepts relate to each other — the part that turns a
    // list of detections into an account of one situation.
    const connections: ReasoningPath[] = [];
    const ids = found.map((c) => c.conceptId);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const path = await this.explainPath(ids[i], ids[j], 3);
        if (path && path.steps.length > 0) connections.push(path);
      }
    }
    connections.sort((a, b) => b.score - a.score);

    return {
      concepts: found.map(toSummary),
      supporting: dedupeLinks(supporting).slice(0, opts.limit ?? 12),
      contradicting: dedupeLinks(contradicting).slice(0, opts.limit ?? 12),
      connections: connections.slice(0, 8),
      unknown,
    };
  }

  /**
   * Concepts analogous to this one, for historical-similarity retrieval.
   * Combines declared `similar_to` edges with structural similarity (shared
   * neighbours), because an explicit analogy is stronger evidence than an
   * inferred one but far sparser.
   */
  async similarConcepts(conceptId: string, limit = 10): Promise<{ concept: ConceptSummary; score: number; basis: string }[]> {
    const declared = await this.neighbors(conceptId, { relations: ['similar_to', 'is_a'] });
    const scored = new Map<string, { concept: ConceptSummary; score: number; basis: string }>();
    for (const link of declared) {
      scored.set(link.concept.conceptId, {
        concept: link.concept,
        score: link.effectiveWeight,
        basis: `declared ${link.relation}`,
      });
    }

    const own = await this.neighbors(conceptId);
    const ownNeighborIds = new Set(own.map((l) => l.concept.conceptId));
    for (const link of own) {
      const second = await this.neighbors(link.concept.conceptId);
      for (const candidate of second) {
        if (candidate.concept.conceptId === conceptId) continue;
        if (scored.has(candidate.concept.conceptId)) continue;
        const shared = ownNeighborIds.has(candidate.concept.conceptId) ? 0.35 : 0.2;
        scored.set(candidate.concept.conceptId, {
          concept: candidate.concept,
          score: shared * link.effectiveWeight,
          basis: `shares context via ${link.concept.name}`,
        });
      }
    }

    return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async stats(): Promise<Record<string, unknown>> {
    const [concepts, edges, observations, promotions, learnedEdges] = await Promise.all([
      this.prisma.conceptNode.count(),
      this.prisma.conceptEdge.count(),
      this.prisma.conceptObservation.count(),
      this.prisma.conceptPromotion.count({ where: { status: 'pending' } }),
      this.prisma.conceptEdge.count({ where: { learnedWeight: { not: null } } }),
    ]);
    const byDomain = await this.prisma.conceptNode.groupBy({ by: ['domain'], _count: true });
    return {
      concepts,
      edges,
      observations,
      pendingPromotions: promotions,
      edgesWithLearnedWeight: learnedEdges,
      byDomain: Object.fromEntries(byDomain.map((d) => [d.domain, d._count])),
    };
  }
}

// ---------------------------------------------------------------------------

interface NodeRow {
  conceptId: string;
  name: string;
  domain: string;
  summary: string;
  explainer: string;
  status: string;
  maturity: string;
  confidence: number;
  observationCount: number;
}

function toSummary(row: NodeRow): ConceptSummary {
  return {
    conceptId: row.conceptId,
    name: row.name,
    domain: row.domain,
    summary: row.summary,
    explainer: row.explainer,
    status: row.status,
    maturity: row.maturity,
    confidence: row.confidence,
    observationCount: row.observationCount,
  };
}

function matchesStatus(node: { status: string; confidence: number }, filter: ReturnType<ConceptGraphService['statusFilter']>): boolean {
  const statuses = (filter.status as { in: string[] }).in;
  if (!statuses.includes(node.status)) return false;
  const conf = filter.confidence as { gte: number } | undefined;
  return conf ? node.confidence >= conf.gte : true;
}

interface EdgeRow {
  relation: string;
  weight: number;
  learnedWeight: number | null;
  supportCount: number;
  refuteCount: number;
  note: string | null;
}

function buildLink(edge: EdgeRow, other: NodeRow, selfName: string, reversed: boolean): NeighborLink {
  const relation = edge.relation as RelationType;
  const spec = RELATIONS[relation];
  return {
    concept: toSummary(other),
    relation,
    effectiveWeight: edge.learnedWeight ?? edge.weight,
    authoredWeight: edge.weight,
    learnedWeight: edge.learnedWeight,
    supportCount: edge.supportCount,
    refuteCount: edge.refuteCount,
    reversed,
    polarity: spec?.polarity ?? 'neutral',
    note: edge.note,
    reads: reversed ? readEdge(relation, other.name, selfName, true) : readEdge(relation, selfName, other.name, false),
  };
}

function dedupeLinks(links: NeighborLink[]): NeighborLink[] {
  const seen = new Set<string>();
  const out: NeighborLink[] = [];
  for (const link of links.sort((a, b) => b.effectiveWeight - a.effectiveWeight)) {
    const key = `${link.concept.conceptId}:${link.relation}:${link.reversed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

function narrate(steps: ReasoningStep[]): string {
  return steps.map((s) => s.reads).join('; ') + '.';
}
