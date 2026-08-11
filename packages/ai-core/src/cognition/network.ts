import { NewMemoryRecord } from '../domain/knowledge';
import {
  AssociationLayer,
  CognitionPorts,
  ConsolidationLayer,
  EncodingLayer,
  Hypothesis,
  PerceptionLayer,
  Proposal,
} from './layers';
import { NewPercept, Percept, PerceptDomain, PerceptorRegistry, SenseContext } from './percept';
import { NeuralLayerId, OutcomeSignal, SynapseChange, SynapseStore, SynapseStats } from './weights';

/**
 * The cognitive network — L1→L4 forward, outcomes backward.
 *
 * One object owns the whole loop so that the two halves cannot drift apart. The
 * failure this prevents is specific and was easy to walk into: a forward path
 * that lays down eligibility traces keyed one way and a feedback path that looks
 * them up another. Learning then silently does nothing, every weight sits at its
 * initial value forever, and the console shows a network that looks alive and
 * has never learned a thing. Keeping `perceive` and `reinforce` on one class
 * with one `SynapseStore` makes that mismatch impossible to express.
 *
 * ISOLATION FROM THE PLATFORM
 *
 * This class touches no database, no HTTP, no clock it was not handed, and no
 * global. Everything it needs arrives through `CognitionPorts`. That is what
 * lets the whole four-layer loop run in a unit test in milliseconds, and it is
 * why the file has no imports outside `@tradew/ai-core` — the network is a
 * primitive, and primitives that reach for infrastructure stop being reusable
 * the first time a second service needs them.
 */
export class CognitiveNetwork {
  readonly registry: PerceptorRegistry;
  readonly synapses: SynapseStore;

  private readonly l1: PerceptionLayer;
  private readonly l2: EncodingLayer;
  private readonly l3: AssociationLayer;
  private readonly l4: ConsolidationLayer;

  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly ports: CognitionPorts;

  /** Rolling per-layer counters. Reset never — the console shows lifetime work
   *  and derives rates from episode history, which is the honest split. */
  private readonly layerStats: Record<NeuralLayerId, LayerCounters> = {
    L1_PERCEPTION: emptyCounters(),
    L2_ENCODING: emptyCounters(),
    L3_ASSOCIATION: emptyCounters(),
    L4_CONSOLIDATION: emptyCounters(),
  };

  constructor(ports: CognitionPorts, options: NetworkOptions = {}) {
    this.ports = ports;
    this.now = ports.now ?? (() => new Date());
    this.newId = ports.newId ?? defaultId;
    this.registry = options.registry ?? new PerceptorRegistry();
    this.synapses = options.synapses ?? new SynapseStore();

    this.l1 = new PerceptionLayer(this.newId, options.salienceFloor);
    this.l2 = new EncodingLayer(ports.embedder);
    this.l3 = new AssociationLayer(this.synapses, this.newId, this.now, ports.concepts, ports.graph);
    this.l4 = new ConsolidationLayer(this.newId, this.now, options.promotionThreshold);
  }

