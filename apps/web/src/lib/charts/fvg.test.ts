import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import { detectFVG, isMitigated, nearestGaps, openGaps, toZoneDrawings } from './fvg';

/**
 * A fair value gap is arithmetic, so it is asserted as arithmetic.
 *
 * The cases that matter are the ones that look right on a screenshot and are
 * wrong in the numbers: a gap mitigated by the very candle that created it, a
 * bearish gap tested with the bullish rule (which silently halves detection),
 * and a zone that keeps growing after price has already come back through it.
 */

const MINUTE = 60;
const T0 = 1_700_000_000;

function candle(index: number, high: number, low: number, close = (high + low) / 2): Candle {
  return {
    timestamp: new Date((T0 + index * 15 * MINUTE) * 1000),
    open: (high + low) / 2,
    high,
    low,
    close,
    volume: 1000,
  };
}

/** Three bars with a clean bullish gap: bar 0 tops at 100, bar 2 bottoms at 110. */
const BULLISH: Candle[] = [candle(0, 100, 95), candle(1, 112, 99), candle(2, 115, 110)];

/** Mirror image: bar 0 bottoms at 110, bar 2 tops at 100. */
const BEARISH: Candle[] = [candle(0, 115, 110), candle(1, 111, 98), candle(2, 100, 95)];

describe('detectFVG', () => {
  it('finds a bullish gap between the first bar high and the third bar low', () => {
    const [gap, ...rest] = detectFVG(BULLISH);
    expect(rest).toHaveLength(0);
    expect(gap).toMatchObject({ direction: 'bullish', bottom: 100, top: 110 });
  });

  it('finds a bearish gap between the third bar high and the first bar low', () => {
    const [gap] = detectFVG(BEARISH);
    expect(gap).toMatchObject({ direction: 'bearish', bottom: 100, top: 110 });
  });

  it('finds nothing when the first and third bars overlap', () => {
    const overlapping = [candle(0, 100, 95), candle(1, 112, 99), candle(2, 115, 99)];
    expect(detectFVG(overlapping)).toHaveLength(0);
  });

  it('finds nothing when the bars merely touch', () => {
    // a.high === c.low is contiguous trade, not a skipped band. Using >= here
    // would manufacture a zero-height gap on every trending series.
    const touching = [candle(0, 100, 95), candle(1, 112, 99), candle(2, 115, 100)];
    expect(detectFVG(touching)).toHaveLength(0);
  });

  it('returns nothing for fewer than three bars', () => {
    expect(detectFVG(BULLISH.slice(0, 2))).toHaveLength(0);
    expect(detectFVG([])).toHaveLength(0);
  });

  it('reports the first bar of the three as the start time', () => {
    expect(detectFVG(BULLISH)[0].startTime).toBe(T0);
    expect(detectFVG(BULLISH)[0].formedAt).toBe(T0 + 2 * 15 * MINUTE);
  });

  it('reports every gap by default — no hidden size threshold', () => {
    const tiny = [candle(0, 100, 95), candle(1, 100.5, 99), candle(2, 101, 100.01)];
    expect(detectFVG(tiny)).toHaveLength(1);
  });

  it('applies a size filter only when one is asked for', () => {
    const tiny = [candle(0, 100, 95), candle(1, 100.5, 99), candle(2, 101, 100.01)];
    // Gap is 0.01 wide on a ~100 close — 0.0001 of price.
    expect(detectFVG(tiny, { minSizeFraction: 0.01 })).toHaveLength(0);
    expect(detectFVG(tiny, { minSizeFraction: 0.00001 })).toHaveLength(1);
  });
});

