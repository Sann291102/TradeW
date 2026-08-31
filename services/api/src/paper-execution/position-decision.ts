import { computeTrail, effectiveStop } from './execution-risk';

/**
 * ONE decision per observation, for ONE open position.
 *
 * ## Why this is a single pure function
 *
 * The requirement it exists to satisfy is that no two components ever fight
 * over the same position. Before this, "what happens to an open position" was
 * spread across the square-off sweep, the reconcile pass and (had they been
 * built separately) a stop watcher, a target watcher and a trailing watcher.
 * Five independent writers on one row is five chances for two exits, and the
 * failure would be intermittent and load-dependent — the worst possible shape.
 *
 * So every question about an open position is answered here, once, from a
 * snapshot of facts the caller gathered. The caller then performs at most one
 * action. `PositionManagerService` is the only caller.
 *
 * ## The precedence order, and why it is this order
 *
 * When several conditions are true on the same tick, exactly one wins:
 *
 *   1. EMERGENCY   — the position cannot be managed at all (no price, dead
 *                    feed, closed session with an open position). Leaving a
 *                    position unmanaged is strictly worse than closing it, and
 *                    every rule below needs a price that this case says we do
 *                    not have.
 *   2. STOP        — the initial risk limit. It ranks above the target because
 *                    a bar that spans both is far more likely to have traded
 *                    the near side first, and because being wrong about a
 *                    stop costs money while being wrong about a target costs
 *                    profit. Asymmetric consequences, asymmetric ordering.
 *   3. TARGET      — the plan completed.
 *   4. TRAIL       — protection that has ratcheted above the initial stop.
 *                    Below the target so a move that reaches the target on the
 *                    same tick books the target rather than the trail.
 *   5. INVALIDATION— the strategy's own exit rules fired: the thesis is gone
 *                    even though price has not reached a level.
 *   6. SQUARE_OFF  — the session-time exit.
 *
 * A tick that satisfies none of them holds, and may still ratchet the trail.
 *
 * ## The one rule that is NOT about price
 *
 * A DISARMED profile still manages its open positions. `enabled` gates
 * ENTRIES; it has never meant "abandon what is already open", and the previous
 * implementation's square-off filtered on `enabled: true`, so disarming an
 * agent holding a position stranded that position with no stop, no target and
 * no square-off until a human noticed. That is the single most dangerous thing
 * an operator could do with the old console, and it looked like the safe
 * action. `decidePosition` takes no `enabled` flag at all — it cannot express
 * the bug.
 */

export type ExitReason = 'EMERGENCY' | 'STOP' | 'TARGET' | 'TRAIL' | 'INVALIDATED' | 'SQUARE_OFF';

export type PositionAction =
  | { kind: 'hold'; trail: TrailUpdate | null; detail: string }
  | { kind: 'exit'; reason: ExitReason; detail: string; trail: TrailUpdate | null };

export interface TrailUpdate {
  fromPrice: number | null;
  toPrice: number;
  triggerPrice: number;
  highWaterPrice: number;
  stepsAdvanced: number;
  totalSteps: number;
  reason: string;
}

export interface PositionFacts {
  // ---- The plan, as written at entry -------------------------------------
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  quantity: number;
  /** Premium points of favourable movement per trailing ratchet. */
  trailStepPoints: number;

  // ---- Where the trail has already got to --------------------------------
  trailPrice: number | null;
  trailSteps: number;
  highWaterPrice: number;

  // ---- Live facts the caller gathered ------------------------------------
  /** Current premium of the contract. Null when it could not be read. */
  lastPrice: number | null;
  /** Is the underlying feed alive? From `assessFreshness`. */
  feedFresh: boolean;
  /** Is the session open, per the bridge. */
  marketOpen: boolean;
  /** IST minute-of-day now. */
  minuteOfDay: number;
  /** The profile's square-off minute. */
  squareOffMinute: number;

  // ---- The strategy's own opinion ----------------------------------------
  /**
   * Exit rules that fired on the latest observation, by rule id, with the
   * rule's own note. Empty when the strategy still holds, or when no fresh
   * observation was available on this tick.
   */
  firedExitRules: { id: string; note: string }[];
}

/**
 * IST minute after which an open position is squared off regardless of the
 * profile — the exchange closes at 15:30 and a paper position carried past it
 * cannot be exited at a real price.
 */
export const HARD_SESSION_CLOSE_MINUTE = 15 * 60 + 30;

