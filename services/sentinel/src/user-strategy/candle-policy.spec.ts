import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import {
  closedCandles,
  gateBar,
  intervalMs,
  isForming,
  newestClosedBar,
  resolveInterval,
} from './candle-policy';

/**
 * The two invariants the autonomous path depends on: only closed bars are
 * evaluated, and each closed bar is evaluated at most once.
 *
 * The second is the duplicate-entry defence AND the restart-recovery
 * mechanism, so its assertions matter more than their size suggests.
 */

const T0 = Date.UTC(2026, 7, 31, 4, 0); // 09:30 IST
function bar(minuteOffset: number, close = 100): Candle {
  return {
    timestamp: new Date(T0 + minuteOffset * 60_000),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  };
}
/** `n` five-minute bars starting at T0. */
const series = (n: number) => Array.from({ length: n }, (_, i) => bar(i * 5));
const at = (minuteOffset: number) => new Date(T0 + minuteOffset * 60_000);

describe('resolveInterval', () => {
  it('accepts the supported set, case- and whitespace-insensitively', () => {
    expect(resolveInterval('5m')).toBe('5m');
    expect(resolveInterval(' 15M ')).toBe('15m');
    expect(resolveInterval('1h')).toBe('1h');
  });

  it('returns null rather than a default for anything else', () => {
    // The whole point: a strategy whose timeframe cannot be honoured must be
    // refused, never quietly run on a different clock.
    expect(resolveInterval('3m')).toBeNull();
    expect(resolveInterval('1d')).toBeNull(); // daily is not an intraday agent timeframe
    expect(resolveInterval('')).toBeNull();
    expect(resolveInterval(null)).toBeNull();
    expect(resolveInterval(undefined)).toBeNull();
  });
});

describe('isForming', () => {
  it('is true until the bar’s window has elapsed', () => {
    const b = bar(0); // covers 04:00–04:05
    expect(isForming(b, '5m', at(2))).toBe(true);
    expect(isForming(b, '5m', at(4.9))).toBe(true);
    expect(isForming(b, '5m', at(5))).toBe(false); // closed exactly at the boundary
    expect(isForming(b, '5m', at(9))).toBe(false);
  });

  it('treats a future-stamped bar as forming', () => {
    // Clock skew, or a provider stamping bars by close. The safe failure is to
    // wait one more poll, never to trade a partial bar.
    expect(isForming(bar(10), '5m', at(0))).toBe(true);
  });
});

describe('closedCandles', () => {
  it('drops the forming trailing bar during market hours', () => {
    const candles = series(5); // bars at 0,5,10,15,20
    // 04:22 — the 04:20 bar is still forming.
    expect(closedCandles(candles, '5m', at(22))).toHaveLength(4);
  });

  it('drops NOTHING when every bar has closed', () => {
    // The failure the conditional form exists to prevent: an unconditional
    // slice(0,-1) would silently discard the most recent real bar after hours
    // and in replay.
    const candles = series(5);
    expect(closedCandles(candles, '5m', at(600))).toHaveLength(5);
  });

  it('drops more than one when a provider returns several unfinished bars', () => {
    // Bars open at 0,5,10,15,20. At 04:12 the 10, 15 and 20 bars have all not
    // finished, so three go rather than the usual one.
    const candles = series(5);
    expect(closedCandles(candles, '5m', at(12))).toHaveLength(2);
  });

  it('can return empty rather than inventing a bar', () => {
    expect(closedCandles(series(1), '5m', at(1))).toEqual([]);
    expect(closedCandles([], '5m', at(1))).toEqual([]);
  });

  it('newestClosedBar reads the last surviving bar', () => {
    expect(newestClosedBar(series(5), '5m', at(22))?.timestamp).toEqual(new Date(T0 + 15 * 60_000));
    expect(newestClosedBar([], '5m', at(1))).toBeNull();
  });
});

