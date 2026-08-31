import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import { certifyStrategy, type UserStrategyRules } from './certification';
import { evaluateUserStrategy } from './evaluate';
import { emaOf } from './indicators';

/**
 * The three-way verdict, and why the distinction between WAITING and REFUSED
 * is the load-bearing part of this file.
 *
 * "The setup is not there" and "I could not tell whether the setup is there"
 * look identical from outside and mean opposite things. Collapsing them lets a
 * dead feed read as a calm market — an agent that looks like it is working and
 * is in fact blind.
 */

const T0 = Date.UTC(2026, 7, 31, 4, 0);
function bar(i: number, o: number, h: number, l: number, c: number, v = 10_000): Candle {
  return { timestamp: new Date(T0 + i * 5 * 60_000), open: o, high: h, low: l, close: c, volume: v };
}

const RULES: UserStrategyRules = {
  timeframe: '5m',
  rules: [
    { id: 'trend', condition: 'price_above_ema7', mandatory: true },
    { id: 'slope', condition: 'ema7_rising', mandatory: true },
    { id: 'reclaim', condition: 'ema7_body_reclaim', mandatory: true },
    { id: 'follow', condition: 'reclaim_retest_or_consolidation', mandatory: true },
    { id: 'vol', condition: 'volume_above_20_period_avg', mandatory: false },
  ],
  entry: { long: 'after_reclaim_follow_through', short: null },
};
const CERT = certifyStrategy(RULES);

/**
 * A series that produces a genuine reclaim and follow-through, built the same
 * way the parity corpus builds its scripted scenarios — anchored to the EMA
 * rather than to a guessed dip, so it actually triggers.
 */
function reclaimSeries(): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 24; i++) {
    const o = price;
    const c = price + 1.2;
    out.push(bar(i, o, Math.max(o, c) + 1, Math.min(o, c) - 1, c));
    price = c;
  }
  // The reclaim bar must be built from the EMA the ramp ACTUALLY produces, not
  // from a guessed one. An EMA-7 lags a steep ramp by more than intuition
  // suggests, so a hand-picked dip sails clear of it and the series quietly
  // tests nothing — which is exactly what the first draft of this helper did.
  const ema = emaOf(out, 7).slice(-1)[0];
  // Body straddles the EMA (opens below, closes above) — a genuine reclaim.
  out.push(bar(24, ema - 1.5, ema + 1.8, ema - 2.1, ema + 1.2, 30_000));
  // Closes above the reclaim bar's high — the follow-through.
  out.push(bar(25, ema + 1.2, ema + 4, ema + 1, ema + 3.5, 30_000));
  return out;
}

/** Well past every bar's close, but inside the staleness budget of the last. */
const justAfter = (candles: Candle[]) => new Date(candles[candles.length - 1].timestamp.getTime() + 6 * 60_000);

describe('entry', () => {
  it('returns ENTRY when every mandatory condition is met on a new closed bar', () => {
    const candles = reclaimSeries();
    const result = evaluateUserStrategy({
      certification: CERT,
      candles,
      now: justAfter(candles),
      lastEvaluatedBarTime: null,
    });
    expect(result.verdict).toBe('entry');
    expect(result.direction).toBe('long');
    expect(result.waitingOn).toEqual([]);
    expect(result.conditions.filter((c) => c.mandatory).every((c) => c.met)).toBe(true);
  });

  it('anchors the entry to the bar it was decided on', () => {
    const candles = reclaimSeries();
    const result = evaluateUserStrategy({
      certification: CERT,
      candles,
      now: justAfter(candles),
      lastEvaluatedBarTime: null,
    });
    // The last bar is closed at `now`, so it is the one evaluated.
    expect(result.barTime).toEqual(candles[candles.length - 1].timestamp);
  });

  it('does not let an unmet OPTIONAL condition block entry', () => {
    const candles = reclaimSeries().map((c, i, all) =>
      i === all.length - 1 ? { ...c, volume: 1 } : c,
    );
    const result = evaluateUserStrategy({
      certification: CERT,
      candles,
      now: justAfter(candles),
      lastEvaluatedBarTime: null,
    });
    expect(result.verdict).toBe('entry');
    expect(result.conditions.find((c) => c.condition === 'volume_above_20_period_avg')!.met).toBe(false);
  });
});

