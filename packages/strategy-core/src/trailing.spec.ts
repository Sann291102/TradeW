import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAILING,
  advanceHighWater,
  updateTrailingStop,
  type TrailingConfig,
} from './trailing';

/** The brief's worked example: entry 79, stop 69, risk 10. */
const EXAMPLE = { direction: 'long' as const, entry: 79, initialRisk: 10 };

const step = (highWaterPrice: number, currentStop: number, config?: TrailingConfig) =>
  updateTrailingStop({ ...EXAMPLE, currentStop, highWaterPrice, config });

describe('the worked example, exactly', () => {
  it('holds the structural stop until 1R is reached', () => {
    // 88 is 0.9R — close, and not enough. A trade that has not paid anything
    // has not earned a tighter stop.
    const r = step(88, 69);
    expect(r.moved).toBe(false);
    expect(r.stop).toBe(69);
    expect(r.reason).toContain('activation');
  });

  it('1R (price 89) moves the stop to 84', () => {
    const r = step(89, 69);
    expect(r.stop).toBe(84);
    expect(r.moved).toBe(true);
    expect(r.stepsReached).toBe(1);
    expect(r.lockedR).toBe(0.5);
  });

  it('2R (price 99) moves the stop to 94', () => {
    const r = step(99, 84);
    expect(r.stop).toBe(94);
    expect(r.lockedR).toBe(1.5);
  });

  it('3R (price 109) moves the stop to 104', () => {
    const r = step(109, 94);
    expect(r.stop).toBe(104);
    expect(r.lockedR).toBe(2.5);
  });

  it('keeps advancing beyond 3R on the same progression', () => {
    expect(step(119, 104).stop).toBe(114);
    expect(step(129, 114).stop).toBe(124);
  });

  it('walks the whole progression in sequence, exactly as specified', () => {
    let stop = 69;
    const path: number[] = [];
    for (const price of [89, 99, 109, 119]) {
      const r = step(price, stop);
      stop = r.stop;
      path.push(stop);
    }
    expect(path).toEqual([84, 94, 104, 114]);
  });
});

describe('the two invariants', () => {
  it('never moves the stop backwards on a retrace', () => {
    // Ratcheted to 94 at 2R, then price falls back to 1R territory. The
    // high-water mark is what the ratchet reads, so nothing relaxes.
    const afterPullback = step(99, 94);
    expect(afterPullback.stop).toBe(94);
    expect(afterPullback.moved).toBe(false);
    expect(afterPullback.reason).toContain('never move backwards');
  });

  it('never relaxes even if a caller passes a lower high-water mark', () => {
    // Defence against a restart replaying an old bar, or a bad feed.
    const r = step(89, 94);
    expect(r.stop).toBe(94);
    expect(r.moved).toBe(false);
  });

  it('counts steps from the high-water mark, not the current price', () => {
    // The mark is the input; there is no current-price parameter at all, which
    // is what makes relaxation unrepresentable rather than merely guarded.
    const r = step(109, 69);
    expect(r.stepsReached).toBe(3);
    expect(r.stop).toBe(104);
  });

  it('is idempotent — re-evaluating the same state changes nothing', () => {
    const first = step(99, 84);
    const second = step(99, first.stop);
    expect(first.stop).toBe(94);
    expect(second.stop).toBe(94);
    expect(second.moved).toBe(false);
  });
});

describe('the staircase', () => {
  it('does not pay out fractional steps', () => {
    // 1.9R has reached step 1, not 1.9. Otherwise the stop moves on every tick
    // and the trail becomes a moving average of the price.
    const r = step(98, 69);
    expect(r.stepsReached).toBe(1);
    expect(r.stop).toBe(84);
  });

  it('jumps straight to the right step when price gaps past several', () => {
    // A gap from below activation to 3R must not need three evaluations.
    const r = step(109, 69);
    expect(r.stepsReached).toBe(3);
    expect(r.stop).toBe(104);
  });
});

describe('shorts mirror everything', () => {
  const short = { direction: 'short' as const, entry: 79, initialRisk: 10 };

  it('holds until 1R', () => {
    expect(updateTrailingStop({ ...short, currentStop: 89, highWaterPrice: 70 }).moved).toBe(false);
  });

  it('ratchets downward through the same progression', () => {
    let stop = 89;
    const path: number[] = [];
    for (const price of [69, 59, 49]) {
      const r = updateTrailingStop({ ...short, currentStop: stop, highWaterPrice: price });
      stop = r.stop;
      path.push(stop);
    }
    expect(path).toEqual([74, 64, 54]);
  });

  it('never moves backwards', () => {
    const r = updateTrailingStop({ ...short, currentStop: 64, highWaterPrice: 69 });
    expect(r.stop).toBe(64);
    expect(r.moved).toBe(false);
  });
});

describe('configurability', () => {
  it('honours a different activation, lock and step', () => {
    // Conservative: activate at 2R, lock 1R, step 2R.
    const cfg: TrailingConfig = { initialRRMin: 3, activationR: 2, lockR: 1, stepR: 2 };
    expect(step(89, 69, cfg).moved).toBe(false); // 1R — under activation now
    const r = step(99, 69, cfg); // 2R → step 1 → locked (1×2 − 1) = 1R
    expect(r.stop).toBe(89);
    expect(r.lockedR).toBe(1);
  });

  it('exposes the 1:3 floor alongside the trail, in one config object', () => {
    // A trade-management contract split across files is one that gets changed
    // in some of them.
    expect(DEFAULT_TRAILING.initialRRMin).toBe(3);
    expect(DEFAULT_TRAILING.activationR).toBe(1);
    expect(DEFAULT_TRAILING.lockR).toBe(0.5);
    expect(DEFAULT_TRAILING.stepR).toBe(1);
  });
});

describe('it never leaves a position unmanaged', () => {
  it('holds the stop rather than throwing on zero or negative risk', () => {
    for (const initialRisk of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = updateTrailingStop({ ...EXAMPLE, initialRisk, currentStop: 69, highWaterPrice: 109 });
      expect(r.stop).toBe(69);
      expect(r.moved).toBe(false);
    }
  });

  it('holds the stop rather than throwing on a non-finite price', () => {
    const r = updateTrailingStop({ ...EXAMPLE, currentStop: 69, highWaterPrice: Number.NaN });
    expect(r.stop).toBe(69);
    expect(r.moved).toBe(false);
  });
});

describe('advanceHighWater', () => {
  it('takes the bar high for a long and the bar low for a short', () => {
    expect(advanceHighWater('long', 100, 105, 98)).toBe(105);
    expect(advanceHighWater('short', 100, 105, 98)).toBe(98);
  });

  it('never retreats', () => {
    expect(advanceHighWater('long', 110, 105, 98)).toBe(110);
    expect(advanceHighWater('short', 90, 105, 98)).toBe(90);
  });

  it('drives the ratchet deterministically over a bar sequence', () => {
    // The property that makes a backtest and a paper run agree: the same bars
    // produce the same stop sequence.
    const bars = [
      { high: 85, low: 78 },
      { high: 92, low: 84 },
      { high: 88, low: 86 }, // a pullback — the mark holds
      { high: 101, low: 90 },
    ];
    let hw = EXAMPLE.entry;
    let stop = 69;
    const stops: number[] = [];
    for (const b of bars) {
      hw = advanceHighWater('long', hw, b.high, b.low);
      stop = updateTrailingStop({ ...EXAMPLE, currentStop: stop, highWaterPrice: hw }).stop;
      stops.push(stop);
    }
    expect(stops).toEqual([69, 84, 84, 94]);
  });
});
