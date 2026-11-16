import { describe, expect, it } from 'vitest';
import {
  ANCHOR_BUFFER_ATR,
  MAX_RISK_ATR,
  MAX_TARGET_ATR,
  MIN_RISK_ATR,
  REWARD_MULTIPLE,
  deriveLevels,
  findAnchor,
} from './levels';
import { AGENT_SETUPS, type SetupDefinition } from './setups';
import { DEFAULT_TRAILING } from './trailing';
import { atr } from './indicators';
import {
  buildCandles,
  emaCrossLongFixture,
  emaCrossNoiseFloorFixture,
  openingRangeBreakoutFixture,
  risingSeries,
  snapshotFrom,
} from './fixtures';

const setupById = (id: string): SetupDefinition => {
  const s = AGENT_SETUPS.find((x) => x.id === id);
  if (!s) throw new Error(`fixture references unknown setup ${id}`);
  return s;
};

const emaCross = setupById('agent-ema-cross');
const orb = setupById('agent-opening-range-expansion');

describe('deriveLevels — the 1:3 contract', () => {
  it('derives entry, a structural stop and a target that is exactly 3R', () => {
    const snapshot = emaCrossLongFixture();
    const out = deriveLevels(emaCross, 'bullish', snapshot);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { plan } = out;

    expect(plan.direction).toBe('long');
    expect(plan.entry).toBe(snapshot.lastPrice);
    expect(plan.stop).toBeLessThan(plan.entry);
    expect(plan.target).toBeGreaterThan(plan.entry);

    // The load-bearing assertion: reward is three times risk, and the target
    // is that distance from entry — not a number chosen and then justified.
    expect(plan.riskPerUnit).toBeCloseTo(plan.entry - plan.stop, 6);
    expect(plan.rewardPerUnit).toBeCloseTo(REWARD_MULTIPLE * plan.riskPerUnit, 6);
    expect(plan.target).toBeCloseTo(plan.entry + REWARD_MULTIPLE * plan.riskPerUnit, 2);
    expect(plan.plannedRR).toBe(3);
  });

  it('anchors the stop on the signal bar low plus an ATR buffer, not on a percentage', () => {
    const snapshot = emaCrossLongFixture();
    const volatility = atr(snapshot.candles)!;
    const signalLow = snapshot.candles[snapshot.candles.length - 1].low;

    const out = deriveLevels(emaCross, 'bullish', snapshot);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.plan.anchor.archetype).toBe('signal-bar');
    expect(out.plan.anchor.level).toBe(signalLow);
    expect(out.plan.stop).toBeCloseTo(signalLow - ANCHOR_BUFFER_ATR * volatility, 1);
  });

  it('mirrors the derivation for a short', () => {
    // A falling series: the same setup shape, opposite side.
    const bars = risingSeries(60, { start: 2000, drift: -2, range: 6, volume: 1000 });
    const snapshot = snapshotFrom(buildCandles(bars));
    const out = deriveLevels({ ...emaCross, directionality: 'both' }, 'bearish', snapshot);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.direction).toBe('short');
    expect(out.plan.stop).toBeGreaterThan(out.plan.entry);
    expect(out.plan.target).toBeLessThan(out.plan.entry);
    expect(out.plan.target).toBeCloseTo(
      out.plan.entry - REWARD_MULTIPLE * out.plan.riskPerUnit,
      2,
    );
  });

  it('uses the opening range edge for a range-break setup', () => {
    const snapshot = openingRangeBreakoutFixture();
    const anchor = findAnchor('range-break', 'long', snapshot);
    expect(anchor).not.toBeNull();
    expect(anchor!.level).toBe(snapshot.openingRange!.high);
    expect(anchor!.note).toContain('Opening-range high');
  });

  it('states the derivation with the real numbers, so the journal can quote it', () => {
    const out = deriveLevels(emaCross, 'bullish', emaCrossLongFixture());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { plan } = out;
    const prose = plan.rationale.join(' ');

    // The three prices a reader would check are all present as the values the
    // plan actually carries — not restated approximately.
    expect(prose).toContain(String(plan.stop));
    expect(prose).toContain(String(plan.entry));
    expect(prose).toContain(String(plan.target));
    // And the derivation names the structure it came off, not a percentage.
    expect(prose).toContain('Signal bar low');
    expect(prose).toMatch(/3R/);
  });
});