describe('waiting', () => {
  it('returns WAITING with the unmet conditions named', () => {
    // A steady downtrend: price below a falling EMA, no reclaim.
    const candles = Array.from({ length: 30 }, (_, i) => {
      const o = 200 - i * 1.5;
      const c = o - 1.5;
      return bar(i, o, o + 0.5, c - 0.5, c);
    });
    const result = evaluateUserStrategy({
      certification: CERT,
      candles,
      now: justAfter(candles),
      lastEvaluatedBarTime: null,
    });
    expect(result.verdict).toBe('waiting');
    expect(result.refusal).toBeNull();
    expect(result.waitingOn.length).toBeGreaterThan(0);
    expect(result.reason).toContain('not met');
  });

  it('evaluates and reports every condition even while waiting', () => {
    const candles = Array.from({ length: 30 }, (_, i) => bar(i, 100, 101, 99, 100));
    const result = evaluateUserStrategy({
      certification: CERT,
      candles,
      now: justAfter(candles),
      lastEvaluatedBarTime: null,
    });
    expect(result.conditions).toHaveLength(5);
    for (const c of result.conditions) expect(c.detail).toBeTruthy();
  });
});

describe('refused — the states that must never read as "no setup"', () => {
  it('refuses an uncertified strategy outright', () => {
    const cert = certifyStrategy({ ...RULES, rules: [{ condition: 'zone_present', mandatory: true }] });
    const result = evaluateUserStrategy({
      certification: cert,
      candles: reclaimSeries(),
      now: justAfter(reclaimSeries()),
      lastEvaluatedBarTime: null,
    });
    expect(result.verdict).toBe('refused');
    expect(result.refusal).toBe('not-certified');
  });

  it('refuses on a stale feed rather than reporting the setup absent', () => {
    const candles = reclaimSeries();
    const result = evaluateUserStrategy({
      certification: CERT,
      candles,
      now: new Date(candles[candles.length - 1].timestamp.getTime() + 6 * 60 * 60_000),
      lastEvaluatedBarTime: null,
    });
    expect(result.verdict).toBe('refused');
    expect(result.refusal).toBe('stale-bar');
  });

  it('refuses on insufficient history', () => {
    const candles = reclaimSeries().slice(0, 5);
    const result = evaluateUserStrategy({
      certification: CERT,
      candles,
      now: justAfter(candles),
      lastEvaluatedBarTime: null,
    });
    expect(result.refusal).toBe('insufficient-history');
  });

  it('refuses when a MANDATORY condition cannot be judged', () => {
    // Enough bars to pass the gate, but no volume anywhere. Volume is optional
    // here, so promote it to mandatory to exercise the branch.
    const mandatoryVolume = certifyStrategy({
      ...RULES,
      rules: RULES.rules!.map((r) =>
        r.condition === 'volume_above_20_period_avg' ? { ...r, mandatory: true } : r,
      ),
    });
    const candles = reclaimSeries().map((c) => ({ ...c, volume: 0 }));
    const result = evaluateUserStrategy({
      certification: mandatoryVolume,
      candles,
      now: justAfter(candles),
      lastEvaluatedBarTime: null,
    });
    expect(result.verdict).toBe('refused');
    expect(result.refusal).toBe('indeterminate-condition');
    // The conditions are still reported, so the refusal is explainable.
    expect(result.conditions.length).toBeGreaterThan(0);
  });

  it('does NOT refuse when only an OPTIONAL condition is unjudgeable', () => {
    const candles = reclaimSeries().map((c) => ({ ...c, volume: 0 }));
    const result = evaluateUserStrategy({
      certification: CERT,
      candles,
      now: justAfter(candles),
      lastEvaluatedBarTime: null,
    });
    expect(result.verdict).not.toBe('refused');
  });
});

describe('one entry per bar', () => {
  it('refuses a bar it has already evaluated, however often it is polled', () => {
    const candles = reclaimSeries();
    const now = justAfter(candles);
    const first = evaluateUserStrategy({ certification: CERT, candles, now, lastEvaluatedBarTime: null });
    expect(first.verdict).toBe('entry');

    // The agent polls every few seconds; the bar has not changed.
    for (let i = 0; i < 5; i++) {
      const again = evaluateUserStrategy({
        certification: CERT,
        candles,
        now: new Date(now.getTime() + i * 2000),
        lastEvaluatedBarTime: first.barTime,
      });
      expect(again.verdict).toBe('refused');
      expect(again.refusal).toBe('already-evaluated');
    }
  });

  it('survives a restart — the persisted marker is all the state it needs', () => {
    const candles = reclaimSeries();
    const now = justAfter(candles);
    const before = evaluateUserStrategy({ certification: CERT, candles, now, lastEvaluatedBarTime: null });

    // Process restarts; nothing in memory survives, only the stored marker.
    const after = evaluateUserStrategy({
      certification: CERT,
      candles,
      now,
      lastEvaluatedBarTime: before.barTime,
    });
    expect(after.refusal).toBe('already-evaluated');
  });
});
