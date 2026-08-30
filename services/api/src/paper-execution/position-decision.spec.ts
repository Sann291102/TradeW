import { describe, expect, it } from 'vitest';
import { HARD_SESSION_CLOSE_MINUTE, decidePosition, type PositionFacts } from './position-decision';

/**
 * The one authoritative decision per open position.
 *
 * Two things are asserted throughout: exactly one action comes back for any
 * set of facts, and the precedence between simultaneously-true conditions is
 * the documented one. A position with several writers is how a paper book ends
 * up with two exits for one entry, and the ordering is the whole reason this
 * is one function rather than five services.
 */

const BASE: PositionFacts = {
  entryPrice: 120,
  stopPrice: 78,
  targetPrice: 246,
  quantity: 75,
  trailStepPoints: 3,
  trailPrice: null,
  trailSteps: 0,
  highWaterPrice: 120,
  lastPrice: 125,
  feedFresh: true,
  marketOpen: true,
  minuteOfDay: 11 * 60,
  squareOffMinute: 910,
  firedExitRules: [],
};

describe('decidePosition — holding', () => {
  it('holds a position inside its levels', () => {
    const action = decidePosition(BASE);
    expect(action.kind).toBe('hold');
    expect(action.detail).toContain('Holding');
  });

  it('reports the live unrealised P&L in the hold detail', () => {
    const action = decidePosition({ ...BASE, lastPrice: 130 });
    // (130 − 120) × 75
    expect(action.detail).toContain('+750');
  });
});

describe('decidePosition — the trailing ratchet', () => {
  it('does not activate before one full step', () => {
    expect(decidePosition({ ...BASE, lastPrice: 122.5 }).trail).toBeNull();
  });

  it('moves protection to breakeven on the first step', () => {
    const action = decidePosition({ ...BASE, lastPrice: 123 });
    expect(action.trail).not.toBeNull();
    expect(action.trail!.fromPrice).toBeNull();
    expect(action.trail!.toPrice).toBe(120);
    expect(action.trail!.totalSteps).toBe(1);
    expect(action.trail!.reason).toContain('breakeven');
  });

  it('advances one step per 3 favourable points thereafter', () => {
    const at126 = decidePosition({ ...BASE, lastPrice: 126, highWaterPrice: 126, trailPrice: 120, trailSteps: 1 });
    expect(at126.trail!.toPrice).toBe(123);
    expect(at126.trail!.stepsAdvanced).toBe(1);

    const at150 = decidePosition({ ...BASE, lastPrice: 150, highWaterPrice: 150, trailPrice: 123, trailSteps: 2 });
    expect(at150.trail!.toPrice).toBe(147);
    expect(at150.trail!.stepsAdvanced).toBe(8);
    expect(at150.trail!.totalSteps).toBe(10);
  });

  it('does not re-emit an adjustment when nothing advanced', () => {
    // Same high water, same step count — a tick that moved nothing writes
    // nothing. Otherwise every 2-second tick appends a trail row for the life
    // of the position.
    const action = decidePosition({ ...BASE, lastPrice: 124, highWaterPrice: 126, trailPrice: 123, trailSteps: 2 });
    expect(action.trail).toBeNull();
  });

  it('NEVER loosens protection on a retrace', () => {
    // Price falls back to 124 from a 150 peak: the trail stays at 147 and the
    // position is out, rather than the trail following price down.
    const action = decidePosition({ ...BASE, lastPrice: 124, highWaterPrice: 150, trailPrice: 147, trailSteps: 10 });
    expect(action.kind).toBe('exit');
    expect((action as { reason: string }).reason).toBe('TRAIL');
    expect(action.detail).toContain('147');
  });

  it('records the advance even on the tick that trips it', () => {
    // A single fast tick to 129 then straight back through 126 would otherwise
    // close on a trailing level with no history of that level ever existing.
    const action = decidePosition({
      ...BASE,
      lastPrice: 126,
      highWaterPrice: 135, // this tick's high
      trailPrice: 120,
      trailSteps: 1,
    });
    expect(action.kind).toBe('exit');
    expect((action as { reason: string }).reason).toBe('TRAIL');
    expect(action.trail).not.toBeNull();
    expect(action.trail!.toPrice).toBe(132);
  });
});

describe('decidePosition — the exits', () => {
  it('exits on the stop', () => {
    const action = decidePosition({ ...BASE, lastPrice: 78 });
    expect(action).toMatchObject({ kind: 'exit', reason: 'STOP' });
  });

  it('exits on the target', () => {
    const action = decidePosition({ ...BASE, lastPrice: 250, highWaterPrice: 250 });
    expect(action).toMatchObject({ kind: 'exit', reason: 'TARGET' });
  });

  it('exits on the strategy’s own invalidation', () => {
    const action = decidePosition({
      ...BASE,
      firedExitRules: [{ id: 'momentum_faded', note: 'Session momentum has fallen to 0.18' }],
    });
    expect(action).toMatchObject({ kind: 'exit', reason: 'INVALIDATED' });
    expect(action.detail).toContain('momentum_faded');
    expect(action.detail).toContain('no longer holds');
  });

  it('exits at the profile’s square-off minute', () => {
    const action = decidePosition({ ...BASE, minuteOfDay: 910 });
    expect(action).toMatchObject({ kind: 'exit', reason: 'SQUARE_OFF' });
  });
});

