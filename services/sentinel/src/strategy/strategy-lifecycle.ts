import type { StrategyDetection } from '../intelligence/strategy-engine.service';

/**
 * The strategy lifecycle — Phase 3.
 *
 * Sentinel already had a state machine (`state-machine/`, Master Plan Module
 * 9), but it describes the **session**: Sentinel as a whole is in exactly one
 * of `OBSERVATION`, `SIDE_IN_FOCUS`, `MOVE_COMPLETE` and so on. That is the
 * right model for "what is Sentinel doing", and the wrong model for "what is
 * each strategy doing", because several strategies are live at once and they
 * are rarely at the same stage.
 *
 * With multi-strategy selection (Phase 2 of the reasoning consolidation) a
 * trader can pin several strategies simultaneously. A single global state then
 * has to describe an ORB retest that just confirmed and a VWAP pullback that
 * invalidated ten minutes ago with one label — so it describes neither.
 *
 * This is a SECOND, per-strategy machine that runs alongside the session one.
 * It does not replace it and does not feed it: the session machine keeps its
 * existing inputs and its existing transitions, because seven surfaces key off
 * its current semantics.
 *
 * ```
 * Watching → Forming → Confirmed → Side in Focus → Active
 *                                                    │
 *                          Momentum Weakening ◄──────┘
 *                                   │
 *                          Move Complete → Learn
 *
 *   (any state) → Invalidated → Learn
 * ```
 *
 * Every transition carries the evidence that caused it. A lifecycle that
 * changed state without saying why would be exactly the black box Sentinel
 * exists not to be.
 */

export type StrategyLifecycleState =
  | 'WATCHING' // configured, nothing matching yet
  | 'FORMING' // some rules confirmed, not all
  | 'CONFIRMED' // every mandatory rule confirmed, nothing invalidated
  | 'SIDE_IN_FOCUS' // confirmed AND cleared the publication gate
  | 'ACTIVE' // the move the setup described is underway
  | 'MOMENTUM_WEAKENING' // still active, but participation/structure is fading
  | 'MOVE_COMPLETE' // the move resolved
  | 'INVALIDATED' // an invalidation rule triggered
  | 'LEARN'; // terminal for the session; the outcome is being recorded

/**
 * States from which the lifecycle is finished for this session and the
 * outcome should be handed to the Brain.
 */
export const TERMINAL_STATES: StrategyLifecycleState[] = ['MOVE_COMPLETE', 'INVALIDATED'];

/**
 * Legal transitions.
 *
 * `INVALIDATED` is reachable from every live state — an invalidation rule can
 * trigger at any moment, and a machine that could not express that would keep
 * reporting a setup as active after it had structurally failed.
 */
const LIVE_STATES: StrategyLifecycleState[] = [
  'WATCHING',
  'FORMING',
  'CONFIRMED',
  'SIDE_IN_FOCUS',
  'ACTIVE',
  'MOMENTUM_WEAKENING',
];

const TRANSITIONS: Record<StrategyLifecycleState, StrategyLifecycleState[]> = {
  // SIDE_IN_FOCUS is reachable directly, because observations are discrete
  // samples roughly a minute apart, not a continuous stream. A setup can go
  // from partially confirmed to fully confirmed AND clear the publication gate
  // between two observations, and forcing it through an intermediate tick
  // would make the lifecycle report a state the market had already left.
  // ACTIVE is deliberately NOT reachable from here: it means the move is
  // underway, which cannot be true before a side was ever put in focus.
  WATCHING: ['FORMING', 'CONFIRMED', 'SIDE_IN_FOCUS', 'INVALIDATED'],
  // Back to WATCHING is legal: a forming setup whose partial rules stop
  // matching has not failed, it simply stopped forming. Treating that as an
  // invalidation would pollute the outcome record the Brain learns from with
  // setups that never actually triggered.
  FORMING: ['WATCHING', 'CONFIRMED', 'SIDE_IN_FOCUS', 'INVALIDATED'],
  CONFIRMED: ['SIDE_IN_FOCUS', 'ACTIVE', 'MOMENTUM_WEAKENING', 'MOVE_COMPLETE', 'INVALIDATED', 'FORMING'],
  SIDE_IN_FOCUS: ['ACTIVE', 'MOMENTUM_WEAKENING', 'MOVE_COMPLETE', 'INVALIDATED'],
  ACTIVE: ['MOMENTUM_WEAKENING', 'MOVE_COMPLETE', 'INVALIDATED'],
  // Momentum can genuinely re-accelerate; this is not a one-way door.
  MOMENTUM_WEAKENING: ['ACTIVE', 'MOVE_COMPLETE', 'INVALIDATED'],
  MOVE_COMPLETE: ['LEARN'],
  INVALIDATED: ['LEARN'],
  LEARN: [],
};

