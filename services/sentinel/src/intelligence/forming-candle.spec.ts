import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import {
  INTERVAL_MS,
  SNAPSHOT_INTERVAL,
  composeSnapshot,
  latestBarAt,
  latestDataAt,
  liveCandles,
  splitClosedAndForming,
} from './market-intelligence.service';
import { STRATEGY_RULES } from './strategy-rules';

/**
 * The still-forming bar, and why it is not allowed near a rule.
 *
 * The market-data bridge returns the in-progress bar as the final element of
 * every intraday series during market hours. It is a real bar in the sense
 * that it is really being traded — and not a real bar in the sense that
 * matters to a rule: its range is narrower than the finished bar's will be,
 * its volume lower, its close not yet a close. A rule that measures it is
 * measuring how far into the fifteen minutes the poll happened to land.
 *
 * `services/sentinel-py/app/watch/evaluator.py` has dropped it since it was
 * written (`closed_candles`). These are the same guarantees for the TypeScript
 * agent path, plus the two the Python version does not need: that an
 * out-of-hours snapshot keeps its last real bar, and that the spot price stays
 * live even though every bar measurement no longer is.
 */

// A Tuesday. 09:15 IST is 03:45 UTC — the first 15m bar of an NSE session.
const SESSION_OPEN = new Date('2026-08-04T03:45:00.000Z');
const BAR_MS = INTERVAL_MS[SNAPSHOT_INTERVAL];

/** The `n`th 15m bar of that session, by its OPEN time — as the bridge sends it. */
function barAt(n: number, over: Partial<Omit<Candle, 'timestamp'>> = {}): Candle {
  return {
    timestamp: new Date(SESSION_OPEN.getTime() + n * BAR_MS),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1_000,
    ...over,
  };
}

/** A session of `count` ordinary bars, oldest first. */
function session(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => barAt(i));
}

/** The instant `minutes` into the bar that opened `n` slots after the bell. */
function during(n: number, minutes: number): Date {
  return new Date(SESSION_OPEN.getTime() + n * BAR_MS + minutes * 60_000);
}

const NO_EXTERNAL = { vix: null, breadthRatio: null, optionChain: null };

describe('splitClosedAndForming', () => {
  it('drops the trailing bar while the clock is still inside it', () => {
    const bars = session(5);
    // 09:15 + 4 bars = 10:15, and we are at 10:22 — seven minutes in.
    const { closed, forming } = splitClosedAndForming(bars, '15m', during(4, 7));

    expect(closed).toHaveLength(4);
    expect(forming).toBe(bars[4]);
  });

  it('keeps the trailing bar the instant it closes', () => {
    const bars = session(5);
    // Exactly `open + interval`. The bar is finished; nothing is in progress.
    const { closed, forming } = splitClosedAndForming(bars, '15m', during(4, 15));

    expect(closed).toHaveLength(5);
    expect(forming).toBeNull();
  });

  it('keeps every bar of an out-of-hours series', () => {
    const bars = session(25); // a full NSE session, 09:15 to 15:30
    const afterTheClose = new Date('2026-08-04T14:00:00.000Z'); // 19:30 IST
    const { closed, forming } = splitClosedAndForming(bars, '15m', afterTheClose);

    expect(closed).toHaveLength(25);
    expect(closed[24]).toBe(bars[24]);
    expect(forming).toBeNull();
  });

  it('keeps every bar of a historical series — the backtest replay case', () => {
    const bars = session(60);
    const monthsLater = new Date('2026-11-04T09:00:00.000Z');
    const { closed, forming } = splitClosedAndForming(bars, '15m', monthsLater);

    expect(closed).toHaveLength(60);
    expect(forming).toBeNull();
  });

  it('scales with the interval rather than assuming 15m', () => {
    const opened = SESSION_OPEN.getTime() + 60_000;
    const bars = [
      { ...barAt(0), timestamp: new Date(SESSION_OPEN) },
      { ...barAt(0), timestamp: new Date(opened) },
    ];
    // Ninety seconds after that last bar opened: past a 1m bar's close, well
    // inside a 15m one. Same bars, same clock — the interval is the whole
    // difference, which is why it is a parameter and not a constant.
    const ninetySecondsIn = new Date(opened + 90_000);

    expect(splitClosedAndForming(bars, '1m', ninetySecondsIn).forming).toBeNull();
    expect(splitClosedAndForming(bars, '15m', ninetySecondsIn).forming).toBe(bars[1]);
  });

  it('is a no-op on an empty series', () => {
    expect(splitClosedAndForming([], '15m', new Date())).toEqual({ closed: [], forming: null });
  });

  it('keeps a bar whose timestamp cannot be read rather than guessing', () => {
    // The provider chain includes JSON hops. An unreadable timestamp is a
    // reason to leave the data alone, not to throw a real bar away.
    const bars = [...session(3), { ...barAt(3), timestamp: new Date('nonsense') }];
    const { closed, forming } = splitClosedAndForming(bars, '15m', during(3, 7));

    expect(closed).toHaveLength(4);
    expect(forming).toBeNull();
  });
});

