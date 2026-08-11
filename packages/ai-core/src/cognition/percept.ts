import { Confidence, EntityRef } from '../domain/knowledge';

/**
 * Layer 1 vocabulary — what the platform *senses*.
 *
 * A **Percept** is the smallest unit of noticing: one perceptor, at one moment,
 * saying "this happened, and here is how much it matters". Nothing above L1 is
 * allowed to read a raw table, a websocket frame or an HTTP log directly. That
 * is the whole point of the type: every downstream layer sees one shape, so a
 * new sensor becomes available to the entire network by being registered rather
 * than by being wired into each consumer.
 *
 * WHY A PERCEPT IS NOT A MemoryRecord
 *
 * `MemoryRecord` (domain/knowledge.ts) is knowledge the system has decided to
 * keep. A percept is a raw observation that has not earned that yet — most are
 * discarded within seconds, and the ones that survive are *promoted* into memory
 * by Layer 4. Collapsing the two would mean every 5xx spike and every tick
 * writes permanent knowledge, and the store would drown in noise inside a day.
 *
 * The distinction is also what makes the network honest about time: a percept
 * has an `observedAt` (when the world did the thing) separate from when we
 * noticed it. Backfilled and replayed percepts are therefore not lies.
 */

/**
 * The domains the platform perceives.
 *
 * These are deliberately whole-application, not market-only. TradeW's operators
 * asked the same question of four different surfaces — "is this behaving, and is
 * it getting better?" — and answering it with four unrelated dashboards is what
 * produced the blind spots this network exists to close.
 */
export type PerceptDomain =
  /** Prices, structure, options chain, volatility, news, order flow. Sentinel's world. */
  | 'market'
  /** The application itself: errors, latency, stuck orders, failed AI calls, regressions. */
  | 'application'
  /** The assistant (Tara): conversation turns, intent, corrections, satisfaction. */
  | 'assistant'
  /** The knowledge pipeline: ingestion, chunking, embedding, concept promotion and decay. */
  | 'learning'
  /** The platform's own operation: jobs, leases, deploys, queue depth, service health. */
  | 'platform';

/** How often a perceptor is expected to produce. Drives the staleness alarm. */
export type PerceptorCadence =
  /** Pushed in by a producer when something happens; silence is not a fault. */
  | 'event'
  /** Polled on a fixed tick; silence past `expectedIntervalMs` IS a fault. */
  | 'interval'
  /** Runs only when explicitly asked (a backfill, an operator-triggered sweep). */
  | 'manual';

/**
 * One observation.
 *
 * `salience` and `confidence` are separate on purpose and are the two numbers
 * the rest of the network actually runs on:
 *
 *  · **salience** — how much this deserves attention *right now*. A 3% index
 *    move and a 3% move in an illiquid smallcap have the same magnitude and
 *    wildly different salience.
 *  · **confidence** — how much we believe the observation is real. A single
 *    503 is a low-confidence application percept; twelve in ten seconds is a
 *    high-confidence one.
 *
 * Merging them into one "score" is the mistake that makes a network confidently
 * chase noise: it can no longer distinguish "important and uncertain" (escalate,
 * gather more) from "unimportant and certain" (record, ignore).
 */
export interface Percept {
  id: string;
  /** `PerceptorDefinition.id` of whatever produced this. */
  perceptorId: string;
  domain: PerceptDomain;
  /**
   * Perceptor-specific event name, e.g. `error_rate_spike`, `structure_break`,
   * `user_corrected_answer`, `concept_promoted`. Namespaced by the perceptor,
   * so two perceptors may both emit `latency_regression` without colliding.
   */
  kind: string;
  /** What the percept is *about* — a symbol, a route, a concept, a user. */
  subject: EntityRef;
  /** When the world did the thing (not when we noticed). */
  observedAt: Date;
  /** 0..1 — how much attention this deserves. Gated at L1. */
  salience: number;
  /** 0..1 — how much we believe it. */
  confidence: Confidence;
  /**
   * Numeric features for L2. Keys are stable per `kind`, so the encoder can
   * build a consistent vector without knowing the perceptor.
   */
  features: Record<string, number>;
  /** Human/LLM-readable one-liner. What an operator reads in the console. */
  summary: string;
  /** Anything the perceptor wants to carry that is not a feature. Never indexed. */
  payload?: Record<string, unknown>;
  tags: string[];
  /**
   * Set when this percept is one of a collapsed burst — twelve identical 503s
   * arrive as one percept with `occurrences: 12` rather than twelve percepts.
   * Without this the network mistakes repetition for corroboration.
   */
  occurrences?: number;
}

