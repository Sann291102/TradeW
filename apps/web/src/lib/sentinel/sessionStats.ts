/**
 * The session's numbers, aggregated across every watch the user is running.
 *
 * ── WHY THIS IS A SEPARATE, PURE MODULE ────────────────────────────────────
 * The reference design puts eight figures in a grid, which is exactly the
 * shape that invites a plausible-looking number into a slot with no data
 * behind it. Every field here is therefore derived from something
 * `services/sentinel-py` actually recorded — a watch state, or a completed
 * outcome in a strategy's performance funnel — and a figure with no sample
 * behind it is `null`, which the tiles render as "—".
 *
 * Two rules the vault has paid for twice (see the Sentinel publication-gate
 * and CE-fabrication notes) are load-bearing here:
 *
 *  1. **A rate never travels without its sample size.** A 100% win rate over
 *     one outcome and a 68% win rate over fifty are not the same claim, and a
 *     lone percentage cannot tell them apart. `winRate` therefore carries
 *     `decided`, and the tile renders both.
 *
 *  2. **Nothing here is simulated.** The reference mock labels two tiles
 *     "(Simulated)". These are not: they are the user's own recorded watch
 *     outcomes. The labels say so rather than inheriting the mock's wording.
 *
 * Pure and framework-free so it can be asserted in the node-environment
 * suite — the arithmetic is where a wrong number would come from, not the
 * rendering.
 */

import type { StrategyPerformance, WatchSummary } from './sentinelPy';

export interface SessionStatsModel {
  /** Watches whose mandatory conditions are all currently met. */
  confirmed: number;
  /** Watches the user has recorded a position on. */
  openPositions: number;
  /** Watches still being evaluated (IDLE or FORMING). */
  watching: number;
  /** Completed outcomes that reached the user's own projected level. */
  reachedProjected: number;
  /** Completed outcomes that reached the user's own invalidation level. */
  reachedInvalidation: number;
  /** Setups that gave a met condition back before confirming. */
  steppedBack: number;
  /**
   * Share of DECIDED outcomes that reached the projected level, 0..1, or null
   * when nothing has been decided yet. `decided` is the denominator and is
   * always rendered beside it — see rule 1 above.
   */
  winRate: number | null;
  decided: number;
  /**
   * Average R per completed outcome, weighted by each strategy's completed
   * count. Null until at least one outcome has completed.
   *
   * This is expectancy — realised R over the risk the USER declared — not a
   * projected reward:risk. A ratio Sentinel projected would be a target, and
   * Sentinel does not set targets.
   */
  expectancy: number | null;
  /** Total completed outcomes behind `expectancy`. */
  completed: number;
  /**
   * True when no strategy in the set has enough history for its own engine to
   * call the numbers meaningful. The tiles still show them — hiding a real
   * figure is its own dishonesty — but flagged as a small sample.
   */
  thinSample: boolean;
}

export const EMPTY_SESSION_STATS: SessionStatsModel = {
  confirmed: 0,
  openPositions: 0,
  watching: 0,
  reachedProjected: 0,
  reachedInvalidation: 0,
  steppedBack: 0,
  winRate: null,
  decided: 0,
  expectancy: null,
  completed: 0,
  thinSample: true,
};

/**
 * Fold the watch list and one performance record per distinct strategy into
 * the session's figures.
 *
 * `performances` is keyed by strategy, NOT by watch: a strategy's funnel
 * already counts every watch that ran on it, so summing per-watch would count
 * the same outcome once per watch sharing a strategy. Callers pass the
 * de-duplicated set.
 */
export function buildSessionStats(
  watches: WatchSummary[],
  performances: StrategyPerformance[],
): SessionStatsModel {
  const confirmed = watches.filter((w) => w.state === 'CONFIRMED').length;
  const openPositions = watches.filter((w) => w.state === 'IN_TRADE').length;
  const watching = watches.filter((w) => w.state === 'IDLE' || w.state === 'FORMING').length;

  let reachedProjected = 0;
  let reachedInvalidation = 0;
  let steppedBack = 0;
  let completed = 0;
  let rSum = 0;
  let rWeight = 0;

  for (const p of performances) {
    reachedProjected += p.outcomes.reachedProjected;
    reachedInvalidation += p.outcomes.reachedInvalidation;
    steppedBack += p.funnel.rejections;
    completed += p.r.completed;
    // Expectancy is a per-strategy mean, so combining two strategies means
    // weighting each by the outcomes it was computed from. An unweighted
    // average would let one strategy with a single lucky outcome outvote
    // another with forty.
    if (p.r.expectancy != null && p.r.completed > 0) {
      rSum += p.r.expectancy * p.r.completed;
      rWeight += p.r.completed;
    }
  }

  const decided = reachedProjected + reachedInvalidation;

  return {
    confirmed,
    openPositions,
    watching,
    reachedProjected,
    reachedInvalidation,
    steppedBack,
    winRate: decided > 0 ? reachedProjected / decided : null,
    decided,
    expectancy: rWeight > 0 ? rSum / rWeight : null,
    completed,
    // `sufficient` is the engine's own judgement about sample size; the
    // frontend does not invent a second threshold beside it.
    thinSample: performances.length === 0 || performances.every((p) => !p.sufficient),
  };
}

/** The distinct strategies behind a watch list — what to fetch performance for. */
export function strategyIdsOf(watches: WatchSummary[]): string[] {
  return Array.from(new Set(watches.map((w) => w.strategyId).filter(Boolean)));
}
