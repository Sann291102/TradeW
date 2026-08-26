import { describe, expect, it } from 'vitest';
import {
  ALL_EXECUTION_STATES,
  LIVE_EXECUTING_STATES,
  OPERATOR_ACTIONS,
  PAPER_EXECUTING_STATES,
  environmentFor,
  evaluateTransition,
  isExecutingState,
  isLiveExecutingState,
  isPaperExecutingState,
  stateRefusal,
  type ExecutionProfileState,
} from './execution-state';

/**
 * The state machine's safety properties.
 *
 * Every case here is a way real money gets spent by accident. They are asserted
 * against the pure module rather than through a database because that is the
 * only way to cover all nine states and all ten actions — the alternative needs
 * a profile with fifty closed trades to reach even one of them.
 */
describe('execution state machine', () => {
  describe('which states execute, and where', () => {
    it('resolves LIVE for exactly two states, and PAPER_QUALIFIED is not one of them', () => {
      // §11's whole requirement, as one assertion: qualified ≠ live.
      expect(LIVE_EXECUTING_STATES).toEqual(['LIVE_ARMED', 'LIVE_RUNNING']);
      expect(environmentFor('PAPER_QUALIFIED')).toBe('PAPER');
      expect(isLiveExecutingState('PAPER_QUALIFIED')).toBe(false);
    });

    it('keeps a qualified profile trading paper', () => {
      // Passing must not stop the agent. If PAPER_QUALIFIED were non-executing,
      // the act of meeting the criteria would silently halt the record it is
      // accumulating — at the moment that record becomes most interesting.
      expect(isPaperExecutingState('PAPER_QUALIFIED')).toBe(true);
      expect(PAPER_EXECUTING_STATES).toContain('PAPER_QUALIFIED');
    });

    it.each(['DISABLED', 'DISARMED', 'PAUSED', 'ERROR'] as ExecutionProfileState[])(
      '%s executes in no engine at all',
      (state) => {
        expect(isExecutingState(state)).toBe(false);
        expect(environmentFor(state)).toBeNull();
      },
    );

    it('agrees with itself: environmentFor is non-null exactly when isExecutingState is true', () => {
      // The resolver throws on a state where these two disagree, so a mismatch
      // would be an unexecutable profile rather than a wrongly-executed one —
      // but it would still be a bug, and this is where it is caught.
      for (const state of ALL_EXECUTION_STATES) {
        expect(environmentFor(state) !== null).toBe(isExecutingState(state));
      }
    });
  });

  describe('ARM_LIVE — the second explicit authorization', () => {
    it('is refused from every state except PAPER_QUALIFIED', () => {
      for (const from of ALL_EXECUTION_STATES) {
        if (from === 'PAPER_QUALIFIED') continue;
        const result = evaluateTransition({ from, action: 'ARM_LIVE', qualificationPassed: true });
        expect(result.allowed, `ARM_LIVE should be refused from ${from}`).toBe(false);
      }
    });

    it('is refused from PAPER_QUALIFIED when the stored snapshot does not pass', () => {
      // The state alone is not sufficient. A profile that qualified last month
      // and has been losing since is still PAPER_QUALIFIED until the sweep
      // demotes it; requiring the live snapshot closes that window.
      const result = evaluateTransition({
        from: 'PAPER_QUALIFIED',
        action: 'ARM_LIVE',
        qualificationPassed: false,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/does not pass/i);
    });

    it('is allowed from PAPER_QUALIFIED with a passing snapshot', () => {
      const result = evaluateTransition({
        from: 'PAPER_QUALIFIED',
        action: 'ARM_LIVE',
        qualificationPassed: true,
      });
      expect(result).toEqual({ allowed: true, to: 'LIVE_ARMED', reason: null });
    });

    it('is the ONLY way to cross from a non-live state into a live one', () => {
      // The property that makes "qualification never enables live" structural
      // rather than a convention inside the qualification service.
      //
      // Stated as ENTRY into live, not as "never produces a live state":
      // NOTE_RUNNING legitimately moves LIVE_ARMED → LIVE_RUNNING, which is
      // movement WITHIN live and authorizes nothing new. The dangerous edge is
      // the one that starts outside.
      //
      // RESUME is included, with a resume target that names a live state — an
      // input PAUSE cannot produce, but exactly the shape a corrupted or
      // hand-edited row would have. It must still not let a paper profile out
      // through a live door.
      const everyAction = [
        'ARM_PAPER',
        'DISARM',
        'PAUSE',
        'RESUME',
        'DISARM_LIVE',
        'CLEAR_ERROR',
        'NOTE_RUNNING',
        'MARK_QUALIFIED',
        'MARK_UNQUALIFIED',
        'MARK_ERROR',
      ] as const;

      for (const from of ALL_EXECUTION_STATES) {
        if (isLiveExecutingState(from)) continue; // already live; not an entry
        for (const action of everyAction) {
          const result = evaluateTransition({
            from,
            action,
            resumeState: 'LIVE_RUNNING',
            qualificationPassed: true,
          });
          if (!result.allowed) continue;
          expect(
            isLiveExecutingState(result.to!),
            `${action} from ${from} entered ${result.to} without ARM_LIVE`,
          ).toBe(false);
        }
      }
    });
  });

  describe('DISARM — the stop button', () => {
    it('is allowed from every state that is not already stood down', () => {
      // §15: disarming must take effect from whatever state the profile is in.
      // A stop button with preconditions is not a stop button.
      for (const from of ALL_EXECUTION_STATES) {
        const result = evaluateTransition({ from, action: 'DISARM' });
        if (from === 'DISARMED' || from === 'DISABLED') {
          expect(result.allowed).toBe(false);
        } else {
          expect(result.allowed, `DISARM should work from ${from}`).toBe(true);
          expect(result.to).toBe('DISARMED');
        }
      }
    });

    it('stands a LIVE_RUNNING profile down in one act', () => {
      expect(evaluateTransition({ from: 'LIVE_RUNNING', action: 'DISARM' }).to).toBe('DISARMED');
    });
  });

  describe('PAUSE and RESUME', () => {
    it('resumes into the state that was paused, not a guess', () => {
      // Resuming a paused LIVE profile as PAPER would silently demote it; the
      // reverse would silently promote one. Both are wrong, so the state is
      // recorded rather than inferred.
      expect(
        evaluateTransition({ from: 'PAUSED', action: 'RESUME', resumeState: 'LIVE_RUNNING', liveArmed: true }).to,
      ).toBe('LIVE_RUNNING');
      expect(evaluateTransition({ from: 'PAUSED', action: 'RESUME', resumeState: 'PAPER_QUALIFIED' }).to).toBe(
        'PAPER_QUALIFIED',
      );
    });

    it('will not resume into live on the strength of resumeState alone', () => {
      // `resumeState` is a stored column. Restoring it verbatim would make it a
      // second door into live execution — one that never passes ARM_LIVE and
      // therefore never checks a qualification. A backup restored from a moment
      // when the profile was live, or any bug that writes the column outside
      // PAUSE, would then promote a paper profile through a "Resume" button.
      //
      // Falls back to PAPER_QUALIFIED rather than PAPER_ARMED: the profile
      // keeps what it earned and simply has to be live-armed again, deliberately.
      const result = evaluateTransition({
        from: 'PAUSED',
        action: 'RESUME',
        resumeState: 'LIVE_RUNNING',
        liveArmed: false,
      });
      expect(result.to).toBe('PAPER_QUALIFIED');
    });

    it('falls back to PAPER_ARMED when no resume state was recorded', () => {
      // The safe direction. Guessing LIVE from a missing column would authorize
      // real orders on the strength of an absent value.
      const result = evaluateTransition({ from: 'PAUSED', action: 'RESUME', resumeState: null });
      expect(result.to).toBe('PAPER_ARMED');
    });

    it('refuses to pause something that is not executing', () => {
      expect(evaluateTransition({ from: 'DISABLED', action: 'PAUSE' }).allowed).toBe(false);
    });
  });

  describe('ARM_PAPER', () => {
    it('is refused from a live state rather than silently demoting it', () => {
      const result = evaluateTransition({ from: 'LIVE_RUNNING', action: 'ARM_PAPER' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/disarm live/i);
    });

    it('is allowed from DISABLED, DISARMED and ERROR', () => {
      for (const from of ['DISABLED', 'DISARMED', 'ERROR'] as ExecutionProfileState[]) {
        expect(evaluateTransition({ from, action: 'ARM_PAPER' }).to).toBe('PAPER_ARMED');
      }
    });
  });

  describe('system-driven transitions', () => {
    it('promotes armed → running in the matching engine only', () => {
      expect(evaluateTransition({ from: 'PAPER_ARMED', action: 'NOTE_RUNNING' }).to).toBe('PAPER_RUNNING');
      expect(evaluateTransition({ from: 'LIVE_ARMED', action: 'NOTE_RUNNING' }).to).toBe('LIVE_RUNNING');
      // The common case: already running, nothing to promote, and it must not
      // raise — the executor calls this on every pass that reached a decision.
      expect(evaluateTransition({ from: 'PAPER_RUNNING', action: 'NOTE_RUNNING' }).allowed).toBe(false);
    });

    it('never withdraws qualification from a live state', () => {
      // A metrics sweep standing a LIVE agent down on its own would leave an
      // open live position with nothing watching it. Withdrawal there is an
      // administrator's act (DISARM_LIVE) or the stop button.
      for (const from of LIVE_EXECUTING_STATES) {
        expect(evaluateTransition({ from, action: 'MARK_UNQUALIFIED' }).allowed).toBe(false);
      }
      expect(evaluateTransition({ from: 'PAPER_QUALIFIED', action: 'MARK_UNQUALIFIED' }).to).toBe('PAPER_RUNNING');
    });

    it('only promotes a paper-executing profile to qualified', () => {
      expect(evaluateTransition({ from: 'PAPER_RUNNING', action: 'MARK_QUALIFIED' }).to).toBe('PAPER_QUALIFIED');
      expect(evaluateTransition({ from: 'DISARMED', action: 'MARK_QUALIFIED' }).allowed).toBe(false);
      expect(evaluateTransition({ from: 'LIVE_RUNNING', action: 'MARK_QUALIFIED' }).allowed).toBe(false);
    });
  });

  describe('CLEAR_ERROR', () => {
    it('leaves the profile DISARMED rather than re-arming it', () => {
      // Acknowledging a fault is not the same decision as resuming trading, and
      // the second deserves its own audited act.
      expect(evaluateTransition({ from: 'ERROR', action: 'CLEAR_ERROR' }).to).toBe('DISARMED');
    });
  });

  describe('the operator vocabulary', () => {
    it('excludes every system-driven action', () => {
      // An operator must not be able to declare a profile qualified, which is
      // what putting MARK_QUALIFIED on this list would allow.
      expect(OPERATOR_ACTIONS).not.toContain('MARK_QUALIFIED');
      expect(OPERATOR_ACTIONS).not.toContain('MARK_UNQUALIFIED');
      expect(OPERATOR_ACTIONS).not.toContain('NOTE_RUNNING');
      expect(OPERATOR_ACTIONS).not.toContain('MARK_ERROR');
    });
  });

  describe('refusal messages', () => {
    it('says something an operator can act on for every non-executing state', () => {
      for (const state of ALL_EXECUTION_STATES) {
        if (isExecutingState(state)) continue;
        expect(stateRefusal(state).length).toBeGreaterThan(20);
      }
    });
  });
});
