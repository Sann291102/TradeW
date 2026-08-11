import { EntityRef, NewMemoryRecord } from '../domain/knowledge';
import { KnowledgeGraph } from '../graph/interfaces';
import { MemoryStore } from '../memory/interfaces';
import { NewPercept, Percept, PerceptDomain } from './percept';
import { NeuralLayerId, SynapseStore } from './weights';

/**
 * The four layers.
 *
 * WHY FOUR, AND WHY THESE FOUR
 *
 * The count is not decoration. Each boundary exists because the two sides fail
 * differently and have to be observable — and fixable — separately:
 *
 *  **L1 Perception** — sensing. Fails by going *silent* or by *flooding*.
 *  **L2 Encoding** — turning an observation into comparable numbers. Fails by
 *      encoding two different things identically, or the same thing two ways.
 *  **L3 Association** — connecting an encoded observation to what is already
 *      known. Fails by connecting everything to everything (no discrimination)
 *      or nothing to anything (no recall).
 *  **L4 Consolidation** — deciding what to keep, what to propose, and how to
 *      update the weights. Fails by remembering noise or by never learning.
 *
 * Collapse any pair and one of those failures becomes undiagnosable from the
 * outside — which is precisely the state the platform was in before this
 * existed. The admin console renders these four as four rows for the same
 * reason: an operator's first question is always "which stage broke".
 *
 * DATA FLOWS FORWARD, CREDIT FLOWS BACK
 *
 * A pass runs L1 → L2 → L3 → L4 and produces an episode. Later — minutes or
 * days — an outcome arrives for that episode and flows *backward* through the
 * eligibility traces laid down on the way forward, adjusting weights. The two
 * directions are deliberately decoupled in time, because almost nothing this
 * platform observes can be scored at the moment it is observed.
 */

// ---------------------------------------------------------------------------
// Ports. Narrow on purpose: the network must be constructible in a unit test
// with three small fakes, or nobody will test it.
// ---------------------------------------------------------------------------

export interface EmbedderPort {
  embed(texts: string[]): Promise<number[][]>;
}

/** What L3 is allowed to know about the concept layer. */
export interface ConceptPort {
  /** Concepts semantically near a piece of text. */
  related(text: string, limit: number): Promise<Array<{ id: string; label: string; score: number }>>;
}

export interface CognitionPorts {
  memory: MemoryStore;
  graph?: KnowledgeGraph;
  embedder?: EmbedderPort;
  concepts?: ConceptPort;
  /** Injected for determinism in tests. */
  now?: () => Date;
  /** Injected for determinism in tests. */
  newId?: () => string;
}

// ---------------------------------------------------------------------------
// L1 — Perception
// ---------------------------------------------------------------------------

export interface PerceptionResult {
  accepted: Percept[];
  /** Dropped below the salience floor. Counted, not kept — the count is what
   *  tells an operator the gate is set too high or a sensor has gone to noise. */
  gated: number;
  /** Bursts collapsed into a single percept with `occurrences > 1`. */
  collapsed: number;
}

/**
 * Normalise, deduplicate and gate raw sensor output.
 *
 * The salience floor is the network's attention budget. Without it every 200 OK
 * and every unchanged tick would propagate through three more layers and into
 * permanent memory, and the cost of thinking would scale with traffic rather
 * than with how much is actually happening.
 */
export class PerceptionLayer {
  readonly id: NeuralLayerId = 'L1_PERCEPTION';

  constructor(
    private readonly newId: () => string,
    /** Percepts below this are counted and dropped. 0.15 keeps roughly the top
     *  third of a normal window — low enough that a genuinely novel weak signal
     *  survives, high enough that steady-state operation is quiet. */
    private readonly salienceFloor = 0.15,
  ) {}