describe('the exit is decided before the entry', () => {
  it('every plan carries a complete exit plan — it is not constructible without one', () => {
    const out = deriveLevels(emaCross, 'bullish', emaCrossLongFixture());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { exitPlan } = out.plan;

    // "Entry looks good, we'll work out the exit later" is unrepresentable:
    // there is no code path that produces a plan without these.
    expect(exitPlan.structuralInvalidation).toBeTruthy();
    expect(exitPlan.trailActivationR).toBe(DEFAULT_TRAILING.activationR);
    expect(exitPlan.trailLockR).toBe(DEFAULT_TRAILING.lockR);
    expect(exitPlan.trailStepR).toBe(DEFAULT_TRAILING.stepR);
    expect(exitPlan.invalidationRules).toEqual(emaCross.exitRules);
    // Every way the trade may end, enumerated up front.
    expect(exitPlan.exits.length).toBeGreaterThanOrEqual(4);
    expect(exitPlan.exits.join(' ')).toMatch(/Stop at/);
    expect(exitPlan.exits.join(' ')).toMatch(/Target at/);
    expect(exitPlan.exits.join(' ')).toMatch(/Trailing stop/);
  });

  it('states the FIRST reward (1R) separately from the 3R target', () => {
    const out = deriveLevels(emaCross, 'bullish', emaCrossLongFixture());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const p = out.plan;

    // The trade is taken because the structure supports 3R, but it is MANAGED
    // in stages: 1R is where the ratchet arms.
    expect(p.firstRewardPrice).toBeCloseTo(p.entry + p.riskPerUnit, 2);
    expect(p.target).toBeCloseTo(p.entry + 3 * p.riskPerUnit, 2);
    expect(p.firstRewardPrice).toBeLessThan(p.target);
  });

  it('mirrors the first reward for a short', () => {
    const bars = risingSeries(60, { start: 2000, drift: -2, range: 6, volume: 1000 });
    const out = deriveLevels(
      { ...emaCross, directionality: 'both' },
      'bearish',
      snapshotFrom(buildCandles(bars)),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.firstRewardPrice).toBeCloseTo(out.plan.entry - out.plan.riskPerUnit, 2);
  });

  it('honours a non-default trailing contract in the plan it writes', () => {
    const cfg = { initialRRMin: 3, activationR: 2, lockR: 1, stepR: 2 };
    const out = deriveLevels(emaCross, 'bullish', emaCrossLongFixture(), cfg);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.exitPlan.trailActivationR).toBe(2);
    expect(out.plan.exitPlan.summary).toContain('2R');
  });

  it('summarises the plan in prose a human can audit', () => {
    const out = deriveLevels(emaCross, 'bullish', emaCrossLongFixture());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const s = out.plan.exitPlan.summary;
    expect(s).toContain(String(out.plan.stop));
    expect(s).toContain(String(out.plan.firstRewardPrice));
    expect(s).toContain(String(out.plan.target));
    expect(s).toMatch(/never backwards/);
  });
});

describe('deriveLevels — refusals', () => {
  it('refuses a neutral bias rather than defaulting it to long', () => {
    const out = deriveLevels(emaCross, 'neutral', emaCrossLongFixture());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('no-directional-bias');
  });

  it('refuses when the stop would sit inside routine noise', () => {
    const snapshot = emaCrossNoiseFloorFixture();
    const out = deriveLevels(emaCross, 'bullish', snapshot);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('risk-below-noise-floor');
    // The refusal must name the measurement that produced it.
    expect(out.detail).toContain('ATR');
    expect(out.detail).toContain(String(MIN_RISK_ATR));
  });

  it('refuses when the setup has no structure of its own to anchor to', () => {
    // An ORB setup on a snapshot that carries no opening range.
    const out = deriveLevels(orb, 'bullish', emaCrossLongFixture());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('no-structural-anchor');
    expect(out.detail).toContain('range-break');
  });

  it('refuses when volatility cannot be measured at all', () => {
    const snapshot = snapshotFrom(buildCandles(risingSeries(1)));
    const out = deriveLevels(emaCross, 'bullish', snapshot);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('atr-unavailable');
  });

  it('refuses a stop so far away that 3R is not a move this market makes', () => {
    // A very wide final bar drags the anchor far below entry.
    const bars = risingSeries(60, { start: 1000, drift: 2, range: 6, volume: 1000 });
    const last = bars[bars.length - 1];
    last.low = last.close - 400;
    const out = deriveLevels(emaCross, 'bullish', snapshotFrom(buildCandles(bars)));

    expect(out.ok).toBe(false);
    if (out.ok) return;
    // Either ceiling is a correct refusal; both name a real over-extension.
    expect(['risk-exceeds-volatility-budget', 'target-not-feasible']).toContain(out.reason);
  });

  it('never moves a stop to make the ratio work', () => {
    // The invariant behind every refusal above: across a sweep of final-bar
    // lows, the stop is ALWAYS the anchor minus the buffer, or there is no
    // plan at all. It is never something in between.
    for (const depth of [0.1, 2, 5, 10, 20, 60, 200, 400]) {
      const bars = risingSeries(60, { start: 1000, drift: 2, range: 6, volume: 1000 });
      const last = bars[bars.length - 1];
      last.low = last.close - depth;
      const snapshot = snapshotFrom(buildCandles(bars));
      const volatility = atr(snapshot.candles)!;
      const out = deriveLevels(emaCross, 'bullish', snapshot);

      if (out.ok) {
        expect(out.plan.stop).toBeCloseTo(last.low - ANCHOR_BUFFER_ATR * volatility, 1);
        expect(out.plan.riskAtr).toBeGreaterThanOrEqual(MIN_RISK_ATR);
        expect(out.plan.riskAtr).toBeLessThanOrEqual(MAX_RISK_ATR);
        expect(out.plan.targetAtr).toBeLessThanOrEqual(MAX_TARGET_ATR);
      }
    }
  });
});