describe('isMitigated', () => {
  const gap = { direction: 'bullish' as const, top: 110, bottom: 100, formedAt: T0 + 2 * 15 * MINUTE };

  it('does not count the candle that created the gap', () => {
    // The regression that matters: bar 2's low IS the top of a bullish gap, so
    // including it marks every gap mitigated the instant it is detected.
    expect(isMitigated(gap, BULLISH).mitigatedAt).toBeNull();
  });

  it('marks mitigation when a later bar dips into the band', () => {
    const withRetest = [...BULLISH, candle(3, 114, 108)];
    expect(isMitigated(gap, withRetest).mitigatedAt).toBe(T0 + 3 * 15 * MINUTE);
  });

  it('separates touched from filled', () => {
    const poke = [...BULLISH, candle(3, 114, 108)];
    const result = isMitigated(gap, poke);
    expect(result.mitigatedAt).not.toBeNull();
    // Price entered but never traversed — reporting this as filled would
    // overstate how much of the move was retraced.
    expect(result.filledAt).toBeNull();

    const through = [...BULLISH, candle(3, 114, 99)];
    expect(isMitigated(gap, through).filledAt).toBe(T0 + 3 * 15 * MINUTE);
  });

  it('uses the high, not the low, to test a bearish gap', () => {
    const bearGap = { direction: 'bearish' as const, top: 110, bottom: 100, formedAt: T0 + 2 * 15 * MINUTE };
    // A bar rising back into a bearish gap. Tested with the bullish rule
    // (low <= top) this bar would also "match" for the wrong reason, so the
    // case that proves the rule is one where only the high enters the band.
    const retest = [...BEARISH, candle(3, 105, 101)];
    expect(isMitigated(bearGap, retest).mitigatedAt).toBe(T0 + 3 * 15 * MINUTE);

    // And a bar that stays entirely below the band must not mitigate it.
    const belowOnly = [...BEARISH, candle(3, 99, 90)];
    expect(isMitigated(bearGap, belowOnly).mitigatedAt).toBeNull();
  });

  it('reports the FIRST bar to enter, not the last', () => {
    const twice = [...BULLISH, candle(3, 114, 108), candle(4, 113, 105)];
    expect(isMitigated(gap, twice).mitigatedAt).toBe(T0 + 3 * 15 * MINUTE);
  });
});

describe('openGaps', () => {
  it('keeps only untouched gaps', () => {
    const gaps = detectFVG([...BULLISH, candle(3, 114, 108)]);
    expect(gaps).toHaveLength(1);
    expect(openGaps(gaps)).toHaveLength(0);
  });
});

describe('nearestGaps', () => {
  const gaps = detectFVG(BULLISH);

  it('measures distance to the nearest edge, and zero inside the band', () => {
    const far = { ...gaps[0], top: 200, bottom: 190 };
    const ordered = nearestGaps([far, gaps[0]], 105, 2);
    // 105 is inside 100–110, so that gap ranks first even though the other
    // band's midpoint is not much further from the price.
    expect(ordered[0].top).toBe(110);
  });

  it('caps the list without mutating the input', () => {
    const input = detectFVG(BULLISH);
    expect(nearestGaps(input, 105, 0)).toHaveLength(0);
    expect(input).toHaveLength(1);
  });
});

describe('toZoneDrawings', () => {
  it('leaves an open gap extending to the right edge', () => {
    const [zone] = toZoneDrawings(detectFVG(BULLISH));
    expect(zone.endTime).toBeNull();
    expect(zone.tag).toBe('fvg');
    expect(zone.label).toBe('FVG');
  });

  it('stops a mitigated gap at the bar that entered it', () => {
    const [zone] = toZoneDrawings(detectFVG([...BULLISH, candle(3, 114, 108)]));
    expect(zone.endTime).toBe(T0 + 3 * 15 * MINUTE);
    expect(zone.label).toBe('FVG · mitigated');
  });

  it('produces stable ids across re-runs so the chart diff does not churn', () => {
    const a = toZoneDrawings(detectFVG(BULLISH)).map((z) => z.id);
    const b = toZoneDrawings(detectFVG([...BULLISH, candle(3, 120, 118)])).map((z) => z.id);
    expect(b).toEqual(expect.arrayContaining(a));
  });
});
