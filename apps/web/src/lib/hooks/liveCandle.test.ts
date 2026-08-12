import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import { bucketStart, istDayStart, mergeLiveCandle } from './liveCandle';

/**
 * The reported bug, reproduced with the real numbers from the screenshot.
 *
 * The dashboard card read NIFTY 24,283.15 while the chart's last-price line
 * read 24,471.70. The newest daily candle the bridge served was stamped
 * 2026-08-10T18:30:00Z (IST midnight opening 11 Aug) with close 24,471.70 —
 * 38 hours old — and the open session had no bar at all.
 */

const IST_MIDNIGHT_11_AUG = Date.parse('2026-08-10T18:30:00.000Z');
const IST_MIDNIGHT_12_AUG = Date.parse('2026-08-11T18:30:00.000Z');
/** 12 Aug 2026, 14:06 IST — mid-session, when the screenshot was taken. */
const DURING_SESSION_12_AUG = Date.parse('2026-08-12T08:36:00.000Z');

const candle = (ms: number, o: number, h: number, l: number, c: number): Candle => ({
  timestamp: new Date(ms),
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 100,
});

/** Exactly what /quotes returned while the screenshot was on screen. */
const LIVE_NIFTY = {
  ltp: 24280.25,
  open: 24472.45,
  high: 24473.3,
  low: 24265.95,
  marketStatus: 'open',
};

const DAILY_HISTORY = [
  candle(Date.parse('2026-08-09T18:30:00.000Z'), 24581.25, 24620.95, 24511.1, 24583.8),
  candle(IST_MIDNIGHT_11_AUG, 24575.1, 24576.85, 24429.25, 24471.7),
];

describe('the reported mismatch', () => {
  it("ends the series at the live price, not at yesterday's close", () => {
    const before = DAILY_HISTORY[DAILY_HISTORY.length - 1]!.close;
    expect(before).toBe(24471.7); // the number on the chart

    const merged = mergeLiveCandle(DAILY_HISTORY, LIVE_NIFTY, '1d', DURING_SESSION_12_AUG)!;

    expect(merged[merged.length - 1]!.close).toBe(24280.25); // the number on the card
  });

  it("opens today's bar rather than overwriting yesterday's", () => {
    const merged = mergeLiveCandle(DAILY_HISTORY, LIVE_NIFTY, '1d', DURING_SESSION_12_AUG)!;

    expect(merged).toHaveLength(DAILY_HISTORY.length + 1);
    // Yesterday's settled bar is untouched.
    expect(merged[merged.length - 2]).toEqual(DAILY_HISTORY[DAILY_HISTORY.length - 1]);
    expect(merged[merged.length - 1]!.timestamp.getTime()).toBe(IST_MIDNIGHT_12_AUG);
  });

  /** The daily quote carries the session's real OHL, so the bar is exact. */
  it("builds today's bar from the session's real open, high and low", () => {
    const merged = mergeLiveCandle(DAILY_HISTORY, LIVE_NIFTY, '1d', DURING_SESSION_12_AUG)!;
    const today = merged[merged.length - 1]!;

    expect(today.open).toBe(24472.45);
    expect(today.high).toBe(24473.3);
    expect(today.low).toBe(24265.95);
    expect(today.close).toBe(24280.25);
    // Session volume is not this bar's volume, so it is not copied.
    expect(today.volume).toBe(0);
  });

  it('keeps extending the same bar as ticks arrive, not adding one per tick', () => {
    let series = mergeLiveCandle(DAILY_HISTORY, LIVE_NIFTY, '1d', DURING_SESSION_12_AUG)!;
    const afterFirst = series.length;

    series = mergeLiveCandle(series, { ...LIVE_NIFTY, ltp: 24300 }, '1d', DURING_SESSION_12_AUG + 60_000)!;
    series = mergeLiveCandle(series, { ...LIVE_NIFTY, ltp: 24310 }, '1d', DURING_SESSION_12_AUG + 120_000)!;

    expect(series).toHaveLength(afterFirst);
    expect(series[series.length - 1]!.close).toBe(24310);
  });

  it('stretches the high when the live price exceeds it', () => {
    const merged = mergeLiveCandle(
      DAILY_HISTORY,
      { ...LIVE_NIFTY, ltp: 24999 },
      '1d',
      DURING_SESSION_12_AUG,
    )!;
    expect(merged[merged.length - 1]!.high).toBe(24999);
  });
});

