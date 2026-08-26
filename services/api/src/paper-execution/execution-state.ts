/**
 * The execution state machine — which states may execute, in which engine, and
 * which transitions are legal.
 *
 * Pure and dependency-free, exactly like `execution-policy.ts` and
 * `execution-account.ts`: the caller reads the row, this decides. That split is
 * what lets every rule below be asserted without a database, and it keeps the
 * one question that matters — "may this profile place an order right now, and
 * against which engine?" — answerable by reading a single file.
 *
 * ## Why this replaced a boolean
 *
 * `ExecutionProfile.enabled` was the entire authorization model. It answered
 * "armed" and conflated six situations that a trading operator must be able to
 * tell apart: never armed, armed but never run, running, qualified for live,
 * live-armed, paused, stood down, faulted. The console rendered all of them as
 * one green pill, which is the specific misreading §23 calls out — "avoid
 * ambiguous green 'active' indicators when the system is actually disabled".
 *
 * ## THE SAFETY PROPERTY THIS FILE EXISTS FOR
 *
 * `environmentFor` is the only function in the codebase that answers "paper or
 * live", and it answers LIVE for exactly two states. Everything downstream —
 * the adapter resolver, the broker adapter's own re-check, the policy gate —
 * asks this function rather than reading `ExecutionProfile.environment`. So a
 * profile whose `environment` column has been flipped to LIVE by a direct SQL
 * edit, a restore, or a bug still cannot reach the broker: its STATE decides,
 * and a state can only reach LIVE_ARMED through `ARM_LIVE`, which requires a
 * passed qualification and an administrator.
 */

export type ExecutionProfileState =
  | 'DISABLED'
  | 'PAPER_ARMED'
  | 'PAPER_RUNNING'
  | 'PAPER_QUALIFIED'
  | 'LIVE_ARMED'
  | 'LIVE_RUNNING'
  | 'PAUSED'
  | 'DISARMED'
  | 'ERROR';

export type ExecutionEnvironmentName = 'PAPER' | 'LIVE';

/**
 * States in which the PAPER engine may execute.
 *
 * PAPER_QUALIFIED is in this list, and that is deliberate rather than an
 * oversight: qualifying is a measurement, not a promotion. A profile that has
 * met its criteria keeps paper trading until an administrator does something
 * about it — otherwise the act of passing would silently stop the agent, and
 * the record it is accumulating would freeze at the moment it became most
 * interesting.
 */
export const PAPER_EXECUTING_STATES: readonly ExecutionProfileState[] = [
  'PAPER_ARMED',
  'PAPER_RUNNING',
  'PAPER_QUALIFIED',
];

/**
 * States in which the LIVE engine may execute. Two, and only these two.
 *
 * PAPER_QUALIFIED is NOT here. That single omission is §11's entire
 * requirement: qualified ≠ live.
 */
export const LIVE_EXECUTING_STATES: readonly ExecutionProfileState[] = ['LIVE_ARMED', 'LIVE_RUNNING'];

/** Every state, for exhaustive iteration in tests and in the console legend. */
export const ALL_EXECUTION_STATES: readonly ExecutionProfileState[] = [
  'DISABLED',
  'PAPER_ARMED',
  'PAPER_RUNNING',
  'PAPER_QUALIFIED',
  'LIVE_ARMED',
  'LIVE_RUNNING',
  'PAUSED',
  'DISARMED',
  'ERROR',
];

export function isPaperExecutingState(state: ExecutionProfileState): boolean {
  return PAPER_EXECUTING_STATES.includes(state);
}

export function isLiveExecutingState(state: ExecutionProfileState): boolean {
  return LIVE_EXECUTING_STATES.includes(state);
}

/** May this state execute at all, in either engine? */
export function isExecutingState(state: ExecutionProfileState): boolean {
  return isPaperExecutingState(state) || isLiveExecutingState(state);
}

/**
 * The engine this state executes against, or null when it executes at all.
 *
 * THE SINGLE SOURCE OF TRUTH FOR PAPER-VS-LIVE. See the file docstring: no
 * caller may substitute `ExecutionProfile.environment` for this, because that
 * column is a record of what happened and this is the decision about what may.
 */