  /**
   * One forward pass.
   *
   * Every stage is timed separately and every stage's failure is contained.
   * A pass that dies in L3 must still report what L1 and L2 produced — the
   * partial result is what tells an operator where the break is, and throwing
   * the whole episode away to surface one exception discards exactly the
   * evidence needed to fix it.
   */
  async perceive(options: PerceiveOptions = {}): Promise<Episode> {
    const startedAt = this.now();
    const episodeId = options.episodeId ?? this.newId();
    const since = options.since ?? new Date(startedAt.getTime() - (options.windowMs ?? 5 * 60_000));
    const context: SenseContext = { since, until: startedAt, passId: episodeId };

    const episode: Episode = {
      episodeId,
      startedAt,
      finishedAt: null,
      domain: options.domain ?? null,
      trigger: options.trigger ?? 'scheduled',
      status: 'running',
      percepts: [],
      hypotheses: [],
      proposals: [],
      remembered: [],
      rejected: [],
      gated: 0,
      collapsed: 0,
      layerTimings: {} as Record<NeuralLayerId, number>,
      error: null,
      outcome: null,
    };

    try {
      // ---- L1 -------------------------------------------------------------
      let mark = Date.now();
      const raw = options.percepts
        ? [...options.percepts, ...(await this.registry.sense(context, options.domain))]
        : await this.registry.sense(context, options.domain);
      const perception = this.l1.run(raw);
      episode.percepts = perception.accepted;
      episode.gated = perception.gated;
      episode.collapsed = perception.collapsed;
      episode.layerTimings.L1_PERCEPTION = Date.now() - mark;
      this.tally('L1_PERCEPTION', raw.length, perception.accepted.length);

      if (!perception.accepted.length) {
        // A pass with nothing above the floor is a normal, successful outcome —
        // a quiet system. Recording it as `ok` rather than skipping it is what
        // makes "the network has produced nothing for an hour" distinguishable
        // from "the network has not run for an hour".
        episode.status = 'ok';
        episode.finishedAt = this.now();
        return episode;
      }

      // ---- L2 -------------------------------------------------------------
      mark = Date.now();
      const encoded = await this.l2.run(perception.accepted);
      episode.layerTimings.L2_ENCODING = Date.now() - mark;
      this.tally('L2_ENCODING', perception.accepted.length, encoded.filter((e) => e.embedding).length);

      // ---- L3 -------------------------------------------------------------
      mark = Date.now();
      const hypotheses = await this.l3.run(encoded, episodeId);
      episode.hypotheses = hypotheses;
      episode.layerTimings.L3_ASSOCIATION = Date.now() - mark;
      this.tally('L3_ASSOCIATION', encoded.length, hypotheses.length);

      // ---- L4 -------------------------------------------------------------
      mark = Date.now();
      const consolidation = this.l4.run(hypotheses, episodeId, this.synapses);
      episode.remembered = consolidation.remembered;
      episode.proposals = consolidation.proposals;
      episode.rejected = consolidation.rejected;
      episode.layerTimings.L4_CONSOLIDATION = Date.now() - mark;
      this.tally('L4_CONSOLIDATION', hypotheses.length, consolidation.remembered.length);

      // Writing to memory is the only side effect of a pass, and it is the last
      // thing that happens. A failure here leaves the episode intact and marks
      // it degraded rather than losing the reasoning that produced it.
      for (const record of consolidation.remembered) {
        try {
          await this.ports.memory.store(record);
        } catch (err) {
          episode.status = 'degraded';
          episode.error = `memory write failed: ${errText(err)}`;
        }
      }

      if (episode.status === 'running') episode.status = 'ok';
    } catch (err) {
      episode.status = 'error';
      episode.error = errText(err);
    } finally {
      episode.finishedAt = this.now();
      this.synapses.expireTraces(episode.finishedAt);
    }

    return episode;
  }

  /**
   * Score an episode, and let the credit flow back through its traces.
   *
   * This is the half that makes the system improve rather than merely observe.
   * It is called from wherever ground truth eventually appears — an operator
   * marking a proposal useful or not, a Sentinel observation resolving against
   * the tape, a flagged bug being confirmed or closed as noise.
   *
   * `reward` is on 0..1 with **0.5 meaning neutral**, not 0. An outcome nobody
   * could judge must leave the weights untouched; encoding "unknown" as 0 would
   * teach the network that everything it has never been told about was wrong,
   * which is how a system like this quietly unlearns itself into silence.
   */
  reinforce(signal: OutcomeSignal): SynapseChange[] {
    return this.synapses.reinforce(signal);
  }

  /** Everything the console renders about the network's own state. */
  snapshot(now = this.now()): NetworkSnapshot {
    return {
      at: now,
      layers: LAYER_ORDER.map((id) => ({
        id,
        label: LAYER_LABELS[id],
        description: LAYER_DESCRIPTIONS[id],
        ...this.layerStats[id],
      })),
      perceptors: this.registry.allHealth(now),
      synapses: this.synapses.stats(now),
    };
  }

