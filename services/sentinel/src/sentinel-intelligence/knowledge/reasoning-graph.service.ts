import { Injectable, Logger } from '@nestjs/common';
import { OntologyLoaderService } from '../../brain/ontology/ontology-loader.service';
import type { Concept } from '../../brain/ontology/concept.schema';
import {
  RELATIONS,
  RELATION_HOP_DECAY,
  readEdge,
  type RelationType,
} from '../../brain/ontology/relations';
import { KnowledgeIndexService } from './knowledge-index.service';
import type { KnowledgeCitation, SupportingConcept } from '../types';

/** A concept, plus where the corpus talks about it. */
export interface GroundedConcept {
  concept: Concept;
  /** Chunks in the learned corpus that discuss this concept. */
  citations: KnowledgeCitation[];
  /** How many distinct source documents mention it. */
  sourceCount: number;
  /**
   * 0..1 — how well the corpus actually supports this concept.
   *
   * A concept the books never discuss is still valid ontology, but an agent
   * citing it is citing a definition rather than evidence, and the score says
   * so instead of pretending the grounding exists.
   */
  grounding: number;
}

/** One narrated hop while walking the graph. */
export interface ReasoningStep {
  from: string;
  to: string;
  relation: RelationType;
  /** Plain-English reading of this hop, e.g. "Liquidity Sweep confirms Stop-Loss Clustering". */
  reads: string;
  /** Confidence multiplier accumulated to this point. */
  confidence: number;
}

export interface ReasoningPath {
  target: string;
  targetName: string;
  steps: ReasoningStep[];
  /** Product of per-hop decay × edge weights. */
  confidence: number;
  polarity: 'supporting' | 'opposing' | 'neutral';
}

/** Two concepts the ontology says cannot both be cleanly asserted. */
export interface ConceptTension {
  a: string;
  b: string;
  relation: 'contradicts' | 'invalidates';
  /** The author's note from the YAML, when present. */
  note: string | null;
  weight: number;
  reads: string;
}

/**
 * The reasoning brain's structural half.
 *
 * The corpus index answers "what does the literature say about X" with quotes.
 * This service answers "what does X *mean*, and what follows from it" by
 * walking the curated concept ontology — 66 concepts and 273 semantic
 * relations already in `knowledge-base/`, loaded through the existing
 * validated `OntologyLoaderService` rather than a second YAML parser.
 *
 * The two halves are joined here: every concept is grounded against the book
 * corpus at build time, so a concept an agent leans on arrives with real
 * citations attached instead of only its own definition. That join is what
 * makes "reason from the learned books" mean something more than "retrieve
 * some text" — the ontology supplies the reasoning structure, and the corpus
 * supplies the evidence for each node in it.
 */
@Injectable()
export class ReasoningGraphService {
  private readonly logger = new Logger(ReasoningGraphService.name);

  private concepts = new Map<string, Concept>();
  private grounded = new Map<string, GroundedConcept>();
  /** Outbound adjacency: conceptId → edges. */
  private edges = new Map<string, { to: string; type: RelationType; weight: number; note?: string }[]>();
  /** Inbound adjacency, so traversal can run in both directions. */
  private inbound = new Map<string, { from: string; type: RelationType; weight: number }[]>();
  /** Lowercased name/alias → conceptId, for mention detection. */
  private lexicon = new Map<string, string>();
  private builtAt: string | null = null;

  constructor(
    private readonly ontology: OntologyLoaderService,
    private readonly index: KnowledgeIndexService,
  ) {}

  /**
   * Load the ontology and ground every concept against the current corpus.
   *
   * Deprecated and proposed concepts are excluded from reasoning: `deprecated`
   * is retained for provenance only (CLAUDE.md Rule 1 applied to data), and
   * `proposed` has not been human-reviewed, so surfacing it to a trader would
   * let the system's own guesses re-enter as authority.
   */
  build(): { concepts: number; edges: number; groundedConcepts: number; issues: number } {
    const result = this.ontology.load();
    if (result.issues.length > 0) {
      this.logger.warn(`ontology loaded with ${result.issues.length} validation issue(s) — see \`npm run ontology:validate\``);
    }

    this.concepts = new Map();
    this.grounded = new Map();
    this.edges = new Map();
    this.inbound = new Map();
    this.lexicon = new Map();

    for (const { concept } of result.concepts) {
      if (concept.status !== 'canonical') continue;
      this.concepts.set(concept.id, concept);
      this.lexicon.set(concept.name.toLowerCase(), concept.id);
      for (const alias of concept.aliases) this.lexicon.set(alias.toLowerCase(), concept.id);
    }

    let edgeCount = 0;
    for (const concept of this.concepts.values()) {
      const outbound: { to: string; type: RelationType; weight: number; note?: string }[] = [];
      for (const rel of concept.relations) {
        // Skip edges into non-canonical concepts — traversing into a
        // deprecated node would resurrect it through the back door.
        if (!this.concepts.has(rel.to)) continue;
        outbound.push({ to: rel.to, type: rel.type, weight: rel.weight, note: rel.note });
        const back = this.inbound.get(rel.to) ?? [];
        back.push({ from: concept.id, type: rel.type, weight: rel.weight });
        this.inbound.set(rel.to, back);
        edgeCount++;
      }
      this.edges.set(concept.id, outbound);
    }

    for (const concept of this.concepts.values()) {
      this.grounded.set(concept.id, this.ground(concept));
    }

    this.builtAt = new Date().toISOString();
    const groundedConcepts = [...this.grounded.values()].filter((g) => g.citations.length > 0).length;
    this.logger.log(
      `reasoning graph: ${this.concepts.size} canonical concepts, ${edgeCount} edges, ` +
        `${groundedConcepts} grounded in the corpus`,
    );
    return { concepts: this.concepts.size, edges: edgeCount, groundedConcepts, issues: result.issues.length };
  }