  run(raw: NewPercept[]): PerceptionResult {
    // Collapse identical observations within the pass. The key excludes
    // `observedAt` on purpose: twelve 503s on the same route in one window are
    // one fact with a count, not twelve corroborating facts. Treating them as
    // twelve is how a single flapping dependency comes to dominate a network.
    const buckets = new Map<string, { percept: NewPercept; count: number; peakSalience: number }>();
    for (const percept of raw) {
      const key = `${percept.perceptorId}|${percept.kind}|${percept.subject.type}:${percept.subject.id}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.count += percept.occurrences ?? 1;
        existing.peakSalience = Math.max(existing.peakSalience, percept.salience);
        // Keep the most recent observation as the representative, so the
        // summary an operator reads describes the latest state.
        if (percept.observedAt > existing.percept.observedAt) existing.percept = percept;
      } else {
        buckets.set(key, { percept, count: percept.occurrences ?? 1, peakSalience: percept.salience });
      }
    }

    const accepted: Percept[] = [];
    let gated = 0;
    let collapsed = 0;

    for (const bucket of buckets.values()) {
      if (bucket.count > 1) collapsed += 1;
      // Repetition raises salience, but with a log so a hundred repeats is not
      // a hundred times more important than one — it is about seven.
      const salience = clamp01(bucket.peakSalience * (1 + Math.log10(bucket.count) * 0.5));
      if (salience < this.salienceFloor) {
        gated += 1;
        continue;
      }
      accepted.push({ ...bucket.percept, id: this.newId(), salience, occurrences: bucket.count });
    }

    // Highest salience first: everything downstream is budgeted, and a budget
    // spent in arrival order is a budget spent on whatever was loudest first.
    accepted.sort((a, b) => b.salience - a.salience);
    return { accepted, gated, collapsed };
  }
}

// ---------------------------------------------------------------------------
// L2 — Encoding
// ---------------------------------------------------------------------------

export interface EncodedPercept {
  percept: Percept;
  /**
   * Stable symbolic address of this observation, used as a synapse endpoint:
   * `percept:<perceptorId>/<kind>`. Symbolic rather than the embedding, because
   * a weight keyed on a float vector cannot be read, diffed, or explained.
   */
  signature: string;
  /** Named numeric features, normalised to 0..1 where the range is known. */
  features: Record<string, number>;
  /** Semantic vector, when an embedder is wired. Absent is a supported state. */
  embedding?: number[];
  /** Overall activation strength of this percept, 0..1. Drives coactivation. */
  activation: number;
}

/**
 * Turn percepts into comparable representations.
 *
 * Two encodings, both kept, because they answer different questions. The
 * **signature** answers "have we seen this exact kind of thing before", which is
 * what weights need and what an operator can read. The **embedding** answers
 * "have we seen anything *like* this", which is what finds the connection nobody
 * thought to name. Keeping only the first makes the network unable to generalise;
 * keeping only the second makes it unable to explain itself.
 *
 * Embedding is best-effort. A provider outage degrades L3 to symbolic-only
 * association rather than failing the pass — a partially-thinking network beats
 * one that stops because a vendor is down.
 */
export class EncodingLayer {
  readonly id: NeuralLayerId = 'L2_ENCODING';

  constructor(private readonly embedder?: EmbedderPort) {}

  async run(percepts: Percept[]): Promise<EncodedPercept[]> {
    let embeddings: number[][] | undefined;
    if (this.embedder && percepts.length) {
      try {
        embeddings = await this.embedder.embed(percepts.map((p) => p.summary));
      } catch {
        // Deliberately swallowed: see the class comment. The absence shows up in
        // the console as an encoding pass with no vectors, which is the signal.
        embeddings = undefined;
      }
    }

    return percepts.map((percept, i) => ({
      percept,
      signature: `percept:${percept.perceptorId}/${percept.kind}`,
      features: normaliseFeatures(percept.features),
      embedding: embeddings?.[i],
      // Salience says "pay attention", confidence says "believe it". Their
      // product is how strongly this should actually drive learning — a loud
      // observation we do not trust must not move weights much.
      activation: clamp01(percept.salience * percept.confidence),
    }));
  }
}

// ---------------------------------------------------------------------------
// L3 — Association
// ---------------------------------------------------------------------------

export interface Activation {
  /** The thing that lit up: `concept:...`, `agent:...`, `route:...`, `symbol:...`. */
  target: string;
  label: string;
  /** 0..1 — how strongly, after the synaptic weight is applied. */
  strength: number;
  /** Which encoded percepts drove it. The explanation, kept structurally. */
  sources: string[];
  /** `learned` came through a weight; `semantic` came from embedding proximity. */
  via: 'learned' | 'semantic' | 'graph';
}

export interface Hypothesis {
  id: string;
  /** One line an operator can act on. */
  statement: string;
  domain: PerceptDomain;
  /** 0..1 — the network's belief, before any outcome has scored it. */
  confidence: number;
  /** What lit up to produce it. */
  activations: Activation[];
  /** Percept ids that contributed. */
  perceptIds: string[];
  /**
   * True when more than one *independent perceptor* contributed. Single-source
   * hypotheses are kept but never promoted — the corroboration requirement is
   * the same one the publication gate applies to Sentinel, for the same reason:
   * one sensor agreeing with itself is not evidence.
   */
  corroborated: boolean;
}

/**
 * Connect what was just perceived to what is already known.
 *
 * Three association routes, deliberately: **learned** (a synapse that past
 * outcomes have strengthened), **semantic** (embedding proximity to a known
 * concept), and **graph** (an explicit edge someone or something asserted).
 * They disagree often, and that disagreement is informative — a strong semantic
 * match with a weak learned weight means "this looks related and has never once
 * paid off", which is exactly the pattern a network should stop chasing.
 */
export class AssociationLayer {
  readonly id: NeuralLayerId = 'L3_ASSOCIATION';

  constructor(
    private readonly synapses: SynapseStore,
    private readonly newId: () => string,
    private readonly now: () => Date,
    private readonly concepts?: ConceptPort,
    private readonly graph?: KnowledgeGraph,
  ) {}

  async run(encoded: EncodedPercept[], episodeId: string): Promise<Hypothesis[]> {
    const now = this.now();
    // target -> activation being accumulated
    const activations = new Map<string, Activation>();
    // target -> the set of perceptors that contributed, for corroboration
    const contributors = new Map<string, Set<string>>();

    const bump = (target: string, label: string, strength: number, source: string, via: Activation['via'], perceptorId: string) => {
      const existing = activations.get(target);
      if (existing) {
        // Probabilistic OR rather than a sum: two weak independent signals should
        // combine to "somewhat likely", not to a number above 1 that then has to
        // be clamped — clamping destroys the ordering that made it useful.
        existing.strength = existing.strength + strength - existing.strength * strength;
        if (!existing.sources.includes(source)) existing.sources.push(source);
      } else {
        activations.set(target, { target, label, strength, sources: [source], via });
      }
      const set = contributors.get(target) ?? new Set<string>();
      set.add(perceptorId);
      contributors.set(target, set);
    };

    for (const item of encoded) {
      const { signature, activation, percept } = item;

      // 1. Learned — the strongest outgoing synapses from this signature.
      for (const synapse of this.synapses.from(signature, 'L3_ASSOCIATION', 12, now)) {
        const strength = clamp01(activation * synapse.weight);
        if (strength < 0.05) continue;
        bump(synapse.target, synapse.target, strength, signature, 'learned', percept.perceptorId);
        this.synapses.activate({ source: signature, target: synapse.target, layer: 'L3_ASSOCIATION' }, strength, episodeId, now);
      }

      // 2. Semantic — concepts near the text. New associations are *created*
      //    here at their initial weight, which is how the network acquires links
      //    nobody declared. They stay weak until an outcome pays them off.
      if (this.concepts) {
        try {
          const near = await this.concepts.related(percept.summary, 5);
          for (const concept of near) {
            const target = `concept:${concept.id}`;
            const learned = this.synapses.weightOf({ source: signature, target, layer: 'L3_ASSOCIATION' }, now);
            const strength = clamp01(activation * concept.score * learned);
            if (strength < 0.05) continue;
            bump(target, concept.label, strength, signature, 'semantic', percept.perceptorId);
            this.synapses.activate({ source: signature, target, layer: 'L3_ASSOCIATION' }, strength, episodeId, now);
          }
        } catch {
          /* concept store unavailable — degrade to learned + graph, as above */
        }
      }

      // 3. Graph — asserted edges from the percept's subject.
      if (this.graph) {
        try {
          const node = await this.graph.getNode(percept.subject.id);
          if (node) {
            const neighbours = await this.graph.neighbors({ nodeId: node.id, direction: 'both', limit: 8 });
            for (const { node: peer, edge } of neighbours) {
              const target = `${peer.entity.type}:${peer.entity.id}`;
              const strength = clamp01(activation * edge.weight);
              if (strength < 0.05) continue;
              bump(target, peer.entity.label ?? peer.entity.id, strength, signature, 'graph', percept.perceptorId);
            }
          }
        } catch {
          /* graph unavailable — the other two routes still produce a result */
        }
      }
    }

    // One hypothesis per activated target, strongest first.
    const ranked = [...activations.values()].sort((a, b) => b.strength - a.strength).slice(0, 25);

    return ranked.map((activation) => {
      const perceptorCount = contributors.get(activation.target)?.size ?? 1;
      const perceptIds = encoded
        .filter((e) => activation.sources.includes(e.signature))
        .map((e) => e.percept.id);
      const domain = encoded.find((e) => activation.sources.includes(e.signature))?.percept.domain ?? 'platform';
      return {
        id: this.newId(),
        statement: `${activation.label} activated by ${activation.sources.length} signal${activation.sources.length === 1 ? '' : 's'} (${activation.via})`,
        domain,
        confidence: activation.strength,
        activations: [activation],
        perceptIds,
        corroborated: perceptorCount > 1,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// L4 — Consolidation
// ---------------------------------------------------------------------------

/**
 * Something the network thinks a human should decide.
 *
 * **Proposals are never executed by the network.** ARCHITECTURE Rule 2 puts AI
 * services outside the order path entirely, and the same logic applies to the
 * rest of the platform: a system that learns from outcomes and also causes them
 * closes a loop nobody is supervising. So L4's most consequential output is a
 * row in a queue with a status of `pending`, and an operator is the actuator.
 */
export interface Proposal {
  id: string;
  domain: PerceptDomain;
  /**
   * `investigate` — a human should look at this (a bug, a regression).
   * `tune`        — a threshold or weight looks wrong.
   * `learn`       — knowledge worth ingesting was spotted.
   * `notify`      — someone should be told.
   *
   * There is deliberately no `execute`.
   */
  kind: 'investigate' | 'tune' | 'learn' | 'notify';
  title: string;
  rationale: string;
  confidence: number;
  hypothesisIds: string[];
  perceptIds: string[];
  createdAt: Date;
}

export interface ConsolidationResult {
  /** Hypotheses promoted into permanent memory. */
  remembered: NewMemoryRecord[];
  proposals: Proposal[];
  /** Hypotheses that failed the promotion bar, with the reason. */
  rejected: Array<{ hypothesisId: string; reason: string }>;
}

/**
 * Decide what survives.
 *
 * The promotion bar mirrors Sentinel's publication gate rather than inventing a
 * second standard: **confidence ≥ threshold AND corroborated by more than one
 * perceptor**. Two gates on one decision looks redundant until you watch a
 * single miscalibrated sensor produce a stream of 0.9-confidence nonsense — the
 * corroboration requirement is what stops that becoming permanent knowledge,
 * and no confidence threshold alone can.
 */
export class ConsolidationLayer {
  readonly id: NeuralLayerId = 'L4_CONSOLIDATION';

  constructor(
    private readonly newId: () => string,
    private readonly now: () => Date,
    /** Matches the Sentinel publication threshold; see the vault note. */
    private readonly promotionThreshold = 0.7,
  ) {}

  run(hypotheses: Hypothesis[], episodeId: string, synapses: SynapseStore): ConsolidationResult {
    const now = this.now();
    const remembered: NewMemoryRecord[] = [];
    const proposals: Proposal[] = [];
    const rejected: Array<{ hypothesisId: string; reason: string }> = [];

    for (const hypothesis of hypotheses) {
      if (hypothesis.confidence < this.promotionThreshold) {
        rejected.push({ hypothesisId: hypothesis.id, reason: `confidence ${hypothesis.confidence.toFixed(2)} below ${this.promotionThreshold}` });
        continue;
      }
      if (!hypothesis.corroborated) {
        rejected.push({ hypothesisId: hypothesis.id, reason: 'single perceptor — not corroborated' });
        continue;
      }

      remembered.push({
        summary: hypothesis.statement,
        content: [
          hypothesis.statement,
          '',
          `Domain: ${hypothesis.domain}`,
          `Confidence: ${hypothesis.confidence.toFixed(3)}`,
          `Episode: ${episodeId}`,
          `Activations: ${hypothesis.activations.map((a) => `${a.target} (${a.via}, ${a.strength.toFixed(2)})`).join(', ')}`,
        ].join('\n'),
        source: { kind: 'observation', reference: episodeId },
        confidence: hypothesis.confidence,
        tags: ['cognition', hypothesis.domain, 'consolidated'],
        entities: hypothesis.activations.map<EntityRef>((a) => ({
          type: a.target.split(':')[0] ?? 'concept',
          id: a.target,
          label: a.label,
        })),
        relatedIds: [],
        userId: null,
        namespace: 'cognition',
      });

      // L4 records its own association: this hypothesis's targets are now linked
      // to the episode, and the outcome that eventually scores the episode will
      // flow back to exactly these edges.
      for (const activation of hypothesis.activations) {
        synapses.activate(
          { source: `episode:${episodeId}`, target: activation.target, layer: 'L4_CONSOLIDATION' },
          hypothesis.confidence,
          episodeId,
          now,
        );
      }

      const proposal = this.proposalFor(hypothesis, now);
      if (proposal) proposals.push(proposal);
    }

    return { remembered, proposals, rejected };
  }

  /**
   * Map a promoted hypothesis to the action a human should consider.
   *
   * Domain-routed rather than model-generated: the routing has to be stable and
   * auditable, and an LLM deciding "is this a bug or a market observation" would
   * be a non-deterministic step in the one part of the pipeline that produces
   * work for people.
   */
  private proposalFor(hypothesis: Hypothesis, now: Date): Proposal | null {
    const base = {
      id: this.newId(),
      domain: hypothesis.domain,
      confidence: hypothesis.confidence,
      hypothesisIds: [hypothesis.id],
      perceptIds: hypothesis.perceptIds,
      createdAt: now,
      rationale: hypothesis.statement,
    };

    switch (hypothesis.domain) {
      case 'application':
      case 'platform':
        return { ...base, kind: 'investigate', title: `Investigate: ${hypothesis.statement}` };
      case 'learning':
        return { ...base, kind: 'learn', title: `Ingest: ${hypothesis.statement}` };
      case 'assistant':
        return { ...base, kind: 'tune', title: `Tune assistant behaviour: ${hypothesis.statement}` };
      case 'market':
        // Market hypotheses are never proposals. Sentinel owns what reaches a
        // trader, through its own publication gate; a second path to the user
        // from a system with no compliance review is exactly the thing
        // ARCHITECTURE Rule 2 forbids. It is remembered, and that is all.
        return null;
      default:
        return null;
    }
  }
}

// ---------------------------------------------------------------------------

function normaliseFeatures(features: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(features)) {
    // Non-finite values come from division by an empty window and would poison
    // every downstream average. Zero is the honest substitute for "no data".
    out[key] = Number.isFinite(value) ? value : 0;
  }
  return out;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}