  private tally(layer: NeuralLayerId, inputs: number, outputs: number): void {
    const counters = this.layerStats[layer];
    counters.passes += 1;
    counters.inputs += inputs;
    counters.outputs += outputs;
    // Throughput ratio is the diagnostic: L3 with an output/input ratio near
    // zero is failing to associate; near ten it is associating indiscriminately.
    counters.ratio = counters.inputs ? counters.outputs / counters.inputs : 0;
  }
}

// ---------------------------------------------------------------------------

export interface NetworkOptions {
  registry?: PerceptorRegistry;
  synapses?: SynapseStore;
  salienceFloor?: number;
  promotionThreshold?: number;
}

export interface PerceiveOptions {
  /** Restrict the pass to one domain. Omit to sense everything. */
  domain?: PerceptDomain;
  /** Percepts pushed in by a producer, merged with what the registry senses. */
  percepts?: NewPercept[];
  since?: Date;
  /** Lookback when `since` is not given. Default 5 minutes. */
  windowMs?: number;
  trigger?: string;
  episodeId?: string;
}

/** One complete pass, start to finish. The unit the console lists and replays. */
export interface Episode {
  episodeId: string;
  startedAt: Date;
  finishedAt: Date | null;
  domain: PerceptDomain | null;
  trigger: string;
  /** `degraded` means the reasoning completed but a side effect did not. */
  status: 'running' | 'ok' | 'degraded' | 'error';
  percepts: Percept[];
  hypotheses: Hypothesis[];
  proposals: Proposal[];
  remembered: NewMemoryRecord[];
  rejected: Array<{ hypothesisId: string; reason: string }>;
  gated: number;
  collapsed: number;
  layerTimings: Record<NeuralLayerId, number>;
  error: string | null;
  /** Filled in later, when ground truth arrives. Null means unscored. */
  outcome: { reward: number; reason: string; observedAt: Date } | null;
}

export interface LayerCounters {
  passes: number;
  inputs: number;
  outputs: number;
  ratio: number;
}

export interface LayerView extends LayerCounters {
  id: NeuralLayerId;
  label: string;
  description: string;
}

export interface NetworkSnapshot {
  at: Date;
  layers: LayerView[];
  perceptors: ReturnType<PerceptorRegistry['allHealth']>;
  synapses: SynapseStats;
}

export const LAYER_ORDER: NeuralLayerId[] = ['L1_PERCEPTION', 'L2_ENCODING', 'L3_ASSOCIATION', 'L4_CONSOLIDATION'];

export const LAYER_LABELS: Record<NeuralLayerId, string> = {
  L1_PERCEPTION: 'Perception',
  L2_ENCODING: 'Encoding',
  L3_ASSOCIATION: 'Association',
  L4_CONSOLIDATION: 'Consolidation',
};

export const LAYER_DESCRIPTIONS: Record<NeuralLayerId, string> = {
  L1_PERCEPTION: 'Perceptors sense the market, the application, the assistant and the knowledge pipeline. Bursts collapse; low-salience noise is gated out.',
  L2_ENCODING: 'Each surviving percept becomes a stable signature plus, when an embedder is available, a semantic vector.',
  L3_ASSOCIATION: 'Encoded signals activate concepts, agents and routes through learned weights, embedding proximity and asserted graph edges.',
  L4_CONSOLIDATION: 'Corroborated, high-confidence activations become permanent memory and operator proposals. Everything else is recorded as rejected, with the reason.',
};

function emptyCounters(): LayerCounters {
  return { passes: 0, inputs: 0, outputs: 0, ratio: 0 };
}

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 500);
}

/**
 * Id fallback for hosts that do not inject one.
 *
 * `crypto.randomUUID` where it exists; otherwise a timestamp-plus-random string.
 * Not cryptographic and does not need to be — these ids correlate rows in an
 * operator console, they do not authorise anything.
 */
function defaultId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