describe('composeSnapshot — which bars reach a rule', () => {
  it('excludes the in-progress bar during market hours', () => {
    const bars = session(30);
    const snapshot = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, {
      interval: '15m',
      now: during(29, 3),
    });

    expect(snapshot.candles).toHaveLength(29);
    expect(snapshot.candles.at(-1)).toBe(bars[28]);
    expect(snapshot.formingCandle).toBe(bars[29]);
    expect(snapshot.sessionCandles).not.toContain(bars[29]);
  });

  it('does not lose the final bar in a snapshot built after the close', () => {
    const bars = session(25);
    const snapshot = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, {
      interval: '15m',
      now: new Date('2026-08-04T14:00:00.000Z'),
    });

    expect(snapshot.candles).toHaveLength(25);
    expect(snapshot.candles.at(-1)).toBe(bars[24]);
    expect(snapshot.formingCandle).toBeNull();
  });

  it('keeps `lastPrice` live — the one field that reads the forming bar', () => {
    const bars = [...session(29), barAt(29, { close: 137.5 })];
    const snapshot = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, {
      interval: '15m',
      now: during(29, 3),
    });

    // The spot picks the ATM strike and prices the candidate contract, so it
    // must be the traded price and not the last close of fifteen minutes ago.
    expect(snapshot.lastPrice).toBe(137.5);
    expect(snapshot.candles.at(-1)!.close).toBe(100);
  });

  it('falls back to the last closed bar for `lastPrice` when nothing is forming', () => {
    const bars = [...session(24), barAt(24, { close: 142 })];
    const snapshot = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, {
      interval: '15m',
      now: new Date('2026-08-04T14:00:00.000Z'),
    });

    expect(snapshot.lastPrice).toBe(142);
    expect(snapshot.formingCandle).toBeNull();
  });

  it('computes indicators from the closed bars only', () => {
    const bars = session(30);
    const live = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, {
      interval: '15m',
      now: during(29, 3),
    });
    // The same series once its final bar has finished — the snapshot the
    // engine would have built one tick later, from identical data.
    const settled = composeSnapshot('NIFTY', bars.slice(0, 29), null, NO_EXTERNAL, {
      interval: '15m',
      now: during(29, 0),
    });

    expect(live.vwap).toBe(settled.vwap);
    expect(live.volumeVsAvg).toBe(settled.volumeVsAvg);
    expect(live.rsi14).toBe(settled.rsi14);
    expect(live.support).toBe(settled.support);
    expect(live.resistance).toBe(settled.resistance);
  });

  it('leaves the backtest replay path untouched when no clock is supplied', () => {
    // `composeSnapshot`'s default `now` is the real clock. Replayed history is
    // long finished by then, so the default must drop nothing.
    const bars = session(40);
    const snapshot = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL);

    expect(snapshot.candles).toHaveLength(40);
    expect(snapshot.formingCandle).toBeNull();
  });
});