export function decidePosition(facts: PositionFacts): PositionAction {
  // ---- 1. EMERGENCY -------------------------------------------------------
  //
  // Deliberately first, and deliberately an EXIT rather than a hold. Holding
  // through an unmanageable state is a decision to carry unbounded risk for an
  // unknown duration — every level below is unenforceable without a price, so
  // "wait for the feed to come back" is indistinguishable from "no stop".
  if (facts.lastPrice == null || !(facts.lastPrice > 0)) {
    return {
      kind: 'exit',
      reason: 'EMERGENCY',
      trail: null,
      detail: 'No live premium could be read for this contract, so the stop and target are unenforceable. Flattening rather than holding an unmanaged position.',
    };
  }
  if (!facts.feedFresh) {
    return {
      kind: 'exit',
      reason: 'EMERGENCY',
      trail: null,
      detail: 'The market-data feed is not ticking, so the price this position would be managed against is stale. Flattening rather than managing on a frozen quote.',
    };
  }
  if (facts.minuteOfDay >= HARD_SESSION_CLOSE_MINUTE) {
    return {
      kind: 'exit',
      reason: 'EMERGENCY',
      trail: null,
      detail: `The session has closed (${formatIstMinute(facts.minuteOfDay)}); the position must not be carried overnight.`,
    };
  }
  if (!facts.marketOpen) {
    return {
      kind: 'exit',
      reason: 'EMERGENCY',
      trail: null,
      detail: 'The venue reports the session closed while this position is still open. Flattening at the last available price.',
    };
  }

  const price = facts.lastPrice;

  // ---- The trail is computed BEFORE the exit checks -----------------------
  //
  // …because a tick that both advances the trail and trips it must record the
  // advance. Recording only the exit would leave a journal saying the position
  // closed on a trailing level that never appears in its own trail history.
  const highWaterPrice = Math.max(facts.highWaterPrice, price);
  const computed = computeTrail({
    entryPrice: facts.entryPrice,
    highWaterPrice,
    stepPoints: facts.trailStepPoints,
  });

  let trail: TrailUpdate | null = null;
  if (computed.trailPrice != null && computed.steps > facts.trailSteps) {
    trail = {
      fromPrice: facts.trailPrice,
      toPrice: computed.trailPrice,
      triggerPrice: price,
      highWaterPrice,
      stepsAdvanced: computed.steps - facts.trailSteps,
      totalSteps: computed.steps,
      reason:
        facts.trailSteps === 0
          ? `First ${facts.trailStepPoints}-point step booked; protection moves to breakeven at ${computed.trailPrice.toFixed(2)}.`
          : `${computed.steps - facts.trailSteps} further step(s) booked at a ${highWaterPrice.toFixed(2)} high; protection moves ${facts.trailPrice?.toFixed(2) ?? 'none'} → ${computed.trailPrice.toFixed(2)}.`,
    };
  }

  // The level the trail is AT on this tick, whether or not it just moved.
  const liveTrail = computed.trailPrice ?? facts.trailPrice;

  // ---- 2. STOP ------------------------------------------------------------
  if (price <= facts.stopPrice) {
    return {
      kind: 'exit',
      reason: 'STOP',
      trail,
      detail: `Premium ${price.toFixed(2)} is at or below the initial stop ${facts.stopPrice.toFixed(2)}.`,
    };
  }

  // ---- 3. TARGET ----------------------------------------------------------
  if (price >= facts.targetPrice) {
    return {
      kind: 'exit',
      reason: 'TARGET',
      trail,
      detail: `Premium ${price.toFixed(2)} reached the target ${facts.targetPrice.toFixed(2)}.`,
    };
  }

  // ---- 4. TRAIL -----------------------------------------------------------
  //
  // Only meaningful once the trail is ABOVE the initial stop — below it the
  // stop check above has already fired, and treating a trail under the stop as
  // a trigger would report a stop-out as a trailing exit in the journal.
  const stop = effectiveStop(facts.stopPrice, liveTrail);
  if (liveTrail != null && stop > facts.stopPrice && price <= stop) {
    return {
      kind: 'exit',
      reason: 'TRAIL',
      trail,
      detail: `Premium ${price.toFixed(2)} fell through the trailing level ${stop.toFixed(2)} after peaking at ${highWaterPrice.toFixed(2)}.`,
    };
  }

  // ---- 5. INVALIDATION / REVERSAL ----------------------------------------
  //
  // The strategy's own exit rules. Ranked below every price level because a
  // position that has already reached its target has completed regardless of
  // what structure now says, and one that has hit its stop is out either way.
  if (facts.firedExitRules.length > 0) {
    return {
      kind: 'exit',
      reason: 'INVALIDATED',
      trail,
      detail:
        `The strategy's own exit condition fired: ` +
        facts.firedExitRules.map((r) => `${r.id} (${r.note})`).join('; ') +
        '. The reasoning behind the position no longer holds.',
    };
  }

  // ---- 6. SQUARE-OFF ------------------------------------------------------
  if (facts.minuteOfDay >= facts.squareOffMinute) {
    return {
      kind: 'exit',
      reason: 'SQUARE_OFF',
      trail,
      detail: `${formatIstMinute(facts.minuteOfDay)} is at or past this profile's ${formatIstMinute(facts.squareOffMinute)} square-off.`,
    };
  }

  // ---- Hold ---------------------------------------------------------------
  const unrealized = (price - facts.entryPrice) * facts.quantity;
  return {
    kind: 'hold',
    trail,
    detail:
      `Holding at ${price.toFixed(2)} (${unrealized >= 0 ? '+' : ''}${unrealized.toFixed(0)}); ` +
      `stop ${stop.toFixed(2)}${liveTrail != null && stop > facts.stopPrice ? ' (trailing)' : ''}, target ${facts.targetPrice.toFixed(2)}.`,
  };
}

function formatIstMinute(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}