export type NewPercept = Omit<Percept, 'id'>;

/** Static description of a sensor. Registered once; rendered in the console. */
export interface PerceptorDefinition {
  /** Stable id, e.g. `application.error-rate`. Never renamed — weights key on it. */
  id: string;
  domain: PerceptDomain;
  /** Short human label for the console. */
  label: string;
  /** What it watches and why, in one or two sentences. Shown in the UI. */
  description: string;
  cadence: PerceptorCadence;
  /**
   * For `interval` perceptors: how often it should run. Also the staleness
   * threshold — silence past 3× this is reported as a stalled sensor rather
   * than as a quiet one.
   */
  expectedIntervalMs?: number;
  /** The `kind` values this perceptor can emit. Documentation and UI grouping. */
  emits: string[];
  /**
   * Off by default for anything expensive or noisy. A registered-but-disabled
   * perceptor still appears in the console — an operator needs to see the sensor
   * they *could* turn on, not just the ones already running.
   */
  enabled: boolean;
}

/** Whatever a perceptor needs to do its job. Supplied by the host service. */
export interface SenseContext {
  /** Start of the window this pass should cover. */
  since: Date;
  /** End of the window. Normally now; set explicitly when replaying history. */
  until: Date;
  /** Correlates every percept and episode produced by one network pass. */
  passId: string;
}

export interface Perceptor {
  readonly definition: PerceptorDefinition;
  /**
   * Produce percepts for the window.
   *
   * Must be safe to call concurrently and must not throw for an empty result —
   * "nothing happened" is the common case and is returned as `[]`. A perceptor
   * that throws is quarantined by the registry rather than failing the pass;
   * one broken sensor must not blind the other twenty.
   */
  sense(context: SenseContext): Promise<NewPercept[]>;
}

/** Per-perceptor operational state. This is what the console's health column reads. */
export interface PerceptorHealth {
  perceptorId: string;
  /**
   * `healthy` — produced recently, or is an event perceptor with nothing to say.
   * `stale`   — an interval perceptor past 3× its expected interval.
   * `failing` — its last `sense()` threw.
   * `quarantined` — threw repeatedly; skipped until an operator re-enables it.
   * `disabled` — registered, deliberately off.
   */
  status: 'healthy' | 'stale' | 'failing' | 'quarantined' | 'disabled';
  lastSensedAt: Date | null;
  lastPerceptAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  perceptsLastPass: number;
  /** Rolling mean salience. A sensor whose salience collapses to ~0 is noise. */
  meanSalience: number;
  totalPercepts: number;
}

/**
 * The sensor roster.
 *
 * Holds definitions *and* health, because a roster that only lists working
 * sensors answers the wrong question. The most valuable thing this console can
 * show is a perceptor that has silently stopped producing — which is invisible
 * to any view assembled from the events that did arrive.
 */
export class PerceptorRegistry {
  private readonly perceptors = new Map<string, Perceptor>();
  private readonly health = new Map<string, PerceptorHealth>();

  /** Failures before a perceptor is skipped. Three, so a transient DB blip
   *  does not remove a sensor, but a genuine bug does not burn a slot forever. */
  private static readonly QUARANTINE_AFTER = 3;

  register(perceptor: Perceptor): void {
    const { id, enabled } = perceptor.definition;
    this.perceptors.set(id, perceptor);
    if (!this.health.has(id)) {
      this.health.set(id, {
        perceptorId: id,
        status: enabled ? 'healthy' : 'disabled',
        lastSensedAt: null,
        lastPerceptAt: null,
        consecutiveFailures: 0,
        lastError: null,
        perceptsLastPass: 0,
        meanSalience: 0,
        totalPercepts: 0,
      });
    }
  }