  /**
   * Re-ground concepts against a freshly rebuilt corpus without re-reading the
   * ontology from disk. Called after an incremental corpus re-index.
   */
  reground(): number {
    let n = 0;
    for (const concept of this.concepts.values()) {
      this.grounded.set(concept.id, this.ground(concept));
      n++;
    }
    return n;
  }

  private ground(concept: Concept): GroundedConcept {
    // Query with the concept's own vocabulary — name, aliases and the
    // observable cues — rather than its prose definition, which is dense with
    // generic filler that pulls in unrelated chunks.
    const query = [concept.name, ...concept.aliases, ...concept.observableWhen.slice(0, 3)].join(' ');
    const hits = this.index.search(query, { limit: 5, preferKinds: ['book', 'user-rule'] });
    const citations = hits.map((h) => this.index.toCitation(h));
    const sourceCount = new Set(citations.map((c) => c.sourceId)).size;

    // Grounding combines how strongly the corpus matched with how many
    // independent documents did. One book quoting a term five times is weaker
    // evidence than three books mentioning it once each.
    const avgRelevance = citations.length
      ? citations.reduce((s, c) => s + c.relevance, 0) / citations.length
      : 0;
    const breadth = Math.min(1, sourceCount / 3);
    const grounding = Number((avgRelevance * (0.6 + 0.4 * breadth)).toFixed(4));

    return { concept, citations, sourceCount, grounding };
  }

  get size(): number {
    return this.concepts.size;
  }

  get indexedAt(): string | null {
    return this.builtAt;
  }

  getConcept(id: string): Concept | null {
    return this.concepts.get(id) ?? null;
  }

  getGrounded(id: string): GroundedConcept | null {
    return this.grounded.get(id) ?? null;
  }

  /**
   * Find concepts explicitly named in a piece of text.
   *
   * Matching is on whole words against the name/alias lexicon. Substring
   * matching was rejected: "gap" appears inside "gap-fill", "margin" inside
   * "marginal", and a lexicon hit is treated as evidence downstream, so a
   * false positive here becomes a fabricated citation later.
   */
  detect(text: string): Concept[] {
    const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ')} `;
    const found = new Map<string, Concept>();
    for (const [phrase, conceptId] of this.lexicon) {
      if (haystack.includes(` ${phrase} `)) {
        const concept = this.concepts.get(conceptId);
        if (concept) found.set(conceptId, concept);
      }
    }
    return [...found.values()];
  }

  /**
   * Concepts that support a free-text query, ranked and citation-backed.
   *
   * Combines three signals: direct lexicon mentions in the query, corpus hits
   * whose text mentions a concept, and the concept's own authored confidence.
   */
  supportFor(query: string, limit = 5): SupportingConcept[] {
    const scored = new Map<string, { concept: Concept; score: number; why: string[] }>();

    const bump = (concept: Concept, amount: number, why: string) => {
      const entry = scored.get(concept.id) ?? { concept, score: 0, why: [] };
      entry.score += amount;
      entry.why.push(why);
      scored.set(concept.id, entry);
    };

    // 1. Named directly in the query — the strongest signal available.
    for (const concept of this.detect(query)) {
      bump(concept, 1, 'named in the request');
    }

    // 2. Present in the corpus text the query retrieves.
    const hits = this.index.search(query, { limit: 8 });
    for (const hit of hits) {
      for (const concept of this.detect(hit.chunk.text)) {
        bump(concept, 0.45 * hit.score, `discussed in ${hit.chunk.sourceTitle}`);
      }
    }

    // 3. One hop out from directly-named concepts, along supporting edges only.
    for (const [id, entry] of [...scored]) {
      if (!entry.why.includes('named in the request')) continue;
      for (const edge of this.edges.get(id) ?? []) {
        const spec = RELATIONS[edge.type];
        if (spec.polarity !== 'supporting') continue;
        const neighbour = this.concepts.get(edge.to);
        if (!neighbour) continue;
        bump(neighbour, 0.3 * edge.weight, readEdge(edge.type, entry.concept.name, neighbour.name));
      }
    }

    const out: SupportingConcept[] = [];
    for (const { concept, score, why } of [...scored.values()].sort((a, b) => b.score - a.score)) {
      if (out.length >= limit) break;
      const grounded = this.grounded.get(concept.id);
      // Authored confidence and corpus grounding both gate the final weight, so
      // a contested concept nobody wrote about cannot outrank an established
      // one the books discuss at length.
      const weight = Math.min(
        1,
        score * concept.confidence * (0.55 + 0.45 * (grounded?.grounding ?? 0)),
      );
      out.push({
        conceptId: concept.id,
        name: concept.name,
        relevance: `${concept.summary} (${dedupe(why).slice(0, 2).join('; ')})`,
        weight: Number(weight.toFixed(4)),
        citations: grounded?.citations.slice(0, 3) ?? [],
      });
    }
    return out;
  }