describe('decidePosition — emergencies rank above everything', () => {
  it('exits when no premium could be read', () => {
    const action = decidePosition({ ...BASE, lastPrice: null });
    expect(action).toMatchObject({ kind: 'exit', reason: 'EMERGENCY' });
    expect(action.detail).toContain('unenforceable');
  });

  it('exits when the feed has stopped ticking', () => {
    const action = decidePosition({ ...BASE, feedFresh: false });
    expect(action).toMatchObject({ kind: 'exit', reason: 'EMERGENCY' });
    expect(action.detail).toContain('frozen quote');
  });

  it('exits when the venue reports the session closed', () => {
    const action = decidePosition({ ...BASE, marketOpen: false });
    expect(action).toMatchObject({ kind: 'exit', reason: 'EMERGENCY' });
  });

  it('exits past the hard exchange close whatever the profile says', () => {
    const action = decidePosition({ ...BASE, minuteOfDay: HARD_SESSION_CLOSE_MINUTE, squareOffMinute: 1_400 });
    expect(action).toMatchObject({ kind: 'exit', reason: 'EMERGENCY' });
  });

  it('takes precedence over a target that is also reached', () => {
    // A dead feed AND a price through the target: the price cannot be trusted,
    // so the emergency wins and the journal says so honestly.
    const action = decidePosition({ ...BASE, lastPrice: 300, feedFresh: false });
    expect((action as { reason: string }).reason).toBe('EMERGENCY');
  });
});

describe('decidePosition — precedence between simultaneous conditions', () => {
  it('STOP beats TARGET when both are somehow true', () => {
    // Only reachable through a gap or a corrupted plan, but the ordering must
    // be deterministic: being wrong about a stop costs money, being wrong
    // about a target costs profit.
    const action = decidePosition({ ...BASE, lastPrice: 78, targetPrice: 70 });
    expect((action as { reason: string }).reason).toBe('STOP');
  });

  it('TARGET beats TRAIL on the tick that reaches both', () => {
    const action = decidePosition({
      ...BASE,
      lastPrice: 246,
      highWaterPrice: 246,
      trailPrice: 243,
      trailSteps: 41,
    });
    expect((action as { reason: string }).reason).toBe('TARGET');
  });

  it('TRAIL beats INVALIDATION', () => {
    const action = decidePosition({
      ...BASE,
      lastPrice: 140,
      highWaterPrice: 150,
      trailPrice: 147,
      trailSteps: 10,
      firedExitRules: [{ id: 'momentum_faded', note: 'x' }],
    });
    expect((action as { reason: string }).reason).toBe('TRAIL');
  });

  it('INVALIDATION beats SQUARE_OFF', () => {
    const action = decidePosition({
      ...BASE,
      minuteOfDay: 915,
      firedExitRules: [{ id: 'structure_reversed', note: 'change of character' }],
    });
    expect((action as { reason: string }).reason).toBe('INVALIDATED');
  });

  it('never reports a trailing exit on a level below the initial stop', () => {
    // A trail under the stop is a stop-out, and labelling it TRAIL would
    // corrupt the one column a calibration uses to separate exit kinds.
    const action = decidePosition({ ...BASE, lastPrice: 70, trailPrice: 60, trailSteps: 1 });
    expect((action as { reason: string }).reason).toBe('STOP');
  });
});

describe('decidePosition — the disarm rule', () => {
  it('cannot express "stop managing because the profile is disarmed"', () => {
    // Structural, not behavioural: there is no `enabled` in PositionFacts, so
    // no caller can pass one and no branch can read one. Disarming gates
    // ENTRIES; a position already open is managed to its exit either way.
    const keys = Object.keys(BASE);
    expect(keys).not.toContain('enabled');
    expect(keys).not.toContain('profileEnabled');
    expect(keys).not.toContain('armed');
  });
});

describe('decidePosition — totality', () => {
  it('returns exactly one action for every combination of trigger conditions', () => {
    const prices = [null, 0, 60, 78, 100, 120, 130, 246, 300];
    const minutes = [600, 909, 910, HARD_SESSION_CLOSE_MINUTE];
    let count = 0;
    for (const lastPrice of prices) {
      for (const feedFresh of [true, false]) {
        for (const marketOpen of [true, false]) {
          for (const minuteOfDay of minutes) {
            for (const fired of [[], [{ id: 'r', note: 'n' }]]) {
              for (const trailSteps of [0, 5]) {
                const action = decidePosition({
                  ...BASE,
                  lastPrice,
                  feedFresh,
                  marketOpen,
                  minuteOfDay,
                  firedExitRules: fired,
                  trailSteps,
                  trailPrice: trailSteps > 0 ? 132 : null,
                  highWaterPrice: trailSteps > 0 ? 138 : 120,
                });
                expect(['hold', 'exit']).toContain(action.kind);
                if (action.kind === 'exit') {
                  expect(['EMERGENCY', 'STOP', 'TARGET', 'TRAIL', 'INVALIDATED', 'SQUARE_OFF']).toContain(action.reason);
                }
                expect(action.detail.length).toBeGreaterThan(10);
                count++;
              }
            }
          }
        }
      }
    }
    expect(count).toBe(prices.length * 2 * 2 * minutes.length * 2 * 2);
  });
});