describe('gateBar', () => {
  const base = { interval: '5m' as const, minBars: 3, lastEvaluatedBarTime: null };

  it('admits a new closed bar with enough history', () => {
    const r = gateBar({ ...base, candles: series(6), now: at(27) });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.bar!.timestamp).toEqual(new Date(T0 + 20 * 60_000));
  });

  it('refuses when there are no candles at all', () => {
    expect(gateBar({ ...base, candles: [], now: at(27) }).reason).toBe('no-candles');
  });

  it('refuses when nothing has closed yet', () => {
    expect(gateBar({ ...base, candles: series(1), now: at(2) }).reason).toBe('no-closed-bar');
  });

  it('refuses on insufficient history rather than judging on too few bars', () => {
    const r = gateBar({ ...base, candles: series(3), now: at(12), minBars: 10 });
    expect(r.reason).toBe('insufficient-history');
    expect(r.detail).toContain('needs 10');
  });

  it('REFUSES a stale bar rather than treating it as current', () => {
    // Acting on the last bar a dead feed produced is how an agent trades a
    // market that has moved on without it.
    const r = gateBar({ ...base, candles: series(6), now: at(120) });
    expect(r.reason).toBe('stale-bar');
    expect(r.eligible).toBe(false);
  });

  it('measures staleness from the bar’s CLOSE, not its open', () => {
    // A 5m bar stamped 04:20 is not 6 minutes stale at 04:26 — it closed at
    // 04:25. Default tolerance is three bars (15m).
    // Bars open 0..25; at 04:39 the newest CLOSED bar is the 04:25 one, which
    // closed at 04:30 — so it is 9 minutes old, not 14. Default budget is
    // three bars (15m), so staleness begins after 04:45.
    const candles = series(6);
    expect(gateBar({ ...base, candles, now: at(39) }).eligible).toBe(true); // 9m after close
    expect(gateBar({ ...base, candles, now: at(47) }).reason).toBe('stale-bar'); // 17m after close
  });

  it('refuses a bar it has already evaluated — the duplicate-entry defence', () => {
    const candles = series(6);
    const first = gateBar({ ...base, candles, now: at(27) });
    expect(first.eligible).toBe(true);

    const again = gateBar({ ...base, candles, now: at(28), lastEvaluatedBarTime: first.bar!.timestamp });
    expect(again.eligible).toBe(false);
    expect(again.reason).toBe('already-evaluated');
  });

  it('admits the NEXT bar once it closes', () => {
    const candles = series(7);
    const previous = new Date(T0 + 20 * 60_000);
    const r = gateBar({ ...base, candles, now: at(32), lastEvaluatedBarTime: previous });
    expect(r.eligible).toBe(true);
    expect(r.bar!.timestamp).toEqual(new Date(T0 + 25 * 60_000));
  });

  it('does not re-fire on an OLDER bar after a restart with a newer marker', () => {
    // Restart recovery: a persisted marker ahead of the data must not be
    // undone by a short candle window arriving first.
    const r = gateBar({
      ...base,
      candles: series(6),
      now: at(27),
      lastEvaluatedBarTime: new Date(T0 + 60 * 60_000),
    });
    expect(r.reason).toBe('already-evaluated');
  });

  it('honours an explicit staleness budget over the default', () => {
    const candles = series(6);
    expect(gateBar({ ...base, candles, now: at(35), maxBarAgeMs: 60_000 }).reason).toBe('stale-bar');
    expect(gateBar({ ...base, candles, now: at(35), maxBarAgeMs: 60 * 60_000 }).eligible).toBe(true);
  });

  it('intervalMs is the coverage of one bar', () => {
    expect(intervalMs('1m')).toBe(60_000);
    expect(intervalMs('5m')).toBe(300_000);
    expect(intervalMs('15m')).toBe(900_000);
    expect(intervalMs('1h')).toBe(3_600_000);
  });
});