  /**
   * Walk outward from a concept, narrating each hop.
   *
   * Non-transitive relations terminate a path rather than chaining: "A
   * contradicts B, B contradicts C" says nothing whatsoever about A and C, and
   * chaining it would manufacture conflicts that the ontology never asserted.
   */
  walk(fromId: string, maxHops = 2, minConfidence = 0.15): ReasoningPath[] {
    const start = this.concepts.get(fromId);
    if (!start) return [];

    const paths: ReasoningPath[] = [];
    const visited = new Set<string>([fromId]);

    const explore = (currentId: string, steps: ReasoningStep[], confidence: number) => {
      if (steps.length >= maxHops) return;
      for (const edge of this.edges.get(currentId) ?? []) {
        if (visited.has(edge.to)) continue;
        const spec = RELATIONS[edge.type];
        const target = this.concepts.get(edge.to);
        if (!target) continue;

        const nextConfidence = confidence * edge.weight * RELATION_HOP_DECAY[edge.type];
        if (nextConfidence < minConfidence) continue;

        const from = this.concepts.get(currentId)!;
        const step: ReasoningStep = {
          from: currentId,
          to: edge.to,
          relation: edge.type,
          reads: readEdge(edge.type, from.name, target.name),
          confidence: Number(nextConfidence.toFixed(4)),
        };
        const nextSteps = [...steps, step];
        paths.push({
          target: edge.to,
          targetName: target.name,
          steps: nextSteps,
          confidence: Number(nextConfidence.toFixed(4)),
          polarity: spec.polarity,
        });

        // Only chain onward through relations the vocabulary marks transitive.
        if (spec.transitive) {
          visited.add(edge.to);
          explore(edge.to, nextSteps, nextConfidence);
          visited.delete(edge.to);
        }
      }
    };

    explore(fromId, [], 1);
    return paths.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Ontology-level tensions among a set of concepts.
   *
   * This is what lets conflict resolution distinguish "two agents disagree
   * because the market is ambiguous" from "two agents are citing concepts the
   * knowledge base explicitly says cannot both hold cleanly" — the second is a
   * real knowledge contradiction, and it is resolved from the graph rather
   * than by picking whichever agent was more confident.
   */
  tensionsAmong(conceptIds: string[]): ConceptTension[] {
    const set = new Set(conceptIds);
    const out: ConceptTension[] = [];
    const seen = new Set<string>();

    for (const id of set) {
      for (const edge of this.edges.get(id) ?? []) {
        if (edge.type !== 'contradicts' && edge.type !== 'invalidates') continue;
        if (!set.has(edge.to)) continue;
        // `contradicts` is symmetric — report the pair once.
        const key = edge.type === 'contradicts' ? [id, edge.to].sort().join('::') : `${id}->${edge.to}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const from = this.concepts.get(id)!;
        const to = this.concepts.get(edge.to)!;
        out.push({
          a: id,
          b: edge.to,
          relation: edge.type,
          note: edge.note ?? null,
          weight: edge.weight,
          reads: readEdge(edge.type, from.name, to.name),
        });
      }
    }
    return out;
  }

  /** Educational explainer text for a concept — the trader-facing prose. */
  explainerFor(conceptId: string): string | null {
    return this.concepts.get(conceptId)?.explainer ?? null;
  }

  /** Observable cues the ontology associates with a concept. */
  cuesFor(conceptId: string): string[] {
    return this.concepts.get(conceptId)?.observableWhen ?? [];
  }

  stats() {
    const byDomain: Record<string, number> = {};
    let groundedCount = 0;
    for (const concept of this.concepts.values()) {
      byDomain[concept.domain] = (byDomain[concept.domain] ?? 0) + 1;
      if ((this.grounded.get(concept.id)?.citations.length ?? 0) > 0) groundedCount++;
    }
    return {
      concepts: this.concepts.size,
      edges: [...this.edges.values()].reduce((s, e) => s + e.length, 0),
      grounded: groundedCount,
      byDomain,
      builtAt: this.builtAt,
    };
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
