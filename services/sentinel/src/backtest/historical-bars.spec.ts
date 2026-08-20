import { describe, expect, it } from 'vitest';
import { analyseCoverage, findIntraSessionGaps, tradingDatesBetween, type StoredBar } from './historical-bars';

/**
 * Coverage is part of the result, not a diagnostic.
 *
 * The failure these tests exist to prevent is the quiet one: a window that
 * asked for twenty sessions and got nine produces a perfectly plausible equity
 * curve, and nothing in the numbers says which twenty-session period it is
 * really describing.
 */

const WRITE = new Date('2026-08-01T00:00:00Z');

function bar(iso: string, source = 'dhan'): StoredBar {
  return {
    bucketStart: new Date(iso),
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10,
    openInterest: null,
    source,
    createdAt: WRITE,
  };
}

describe('analyseCoverage', () => {
  it('reports an empty window as empty, and names every trading day it wanted', () => {
    // 2026-05-04 Mon .. 2026-05-08 Fri — five trading days, no bars.
    const c = analyseCoverage([], '15m', new Date('2026-05-04T00:00:00Z'), new Date('2026-05-08T23:59:00Z'));
    expect(c.empty).toBe(true);
    expect(c.barCount).toBe(0);
    expect(c.firstBarAt).toBeNull();
    expect(c.missingSessions.length).toBeGreaterThanOrEqual(4);
  });

  it('does not count weekends as missing sessions', () => {
    // 2026-05-09 and 2026-05-10 are Saturday and Sunday.
    const c = analyseCoverage([], '15m', new Date('2026-05-09T00:00:00Z'), new Date('2026-05-10T23:59:00Z'));
    expect(c.missingSessions).toEqual([]);
  });

  it('names the sessions that produced no bar, and only those', () => {
    // Bars on 05-04 and 05-06 only; 05-05, 05-07, 05-08 are missing.
    const bars = [
      bar('2026-05-04T04:00:00Z'),
      bar('2026-05-04T04:15:00Z'),
      bar('2026-05-06T04:00:00Z'),
    ];
    const c = analyseCoverage(bars, '15m', new Date('2026-05-04T00:00:00Z'), new Date('2026-05-08T23:59:00Z'));
    expect(c.empty).toBe(false);
    expect(c.barCount).toBe(3);
    expect(c.sessionCount).toBe(2);
    expect(c.missingSessions).toContain('2026-05-05');
    expect(c.missingSessions).toContain('2026-05-07');
    expect(c.missingSessions).not.toContain('2026-05-04');
    expect(c.missingSessions).not.toContain('2026-05-06');
  });

  it('reports every distinct source, so a mixed-provenance window is visible', () => {
    const bars = [bar('2026-05-04T04:00:00Z', 'dhan'), bar('2026-05-04T04:15:00Z', 'nse-bhavcopy')];
    const c = analyseCoverage(bars, '15m', new Date('2026-05-04T00:00:00Z'), new Date('2026-05-04T23:59:00Z'));
    expect(c.source).toBe('dhan,nse-bhavcopy');
  });

  it('moves dataVersion when bars are added, and not when they are not', () => {
    const from = new Date('2026-05-04T00:00:00Z');
    const to = new Date('2026-05-04T23:59:00Z');
    const two = [bar('2026-05-04T04:00:00Z'), bar('2026-05-04T04:15:00Z')];
    const same = analyseCoverage(two, '15m', from, to).dataVersion;
    expect(analyseCoverage(two, '15m', from, to).dataVersion).toBe(same);

    const three = [...two, bar('2026-05-04T04:30:00Z')];
    expect(analyseCoverage(three, '15m', from, to).dataVersion).not.toBe(same);

    // A repair that rewrites rows without inserting any still moves it.
    const rewritten = two.map((b) => ({ ...b, createdAt: new Date('2026-08-19T00:00:00Z') }));
    expect(analyseCoverage(rewritten, '15m', from, to).dataVersion).not.toBe(same);
  });

  it('refuses unordered bars rather than silently sorting them', () => {
    const bars = [bar('2026-05-04T04:15:00Z'), bar('2026-05-04T04:00:00Z')];
    expect(() =>
      analyseCoverage(bars, '15m', new Date('2026-05-04T00:00:00Z'), new Date('2026-05-04T23:59:00Z')),
    ).toThrow(/ascending/);
  });
});

describe('findIntraSessionGaps', () => {
  it('finds a hole inside a session and counts the missing bars', () => {
    // 04:00, 04:15, then a jump to 05:00 — two 15m bars missing.
    const bars = [bar('2026-05-04T04:00:00Z'), bar('2026-05-04T04:15:00Z'), bar('2026-05-04T05:00:00Z')];
    const gaps = findIntraSessionGaps(bars, '15m');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].missingBars).toBe(2);
  });

  it('does not report the overnight break as a gap', () => {
    const bars = [bar('2026-05-04T09:45:00Z'), bar('2026-05-05T04:00:00Z')];
    expect(findIntraSessionGaps(bars, '15m')).toEqual([]);
  });

  it('reports nothing for daily bars — there is no intra-session concept', () => {
    const bars = [bar('2026-05-04T00:00:00Z'), bar('2026-05-11T00:00:00Z')];
    expect(findIntraSessionGaps(bars, '1d')).toEqual([]);
  });
});

describe('tradingDatesBetween', () => {
  it('excludes weekends', () => {
    const days = tradingDatesBetween(new Date('2026-05-04T00:00:00Z'), new Date('2026-05-10T23:59:00Z'));
    expect(days).toContain('2026-05-04');
    expect(days).toContain('2026-05-08');
    expect(days).not.toContain('2026-05-09');
    expect(days).not.toContain('2026-05-10');
  });

  it('returns nothing for an inverted range instead of looping', () => {
    expect(tradingDatesBetween(new Date('2026-05-10T00:00:00Z'), new Date('2026-05-04T00:00:00Z'))).toEqual([]);
  });
});