describe('refusing to invent a bar', () => {
  it('changes nothing when the market is closed', () => {
    const merged = mergeLiveCandle(
      DAILY_HISTORY,
      { ...LIVE_NIFTY, marketStatus: 'closed' },
      '1d',
      DURING_SESSION_12_AUG,
    );
    expect(merged).toBe(DAILY_HISTORY);
  });

  it('changes nothing without a quote', () => {
    expect(mergeLiveCandle(DAILY_HISTORY, null, '1d', DURING_SESSION_12_AUG)).toBe(DAILY_HISTORY);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('ignores an unusable ltp (%s)', (ltp) => {
    expect(mergeLiveCandle(DAILY_HISTORY, { ...LIVE_NIFTY, ltp }, '1d', DURING_SESSION_12_AUG)).toBe(
      DAILY_HISTORY,
    );
  });

  /** No history means no chart at all — the no-fallback rule, still intact. */
  it('never conjures a series from nothing', () => {
    expect(mergeLiveCandle([], LIVE_NIFTY, '1d', DURING_SESSION_12_AUG)).toEqual([]);
    expect(mergeLiveCandle(null, LIVE_NIFTY, '1d', DURING_SESSION_12_AUG)).toBeNull();
  });

  it('does not rewrite history backwards if the clock disagrees', () => {
    const earlier = Date.parse('2026-08-01T08:00:00.000Z');
    expect(mergeLiveCandle(DAILY_HISTORY, LIVE_NIFTY, '1d', earlier)).toBe(DAILY_HISTORY);
  });

  it('returns the identical array when nothing moved, so React can skip work', () => {
    const flat = [candle(IST_MIDNIGHT_12_AUG, 24472.45, 24473.3, 24265.95, 24280.25)];
    expect(mergeLiveCandle(flat, LIVE_NIFTY, '1d', DURING_SESSION_12_AUG)).toBe(flat);
  });
});

describe('intraday buckets', () => {
  /**
   * The NSE session opens at 09:15 IST, so hourly bars run 09:15, 10:15, 11:15.
   * Epoch-aligned hour buckets are fifteen minutes out and would put the forming
   * bar in a slot no real bar ever occupies.
   */
  it('keeps the session phase instead of snapping to the epoch grid', () => {
    const nineFifteen = Date.parse('2026-08-12T03:45:00.000Z'); // 09:15 IST
    const tenThirty = Date.parse('2026-08-12T05:00:00.000Z'); // 10:30 IST
    expect(bucketStart(tenThirty, nineFifteen, 60)).toBe(Date.parse('2026-08-12T04:45:00.000Z')); // 10:15 IST
  });

  it('extends the current bucket in place', () => {
    const bar = candle(Date.parse('2026-08-12T08:30:00.000Z'), 24290, 24295, 24285, 24288);
    const merged = mergeLiveCandle(
      [bar],
      { ltp: 24299, marketStatus: 'open' },
      '15m',
      Date.parse('2026-08-12T08:36:00.000Z'),
    )!;

    expect(merged).toHaveLength(1);
    expect(merged[0]!.open).toBe(24290); // never rewritten
    expect(merged[0]!.close).toBe(24299);
    expect(merged[0]!.high).toBe(24299);
  });

  /**
   * The session's open/high/low describe the whole day. Using them for a
   * five-minute bucket would draw the day's entire range inside one slot.
   */
  it('starts a new intraday bucket flat, not at the session range', () => {
    const bar = candle(Date.parse('2026-08-12T08:00:00.000Z'), 24290, 24295, 24285, 24288);
    const merged = mergeLiveCandle([bar], LIVE_NIFTY, '15m', Date.parse('2026-08-12T08:36:00.000Z'))!;

    const formed = merged[merged.length - 1]!;
    expect(merged).toHaveLength(2);
    expect(formed.open).toBe(24280.25);
    expect(formed.high).toBe(24280.25);
    expect(formed.low).toBe(24280.25);
    expect(formed.close).toBe(24280.25);
  });
});

describe('istDayStart', () => {
  it('stamps a daily bar at IST midnight, which is 18:30 UTC the day before', () => {
    expect(istDayStart(DURING_SESSION_12_AUG)).toBe(IST_MIDNIGHT_12_AUG);
    expect(new Date(istDayStart(DURING_SESSION_12_AUG)).toISOString()).toBe('2026-08-11T18:30:00.000Z');
  });

  it('does not roll the day over during the session', () => {
    const open = Date.parse('2026-08-12T03:45:00.000Z'); // 09:15 IST
    const close = Date.parse('2026-08-12T10:00:00.000Z'); // 15:30 IST
    expect(istDayStart(open)).toBe(istDayStart(close));
  });
});