  get(id: string): Perceptor | undefined {
    return this.perceptors.get(id);
  }

  list(): Perceptor[] {
    return [...this.perceptors.values()];
  }

  byDomain(domain: PerceptDomain): Perceptor[] {
    return this.list().filter((p) => p.definition.domain === domain);
  }

  healthOf(id: string): PerceptorHealth | undefined {
    return this.health.get(id);
  }

  /** Every sensor's health, recomputing staleness against the clock. */
  allHealth(now = new Date()): PerceptorHealth[] {
    return [...this.health.values()].map((h) => ({ ...h, status: this.statusOf(h, now) }));
  }

  setEnabled(id: string, enabled: boolean): void {
    const perceptor = this.perceptors.get(id);
    const health = this.health.get(id);
    if (!perceptor || !health) return;
    // The definition is the source of truth for `enabled`; health mirrors it so
    // the console does not have to join two objects to render one row.
    (perceptor.definition as { enabled: boolean }).enabled = enabled;
    health.status = enabled ? 'healthy' : 'disabled';
    if (enabled) {
      // Re-enabling is also the way out of quarantine — an operator who has
      // fixed the cause should not have to restart the process.
      health.consecutiveFailures = 0;
      health.lastError = null;
    }
  }

  /**
   * Run every enabled sensor for the window.
   *
   * Uses `allSettled`, not `all`: one perceptor throwing must degrade to one
   * missing sensor, never to a blind pass. That is the difference between an
   * observability system that survives its own bugs and one that goes dark
   * exactly when something is wrong.
   */
  async sense(context: SenseContext, domain?: PerceptDomain): Promise<NewPercept[]> {
    const candidates = (domain ? this.byDomain(domain) : this.list()).filter((p) => {
      const health = this.health.get(p.definition.id);
      return p.definition.enabled && health?.status !== 'quarantined';
    });

    const settled = await Promise.allSettled(candidates.map((p) => p.sense(context)));
    const out: NewPercept[] = [];

    settled.forEach((result, i) => {
      const id = candidates[i].definition.id;
      const health = this.health.get(id);
      if (!health) return;
      health.lastSensedAt = context.until;

      if (result.status === 'rejected') {
        health.consecutiveFailures += 1;
        health.lastError = String((result.reason as Error)?.message ?? result.reason).slice(0, 500);
        health.status =
          health.consecutiveFailures >= PerceptorRegistry.QUARANTINE_AFTER ? 'quarantined' : 'failing';
        health.perceptsLastPass = 0;
        return;
      }

      const percepts = result.value;
      health.consecutiveFailures = 0;
      health.lastError = null;
      health.status = 'healthy';
      health.perceptsLastPass = percepts.length;
      if (percepts.length) {
        health.lastPerceptAt = context.until;
        health.totalPercepts += percepts.length;
        const mean = percepts.reduce((sum, p) => sum + p.salience, 0) / percepts.length;
        // Exponential moving average with a slow coefficient: a single quiet
        // pass should not erase a sensor's reputation for producing signal.
        health.meanSalience = health.meanSalience === 0 ? mean : health.meanSalience * 0.9 + mean * 0.1;
      }
      out.push(...percepts);
    });

    return out;
  }

  /** Staleness is computed on read, not written on a timer — a process with no
   *  ticker still reports the truth, and there is no background job to leak. */
  private statusOf(health: PerceptorHealth, now: Date): PerceptorHealth['status'] {
    if (health.status === 'disabled' || health.status === 'quarantined' || health.status === 'failing') {
      return health.status;
    }
    const definition = this.perceptors.get(health.perceptorId)?.definition;
    if (!definition || definition.cadence !== 'interval' || !definition.expectedIntervalMs) return 'healthy';
    if (!health.lastSensedAt) return 'stale';
    // 3×, not 1×: a single skipped tick during a GC pause or a slow query is
    // normal, and an alarm that fires on normal is an alarm operators mute.
    return now.getTime() - health.lastSensedAt.getTime() > definition.expectedIntervalMs * 3 ? 'stale' : 'healthy';
  }
}
