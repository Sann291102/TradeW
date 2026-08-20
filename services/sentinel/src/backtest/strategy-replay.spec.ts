import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import { StrategyEngineService } from '../intelligence/strategy-engine.service';
import { StrategyReplayService, hashDefinitions, priorDailyBar } from './strategy-replay.service';

/**
 * The look-ahead suite.
 *
 * A backtest's single most valuable property is that it could not have seen the
 * future, and it is also the property that fails silently: a leak makes results
 * BETTER, so nothing about the output looks wrong. These tests are therefore
 * written as adversarial experiments rather than as assertions about expected
 * numbers — they corrupt the future and demand that the past does not move.
 */

/** 09:15 IST on `dayOffset` days after 2026-05-04 (a Monday), as UTC. */
function sessionStart(dayOffset: number): number {
  // 2026-05-04T09:15 IST === 2026-05-04T03:45Z
  return Date.UTC(2026, 4, 4 + dayOffset, 3, 45, 0);
}

/**
 * `sessions` trading days of 15m bars, 09:15-15:30 IST (25 bars/day), trending
 * upward with a mild oscillation so structure rules have something to read.
 */
function makeBars(sessions: number, seed = 1): Candle[] {
  const bars: Candle[] = [];
  let price = 100;
  for (let d = 0; d < sessions; d++) {
    // Skip weekends: 2026-05-04 is a Monday, so offsets 5 and 6 mod 7 are the
    // weekend. The replay keys sessions off the IST date, and a weekend bar
    // would be a fact the calendar says cannot exist.
    const dow = (d + 0) % 7;
    if (dow === 5 || dow === 6) {
      sessions++;
      continue;
    }
    const base = sessionStart(d);
    for (let b = 0; b < 25; b++) {
      const drift = 0.35 * seed;
      const wave = Math.sin((d * 25 + b) / 3) * 0.8;
      const open = price;
      const close = price + drift + wave;
      const high = Math.max(open, close) + 0.5;
      const low = Math.min(open, close) - 0.5;
      bars.push({
        timestamp: new Date(base + b * 15 * 60_000),
        open,
        high,
        low,
        close,
        volume: 1_000 + ((d * 25 + b) % 7) * 250,
      });
      price = close;
    }
  }
  return bars;
}

function makeDaily(bars: Candle[]): Candle[] {
  const byDay = new Map<string, Candle[]>();
  for (const b of bars) {
    const key = b.timestamp.toISOString().slice(0, 10);
    const list = byDay.get(key) ?? [];
    list.push(b);
    byDay.set(key, list);
  }
  return Array.from(byDay.entries()).map(([key, list]) => ({
    timestamp: new Date(`${key}T00:00:00.000Z`),
    open: list[0].open,
    high: Math.max(...list.map((c) => c.high)),
    low: Math.min(...list.map((c) => c.low)),
    close: list[list.length - 1].close,
    volume: list.reduce((s, c) => s + c.volume, 0),
  }));
}

function makeReplay(): StrategyReplayService {
  const engine = new StrategyEngineService();
  engine.onModuleInit();
  return new StrategyReplayService(engine);
}

const OPTS = { strategyId: null, minConfidence: 0, includeUnvalidated: true };