describe('rules no longer read a half-written bar', () => {
  /**
   * The failure this whole change is about: the SAME bar, sampled at two
   * points in its own fifteen minutes, used to give two different answers.
   *
   * `volume_supports_move` compares the newest bar's volume against the 20-bar
   * average. Three minutes into a bar the tape has posted a fifth of its
   * volume, so the rule said "no". Fourteen minutes in it had posted twice the
   * average, so the rule said "yes" — about a bar that had not closed either
   * time, on evidence that was never a market fact.
   */
  it('gives the same answer early and late in the same forming bar', () => {
    const bars = [...session(29), barAt(29, { volume: 200 })];
    const later = [...session(29), barAt(29, { volume: 2_000 })];

    const early = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, {
      interval: '15m',
      now: during(29, 3),
    });
    const late = composeSnapshot('NIFTY', later, null, NO_EXTERNAL, {
      interval: '15m',
      now: during(29, 14),
    });

    const rule = STRATEGY_RULES.volume_supports_move;
    expect(rule(early).ok).toBe(rule(late).ok);
    expect(rule(early).note).toBe(rule(late).note);
  });

  it('reads displacement from the finished bar, not the one being written', () => {
    // A wide, decisive bar still in progress. Before this change
    // `displacement_bar` measured it and could fire on a range the bar had not
    // finished making.
    const bars = [...session(29), barAt(29, { high: 130, low: 70, close: 129 })];
    const snapshot = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, {
      interval: '15m',
      now: during(29, 2),
    });

    const outcome = STRATEGY_RULES.displacement_bar(snapshot);
    expect(outcome.ok).toBe(false);
    // And the bar itself is not discarded — it is simply not yet evidence.
    expect(snapshot.formingCandle!.high).toBe(130);
  });

  it('measures a sweep against the last CLOSED bar', () => {
    // A forming bar whose wick has poked below the 20-bar low. Mid-bar that is
    // not a sweep, it is a wick that may yet become anything.
    const bars = [...session(29), barAt(29, { low: 50, close: 100 })];
    const snapshot = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, {
      interval: '15m',
      now: during(29, 4),
    });

    expect(STRATEGY_RULES.liquidity_pool_swept(snapshot).ok).toBe(false);
    expect(snapshot.candles.some((c) => c.low === 50)).toBe(false);
  });
});

describe('the two clocks a snapshot carries', () => {
  it('stamps market events on the closed bar and freshness on the live one', () => {
    const bars = session(30);
    const snapshot = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, {
      interval: '15m',
      now: during(29, 6),
    });

    // `latestBarAt` answers "when did the market do this?" — the closed bar.
    expect(latestBarAt(snapshot)).toEqual(bars[28].timestamp);
    // `latestDataAt` answers "how live is this read?" — the forming bar.
    expect(latestDataAt(snapshot)).toEqual(bars[29].timestamp);
  });

  it('collapses to the same answer once nothing is forming', () => {
    const bars = session(25);
    const snapshot = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, {
      interval: '15m',
      now: new Date('2026-08-04T14:00:00.000Z'),
    });

    expect(latestDataAt(snapshot)).toEqual(latestBarAt(snapshot));
  });

  it('keeps the freshness clock inside the allowance all the way through a bar', () => {
    // The regression this guards: had the freshness gate kept reading
    // `latestBarAt`, a poll late in a 15m bar would report the newest bar as
    // ~29 minutes old against a 30-minute allowance, and any delay past that
    // would call a live market `stale-data`.
    const bars = session(30);
    const now = during(29, 14);
    const snapshot = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, { interval: '15m', now });

    const ageMinutes = (at: Date | null) =>
      at === null ? Infinity : Math.floor((now.getTime() - at.getTime()) / 60_000);

    expect(ageMinutes(latestDataAt(snapshot))).toBe(14);
    expect(ageMinutes(latestBarAt(snapshot))).toBe(29);
  });

  it('reports null on a snapshot with no bars at all', () => {
    const snapshot = composeSnapshot('NIFTY', [], null, NO_EXTERNAL);
    expect(latestBarAt(snapshot)).toBeNull();
    expect(latestDataAt(snapshot)).toBeNull();
  });
});

describe('liveCandles', () => {
  it('puts the forming bar back for the consumers that draw or compare', () => {
    const bars = session(30);
    const snapshot = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, {
      interval: '15m',
      now: during(29, 6),
    });

    expect(liveCandles(snapshot)).toHaveLength(30);
    expect(liveCandles(snapshot).at(-1)).toBe(bars[29]);
    // And it does not mutate what the rules read.
    expect(snapshot.candles).toHaveLength(29);
  });

  it('returns the closed bars unchanged when nothing is forming', () => {
    const bars = session(25);
    const snapshot = composeSnapshot('NIFTY', bars, null, NO_EXTERNAL, {
      interval: '15m',
      now: new Date('2026-08-04T14:00:00.000Z'),
    });

    expect(liveCandles(snapshot)).toEqual(snapshot.candles);
  });
});
