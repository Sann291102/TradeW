import { NewPercept, Perceptor, PerceptorDefinition, SenseContext } from '@tradew/ai-core';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Shared machinery for the Postgres-backed perceptors.
 *
 * Every perceptor in this folder answers the same shape of question — "compared
 * to how this normally behaves, is the last few minutes unusual, and by how
 * much?" — against a different table. The parts worth sharing are not the
 * queries but the *judgement*: how a raw delta becomes a salience, and how a
 * sample size becomes a confidence. Those two conversions decide what the entire
 * network pays attention to, and having each perceptor invent its own is how a
 * system ends up with one sensor that screams at everything and another that
 * never speaks.
 */

/** Base class holding the shared conversions and the definition. */
export abstract class PrismaPerceptor implements Perceptor {
  constructor(
    readonly definition: PerceptorDefinition,
    protected readonly prisma: PrismaService,
  ) {}

  abstract sense(context: SenseContext): Promise<NewPercept[]>;

  /**
   * How unusual is `value` against `baseline`, as a 0..1 salience.
   *
   * A ratio, not a difference, and log-scaled. The difference is wrong because
   * an error rate going 0.1% → 1% and 40% → 41% are both "+0.9pp" and are not
   * remotely the same event. The log is what keeps a 100× outlier from pinning
   * salience at 1.0 the same way a 10× one does, which would make the network
   * unable to rank two simultaneous incidents.
   *
   * `floor` guards against a near-zero baseline turning any activity at all into
   * a maximal alarm — the first request after a quiet night must not read as an
   * infinite regression.
   */
  protected deviationSalience(value: number, baseline: number, floor = 0.001): number {
    const safeBaseline = Math.max(baseline, floor);
    if (value <= safeBaseline) return 0;
    const ratio = value / safeBaseline;
    // log2(ratio) / 4 → a 16× deviation reaches 1.0. Chosen because in practice
    // a 16× jump in any of these signals is unambiguously an incident, and
    // anything past that does not need finer resolution to act on.
    return clamp01(Math.log2(ratio) / 4);
  }

  /**
   * How much to believe a measurement taken from `n` samples.
   *
   * Saturating rather than linear: confidence should climb steeply over the
   * first handful of observations and then flatten, because the difference
   * between 2 and 10 samples is enormous and the difference between 200 and
   * 1000 is not. `n / (n + k)` with k = 8 puts roughly 0.5 confidence at eight
   * samples, which is about where a rate over a five-minute window stops being
   * an anecdote.
   */
  protected sampleConfidence(n: number, k = 8): number {
    if (n <= 0) return 0;
    return clamp01(n / (n + k));
  }

  /** Percept skeleton, so each perceptor states only what is specific to it. */
  protected percept(fields: Omit<NewPercept, 'perceptorId' | 'domain' | 'tags'> & { tags?: string[] }): NewPercept {
    return {
      perceptorId: this.definition.id,
      domain: this.definition.domain,
      tags: [this.definition.domain, ...(fields.tags ?? [])],
      ...fields,
    };
  }
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}

/**
 * The window immediately preceding the one being sensed, of the same length.
 *
 * Used as the comparison baseline everywhere. It is a deliberately *short*
 * baseline: a long one (yesterday, last week) is a better statistical reference
 * and a worse operational one, because it takes hours to react to a change in
 * regime and the console's whole purpose is to react in minutes. The cost is
 * that a slow drift is invisible to these perceptors — that is what the weight
 * history and the episode trend are for.
 */
export function priorWindow(context: SenseContext): { since: Date; until: Date } {
  const length = context.until.getTime() - context.since.getTime();
  return { since: new Date(context.since.getTime() - length), until: context.since };
}