export function environmentFor(state: ExecutionProfileState): ExecutionEnvironmentName | null {
  if (isLiveExecutingState(state)) return 'LIVE';
  if (isPaperExecutingState(state)) return 'PAPER';
  return null;
}

/** How to say a state to a person, for the console and for refusal messages. */
export const STATE_LABELS: Record<ExecutionProfileState, string> = {
  DISABLED: 'Disabled',
  PAPER_ARMED: 'Paper — armed',
  PAPER_RUNNING: 'Paper — running',
  PAPER_QUALIFIED: 'Paper — qualified',
  LIVE_ARMED: 'Live — armed',
  LIVE_RUNNING: 'Live — running',
  PAUSED: 'Paused',
  DISARMED: 'Disarmed',
  ERROR: 'Error',
};

/**
 * One-line explanation of what each state means for execution. Rendered by the
 * console beside the badge, so an operator never has to infer a state's
 * consequences from its name.
 */
export const STATE_DESCRIPTIONS: Record<ExecutionProfileState, string> = {
  DISABLED: 'Never armed. Sentinel produces no executable decision for this profile.',
  PAPER_ARMED: 'Armed for paper by an administrator. The next pass may place a paper order.',
  PAPER_RUNNING: 'Paper execution has produced at least one decision. The loop is working this profile.',
  PAPER_QUALIFIED:
    'The configured paper-trading criteria are met. Still paper — this does not authorize live execution.',
  LIVE_ARMED: 'An administrator authorized LIVE execution. Real broker orders are now reachable.',
  LIVE_RUNNING: 'Live execution has produced at least one decision.',
  PAUSED: 'Execution suspended by an administrator. No orders are produced until it is resumed.',
  DISARMED: 'Armed previously, then explicitly stood down. No orders are produced.',
  ERROR: 'Halted by an execution fault. An administrator must clear it before execution resumes.',
};

/**
 * Every administrative or system act that can move a profile.
 *
 * An ACTION vocabulary rather than "set the state to X" is the difference
 * between an API a client can drive to any state it likes and one where each
 * move has a precondition the server owns. `ARM_LIVE` is why: expressed as
 * "set state = LIVE_ARMED" it is one field in a request body; expressed as an
 * action it is a verb the server refuses unless the qualification passed.
 */
export type ExecutionStateAction =
  | 'ARM_PAPER'
  | 'DISARM'
  | 'PAUSE'
  | 'RESUME'
  | 'ARM_LIVE'
  | 'DISARM_LIVE'
  | 'CLEAR_ERROR'
  // System-driven, never exposed as an operator action: the executor promoting
  // an armed profile to running, and the qualification sweep's two verdicts.
  | 'NOTE_RUNNING'
  | 'MARK_QUALIFIED'
  | 'MARK_UNQUALIFIED'
  | 'MARK_ERROR';

/** Actions an operator may invoke over HTTP. `NOTE_RUNNING` and friends are not here. */
export const OPERATOR_ACTIONS: readonly ExecutionStateAction[] = [
  'ARM_PAPER',
  'DISARM',
  'PAUSE',
  'RESUME',
  'ARM_LIVE',
  'DISARM_LIVE',
  'CLEAR_ERROR',
];

export interface TransitionRequest {
  from: ExecutionProfileState;
  action: ExecutionStateAction;
  /** For RESUME: the state PAUSE recorded to come back to. */
  resumeState?: ExecutionProfileState | null;
  /**
   * For ARM_LIVE: whether the profile's stored qualification snapshot passed.
   *
   * Passed IN rather than read here, so this module stays pure — and so the
   * refusal below is asserted in a unit test rather than only reachable through
   * a database with fifty closed trades in it.
   */
  qualificationPassed?: boolean;
  /**
   * For RESUME: whether an administrator's live authorization is still on the
   * profile (`ExecutionProfile.liveArmedAt`).
   *
   * ## Why RESUME needs this at all
   *
   * `resumeState` is a stored column, and restoring it verbatim makes that
   * column a second door into live execution — one that never passes through
   * `ARM_LIVE` and therefore never checks a qualification. A hand-edited row, a
   * restore from a backup taken while a profile was live, or a bug that writes
   * the column outside `PAUSE` would all promote a paper profile to
   * LIVE_RUNNING through a button labelled "Resume".
   *
   * `execution-state.spec.ts` found exactly that: RESUME was the one verb that
   * could enter a live state from a non-live one. So resuming INTO live now
   * requires the live arm to still be present, and falls back to
   * PAPER_QUALIFIED when it is not — which keeps the earned qualification and
   * makes re-arming live a deliberate, audited act rather than a side effect of
   * un-pausing.
   */
  liveArmed?: boolean;
}