export function canTransition(from: StrategyLifecycleState, to: StrategyLifecycleState): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export interface LifecycleInput {
  detection: StrategyDetection | null;
  /** Did this strategy clear the four-condition publication gate this tick? */
  published: boolean;
  /** Phase 2 behaviour read, when available. */
  behaviour: {
    read: 'continuation' | 'reversal-risk' | 'indecision' | 'undefined';
    direction: 'bullish' | 'bearish' | 'neutral';
    strength: number;
  } | null;
  /** Price now, against `entryReference` below, to judge whether the move ran. */
  lastPrice: number | null;
  /** Price when the strategy first reached SIDE_IN_FOCUS or ACTIVE. */
  entryReference: number | null;
}

export interface LifecycleEvaluation {
  state: StrategyLifecycleState;
  previous: StrategyLifecycleState;
  changed: boolean;
  /** Why the machine is in this state — always populated. */
  reason: string;
  evidence: string[];
}

/**
 * How far the move must run from its reference before it counts as complete.
 *
 * Percentage rather than points, for the same reason liquidity tolerance is:
 * a fixed point threshold means one thing on an index and something else
 * entirely on a stock.
 */
export const MOVE_COMPLETE_PCT = 0.6;

/**
 * Advance the lifecycle by one observation.
 *
 * A pure reducer: same current state and same input always produce the same
 * next state. All persistence lives in the service that calls this, so the
 * whole machine is testable with plain objects.
 *
 * Order matters and is deliberate. Invalidation is checked FIRST, before any
 * progression, because a setup that has invalidated must never be reported as
 * advancing — checking progression first would let a strategy reach
 * MOVE_COMPLETE on the same tick its invalidation triggered, and record a
 * success the market did not give.
 */