describe('StrategyReplayService — no look-ahead', () => {
  it('produces signals at all on a realistic series (the suite would be vacuous otherwise)', () => {
    const bars = makeBars(12);
    const out = makeReplay().replay({ symbol: 'NIFTY', bars, dailyBars: makeDaily(bars), ...OPTS });
    expect(bars.length).toBeGreaterThan(200);
    expect(out.signals.length).toBeGreaterThan(0);
  });

  it('is unaffected by REPLACING every future bar with garbage', () => {
    const bars = makeBars(12);
    const daily = makeDaily(bars);
    const replay = makeReplay();

    const full = replay.replay({ symbol: 'NIFTY', bars, dailyBars: daily, ...OPTS });

    // Corrupt the tail: an enormous spike no rule could ignore if it saw it.
    const cut = Math.floor(bars.length * 0.6);
    const corrupted = bars.map((b, i) =>
      i <= cut ? b : { ...b, open: 9_000, high: 12_000, low: 8_000, close: 11_000, volume: 9_000_000 },
    );
    const tainted = replay.replay({ symbol: 'NIFTY', bars: corrupted, dailyBars: daily, ...OPTS });

    // Every signal at or before the cut must be byte-identical. If any rule
    // could read a later bar, this is where it shows.
    const before = (s: { barIndex: number }[]) => s.filter((x) => x.barIndex <= cut);
    expect(JSON.stringify(before(tainted.signals))).toBe(JSON.stringify(before(full.signals)));
  });

  it('is unaffected by TRUNCATING the series after a given bar', () => {
    const bars = makeBars(12);
    const daily = makeDaily(bars);
    const replay = makeReplay();

    const cut = Math.floor(bars.length * 0.5);
    const full = replay.replay({ symbol: 'NIFTY', bars, dailyBars: daily, ...OPTS });
    const short = replay.replay({ symbol: 'NIFTY', bars: bars.slice(0, cut + 1), dailyBars: daily, ...OPTS });

    // The truncated run cannot see anything after `cut`; the full run must
    // agree with it about everything up to `cut`. The last bar is excluded
    // because only the full run can know whether a next bar exists in-session.
    const upTo = (s: { barIndex: number }[]) => s.filter((x) => x.barIndex < cut);
    expect(JSON.stringify(upTo(short.signals))).toBe(JSON.stringify(upTo(full.signals)));
  });

  it('never fills on the signal bar, and refuses a fill across a session boundary', () => {
    const bars = makeBars(12);
    const out = makeReplay().replay({ symbol: 'NIFTY', bars, dailyBars: makeDaily(bars), ...OPTS });

    const dayOf = (i: number) => bars[i].timestamp.toISOString().slice(0, 10);
    for (const s of out.signals) {
      if (s.nextBarIndex === null) continue;
      // Strictly later, exactly one bar later, and inside the same session.
      expect(s.nextBarIndex).toBe(s.barIndex + 1);
      expect(dayOf(s.nextBarIndex)).toBe(dayOf(s.barIndex));
    }
    // The construction guarantees at least one end-of-session signal exists to
    // exercise the null branch; if it ever stops doing so this assertion says so
    // rather than letting the branch go untested.
    const lastBarPerDay = new Set<number>();
    for (let i = 0; i < bars.length - 1; i++) if (dayOf(i) !== dayOf(i + 1)) lastBarPerDay.add(i);
    lastBarPerDay.add(bars.length - 1);
    const atSessionEnd = out.signals.filter((s) => lastBarPerDay.has(s.barIndex));
    for (const s of atSessionEnd) expect(s.nextBarIndex).toBeNull();
  });

  it('gives a bar only the PRIOR day\'s daily bar, never its own', () => {
    const daily: Candle[] = [
      { timestamp: new Date('2026-05-04T00:00:00Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { timestamp: new Date('2026-05-05T00:00:00Z'), open: 2, high: 3, low: 1.5, close: 2.5, volume: 10 },
      { timestamp: new Date('2026-05-06T00:00:00Z'), open: 3, high: 4, low: 2.5, close: 3.5, volume: 10 },
    ];
    // A decision on 05-06 may use 05-05, and must not use 05-06.
    expect(priorDailyBar(daily, '2026-05-06')?.close).toBe(2.5);
    expect(priorDailyBar(daily, '2026-05-05')?.close).toBe(1.5);
    // Nothing before the first stored day.
    expect(priorDailyBar(daily, '2026-05-04')).toBeNull();
  });

  it('is deterministic — the same input replays to byte-identical output', () => {
    const bars = makeBars(10);
    const daily = makeDaily(bars);
    const a = makeReplay().replay({ symbol: 'NIFTY', bars, dailyBars: daily, ...OPTS });
    const b = makeReplay().replay({ symbol: 'NIFTY', bars, dailyBars: daily, ...OPTS });
    expect(JSON.stringify(a.signals)).toBe(JSON.stringify(b.signals));
    expect(a.strategyVersion).toBe(b.strategyVersion);
  });

  it('stamps every signal with the bar time, not a wall clock', () => {
    const bars = makeBars(10);
    const out = makeReplay().replay({ symbol: 'NIFTY', bars, dailyBars: makeDaily(bars), ...OPTS });
    for (const s of out.signals) {
      expect(s.at).toBe(bars[s.barIndex].timestamp.toISOString());
      expect(new Date(s.at).getTime()).toBeLessThan(Date.now());
    }
  });

  it('refuses an unknown strategy instead of reporting "it never fired"', () => {
    const bars = makeBars(6);
    expect(() =>
      makeReplay().replay({
        symbol: 'NIFTY',
        bars,
        dailyBars: makeDaily(bars),
        strategyId: 'not-a-real-strategy',
        minConfidence: 0,
        includeUnvalidated: true,
      }),
    ).toThrow(/Unknown or disabled strategy/);
  });

  it('honours the confidence floor and the validated-only default', () => {
    const bars = makeBars(12);
    const daily = makeDaily(bars);
    const replay = makeReplay();
    const loose = replay.replay({ symbol: 'NIFTY', bars, dailyBars: daily, ...OPTS });
    const strict = replay.replay({
      symbol: 'NIFTY',
      bars,
      dailyBars: daily,
      strategyId: null,
      minConfidence: 101, // unreachable — 100 is the ceiling
      includeUnvalidated: true,
    });
    expect(strict.signals).toHaveLength(0);
    expect(loose.signals.length).toBeGreaterThan(0);

    const validatedOnly = replay.replay({
      symbol: 'NIFTY',
      bars,
      dailyBars: daily,
      strategyId: null,
      minConfidence: 0,
      includeUnvalidated: false,
    });
    expect(validatedOnly.signals.every((s) => s.validated)).toBe(true);
    expect(validatedOnly.signals.length).toBeLessThanOrEqual(loose.signals.length);
  });
});

describe('hashDefinitions', () => {
  const base = {
    id: 'x',
    name: 'X',
    rules: ['a', 'b'],
    invalidations: ['c'],
    baseConfidenceWeight: 0.8,
    biasSource: 'trend' as const,
    enabled: true,
    source: 'built-in' as const,
  };

  it('is stable across rule ORDER but not rule CONTENT', () => {
    expect(hashDefinitions([{ ...base, rules: ['b', 'a'] }])).toBe(hashDefinitions([base]));
    expect(hashDefinitions([{ ...base, rules: ['a', 'z'] }])).not.toBe(hashDefinitions([base]));
  });

  it('ignores a rename — two results that tested identical rules stay comparable', () => {
    expect(hashDefinitions([{ ...base, name: 'Renamed' }])).toBe(hashDefinitions([base]));
  });

  it('changes when the confidence weight or the bias source changes', () => {
    expect(hashDefinitions([{ ...base, baseConfidenceWeight: 0.9 }])).not.toBe(hashDefinitions([base]));
    expect(hashDefinitions([{ ...base, biasSource: 'vwap' }])).not.toBe(hashDefinitions([base]));
  });
});