export interface TransitionResult {
  allowed: boolean;
  to: ExecutionProfileState | null;
  /** Why not, in words an operator can act on. Null when allowed. */
  reason: string | null;
}

const ARMABLE_FROM: readonly ExecutionProfileState[] = ['DISABLED', 'DISARMED', 'ERROR'];

/**
 * Decide one transition.
 *
 * Written as a switch over ACTIONS rather than a from×to matrix because the
 * legality of a move depends on more than the pair — `ARM_LIVE` additionally
 * needs a passed qualification, `RESUME` needs a recorded resume state — and a
 * matrix cannot express either without a second structure that would drift.
 */
export function evaluateTransition(req: TransitionRequest): TransitionResult {
  const { from, action } = req;
  const deny = (reason: string): TransitionResult => ({ allowed: false, to: null, reason });
  const allow = (to: ExecutionProfileState): TransitionResult => ({ allowed: true, to, reason: null });

  switch (action) {
    case 'ARM_PAPER':
      if (isPaperExecutingState(from)) return deny(`Already armed for paper (${STATE_LABELS[from]}).`);
      if (isLiveExecutingState(from)) {
        // Arming paper from a live state would be a DEMOTION dressed up as an
        // arm, and it would leave the operator unsure whether live is still
        // authorized. Disarming live is its own act, with its own audit row.
        return deny('This profile is live-armed. Disarm live first if you mean to return it to paper.');
      }
      if (from === 'PAUSED') return deny('This profile is paused. Resume it instead of re-arming.');
      if (!ARMABLE_FROM.includes(from)) return deny(`Cannot arm for paper from ${STATE_LABELS[from]}.`);
      return allow('PAPER_ARMED');

    case 'DISARM':
      if (from === 'DISARMED') return deny('Already disarmed.');
      if (from === 'DISABLED') return deny('This profile was never armed.');
      // Legal from EVERY other state, including LIVE_RUNNING and ERROR. This is
      // the stop button, and a stop button with preconditions is not a stop
      // button — §15 requires that disarming take effect immediately, from
      // whatever state the profile is in.
      return allow('DISARMED');

    case 'PAUSE':
      if (from === 'PAUSED') return deny('Already paused.');
      if (!isExecutingState(from)) return deny(`Nothing to pause — this profile is ${STATE_LABELS[from]}.`);
      return allow('PAUSED');

    case 'RESUME': {
      if (from !== 'PAUSED') return deny(`Only a paused profile can be resumed; this one is ${STATE_LABELS[from]}.`);
      const back = req.resumeState ?? null;
      if (!back || !isExecutingState(back)) {
        // Recorded at pause time. Absent, the honest answer is the safest one:
        // returning to paper. Guessing LIVE here would promote a profile on the
        // strength of a missing column.
        return allow('PAPER_ARMED');
      }
      if (isLiveExecutingState(back)) {
        // Resuming into live is only a RESTORATION when the live arm is still
        // there. Without it, `resumeState` alone would be a door into live that
        // never passed through ARM_LIVE — see `liveArmed` on TransitionRequest.
        //
        // The fallback is PAPER_QUALIFIED, not PAPER_ARMED: the profile earned
        // its qualification and resuming should not silently destroy it. It
        // simply has to be armed for live again, deliberately.
        if (req.liveArmed !== true) return allow('PAPER_QUALIFIED');
      }
      return allow(back);
    }

    case 'ARM_LIVE':
      // ---- §11. The second explicit arm, and its one precondition ---------
      //
      // Reachable ONLY from PAPER_QUALIFIED. Not from PAPER_RUNNING with a good
      // week behind it, not from PAUSED, not from DISARMED, and never from
      // DISABLED. The state itself is the proof that the criteria were measured
      // and met, and requiring the snapshot to still pass on top of it closes
      // the window where a profile qualified last month and has been losing
      // since.
      if (from !== 'PAPER_QUALIFIED') {
        return deny(
          `Live execution may only be armed from ${STATE_LABELS.PAPER_QUALIFIED}; this profile is ${STATE_LABELS[from]}. ` +
            'Paper qualification is a prerequisite, not a formality.',
        );
      }
      if (req.qualificationPassed !== true) {
        return deny('The stored paper-qualification snapshot does not pass. Re-evaluate it before arming live.');
      }
      return allow('LIVE_ARMED');

    case 'DISARM_LIVE':
      if (!isLiveExecutingState(from)) return deny(`This profile is not live-armed; it is ${STATE_LABELS[from]}.`);
      // Back to PAPER_QUALIFIED, the state it was promoted from — so standing
      // live down does not also destroy the qualification it earned, and
      // re-arming live later is one act rather than a fresh 50 trades.
      return allow('PAPER_QUALIFIED');

    case 'CLEAR_ERROR':
      if (from !== 'ERROR') return deny(`This profile is not in an error state; it is ${STATE_LABELS[from]}.`);
      // To DISARMED, never back to armed. An operator clearing a fault is
      // saying "I have looked at it", not "resume trading" — those are two
      // decisions and the second one deserves its own audit row.
      return allow('DISARMED');

    case 'NOTE_RUNNING':
      if (from === 'PAPER_ARMED') return allow('PAPER_RUNNING');
      if (from === 'LIVE_ARMED') return allow('LIVE_RUNNING');
      // Any other state: nothing to promote. Not an error — the executor calls
      // this on every pass that produced a decision.
      return deny('No promotion applies from this state.');

    case 'MARK_QUALIFIED':
      if (from === 'PAPER_ARMED' || from === 'PAPER_RUNNING') return allow('PAPER_QUALIFIED');
      return deny('Qualification only promotes a paper-executing profile.');

    case 'MARK_UNQUALIFIED':
      // A profile can lose qualification (a drawdown deepens, a losing streak
      // lengthens). It falls back to PAPER_RUNNING, never below — it is still
      // armed and still trading.
      if (from === 'PAPER_QUALIFIED') return allow('PAPER_RUNNING');
      // NOT from a live state. Live authorization is withdrawn by an
      // administrator (`DISARM_LIVE`) or by the stop button, never by a metrics
      // sweep deciding on its own that a live agent should stand down — that
      // would leave an open live position with nothing watching it.
      return deny('Qualification is not withdrawn automatically from this state.');

    case 'MARK_ERROR':
      if (from === 'ERROR') return deny('Already in an error state.');
      return allow('ERROR');

    default: {
      const exhaustive: never = action;
      return deny(`Unknown action ${String(exhaustive)}.`);
    }
  }
}

/**
 * Why a profile in this state may not execute, phrased as a refusal an intent
 * can be REJECTED with.
 *
 * The vocabulary matches §8's list of required rejection reasons, so a stored
 * refusal reads the same way in the console as it does in the API.
 */
export function stateRefusal(state: ExecutionProfileState): string {
  switch (state) {
    case 'DISABLED':
      return 'Profile is not armed. An administrator must arm it before Sentinel may execute.';
    case 'DISARMED':
      return 'Profile was disarmed by an administrator. No further orders are produced.';
    case 'PAUSED':
      return 'Execution is paused by an administrator.';
    case 'ERROR':
      return 'Profile is halted by an execution error and must be cleared by an administrator.';
    default:
      return `Profile state ${STATE_LABELS[state]} does not permit execution.`;
  }
}

/**
 * The rejection check id for a state refusal, so it groups in the console's
 * "why decisions did not become orders" breakdown alongside the policy gates.
 */
export const PROFILE_NOT_ARMED = 'profile-not-armed';
export const AUTOTRADE_DISABLED = 'autotrade-disabled';
export const LIVE_NOT_AUTHORIZED = 'live-not-authorized';
export const PAPER_NOT_QUALIFIED = 'paper-not-qualified';