export function evaluateLifecycle(current: StrategyLifecycleState, input: LifecycleInput): LifecycleEvaluation {
  const evidence: string[] = [];
  const settle = (next: StrategyLifecycleState, reason: string): LifecycleEvaluation => {
    // A machine that could jump anywhere is not a machine. An illegal
    // transition holds the current state and says so, rather than silently
    // corrupting the sequence the Brain will later learn from.
    if (!canTransition(current, next)) {
      return {
        state: current,
        previous: current,
        changed: false,
        reason: `${reason} (held: ${current} → ${next} is not a legal transition)`,
        evidence,
      };
    }
    return { state: next, previous: current, changed: next !== current, reason, evidence };
  };

  if (current === 'LEARN') {
    return settle('LEARN', 'Lifecycle complete for this session; the outcome has been handed to the Brain');
  }

  // --- terminal states advance to LEARN exactly once --------------------
  if (TERMINAL_STATES.includes(current)) {
    return settle('LEARN', `${current === 'INVALIDATED' ? 'Invalidated' : 'Move complete'} — recording the outcome`);
  }

  const detection = input.detection;

  // --- 1: invalidation, checked before anything else ---------------------
  if (detection && detection.invalidationsTriggered.length > 0) {
    evidence.push(...detection.invalidationsTriggered);
    return settle('INVALIDATED', `Invalidation triggered — ${detection.invalidationsTriggered.join('; ')}`);
  }

  // --- 2: the strategy stopped matching entirely -------------------------
  if (!detection) {
    if (LIVE_STATES.includes(current) && current !== 'WATCHING') {
      // Only a setup that never went live can quietly return to watching.
      // One that reached CONFIRMED or beyond and then vanished from the scan
      // has structurally failed, and saying otherwise would hide a real
      // outcome from the learning loop.
      if (current === 'FORMING') {
        return settle('WATCHING', 'The partial rule match no longer holds — the setup stopped forming');
      }
      return settle('INVALIDATED', `${current} setup is no longer detected in the scan`);
    }
    return settle('WATCHING', 'No match for this strategy in the current scan');
  }

  const total = detection.rulesMatched.length + detection.rulesUnmet.length;
  evidence.push(`${detection.rulesMatched.length}/${total} rules confirmed`, ...detection.rulesMatched);

  // --- 3: not yet fully confirmed ---------------------------------------
  if (!detection.validated || detection.rulesUnmet.length > 0) {
    if (current === 'WATCHING' || current === 'FORMING') {
      return settle(
        'FORMING',
        `Forming — ${detection.rulesMatched.length} of ${total} rules confirmed, still unmet: ${detection.rulesUnmet.join('; ')}`,
      );
    }
    // Regressed from confirmed back to partial.
    return settle('FORMING', `Rules no longer fully confirmed — ${detection.rulesUnmet.join('; ')} is unmet again`);
  }

  // --- 4: fully confirmed; how far along is the move? --------------------
  const movePct =
    input.lastPrice !== null && input.entryReference !== null && input.entryReference > 0
      ? ((input.lastPrice - input.entryReference) / input.entryReference) * 100
      : null;
  const directionalMove =
    movePct === null ? null : detection.bias === 'bearish' ? -movePct : movePct;

  if (directionalMove !== null && directionalMove >= MOVE_COMPLETE_PCT) {
    evidence.push(`Price has travelled ${directionalMove.toFixed(2)}% from the ${input.entryReference!.toFixed(1)} reference`);
    return settle('MOVE_COMPLETE', `The move this setup described has largely played out (${directionalMove.toFixed(2)}%)`);
  }

  const weakening =
    input.behaviour !== null &&
    input.behaviour.strength >= 0.35 &&
    (input.behaviour.read === 'reversal-risk' ||
      (input.behaviour.read === 'indecision' && (current === 'ACTIVE' || current === 'MOMENTUM_WEAKENING')));

  if (weakening && (current === 'ACTIVE' || current === 'MOMENTUM_WEAKENING' || current === 'SIDE_IN_FOCUS')) {
    evidence.push(`Behaviour reads ${input.behaviour!.read} at ${(input.behaviour!.strength * 100).toFixed(0)}%`);
    return settle('MOMENTUM_WEAKENING', 'Momentum weakening — structure is no longer supporting the move as it was');
  }

  if (current === 'MOMENTUM_WEAKENING' && input.behaviour?.read === 'continuation') {
    return settle('ACTIVE', 'Momentum re-established — behaviour reads as continuation again');
  }

  if (current === 'SIDE_IN_FOCUS' || current === 'ACTIVE') {
    return settle('ACTIVE', 'The setup remains confirmed and the move is underway');
  }

  // --- 5: newly confirmed ------------------------------------------------
  // SIDE_IN_FOCUS is reserved for a setup that also cleared the publication
  // gate. Confirmation alone is NOT enough to reach it — that separation is
  // the whole point of Phase 1's four conditions, and collapsing the two here
  // would let a setup reach the trader-facing state by rule match alone.
  if (input.published) {
    return settle('SIDE_IN_FOCUS', `All ${total} rules confirmed and the publication gate cleared`);
  }
  return settle('CONFIRMED', `All ${total} rules confirmed; awaiting the publication gate before a side is put in focus`);
}

/** Trader-facing label for a lifecycle state. Non-directive by construction. */
export function lifecycleLabel(state: StrategyLifecycleState): string {
  switch (state) {
    case 'WATCHING':
      return 'Watching';
    case 'FORMING':
      return 'Forming';
    case 'CONFIRMED':
      return 'Confirmed';
    case 'SIDE_IN_FOCUS':
      return 'Side in focus';
    case 'ACTIVE':
      return 'Active';
    case 'MOMENTUM_WEAKENING':
      return 'Momentum weakening';
    case 'MOVE_COMPLETE':
      return 'Move complete';
    case 'INVALIDATED':
      return 'Invalidated';
    case 'LEARN':
      return 'Learning from outcome';
  }
}
