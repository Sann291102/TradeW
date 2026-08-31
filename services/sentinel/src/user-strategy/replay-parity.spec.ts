import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import { createContext, USER_CONDITIONS } from './conditions';
import corpus from './parity-corpus.json';

/**
 * PHASE 4 — cross-engine replay parity.
 *
 * The corpus in `parity-corpus.json` was produced by running the REAL
 * `services/sentinel-py` evaluator (`scripts/generate-parity-corpus.py`). This
 * suite replays the identical candle sequences through the TypeScript registry
 * and asserts the same answers, bar by bar.
 *
 * This is the evidence behind the claim `certification.ts` makes: membership in
 * `USER_CONDITIONS` means "verified against the Python original". Without this
 * file that claim is decoration.
 *
 * ## What is compared, and what is not
 *
 * `met` is the contract and is asserted exactly. Detail strings are human text
 * that both engines happen to format alike; they are spot-checked rather than
 * pinned, because a reworded message is not a semantic change and a suite that
 * fails on it would be retired within a month.
 *
 * ## The `closed_candles` alignment
 *
 * Python's `evaluate()` calls `closed_candles(candles)`, which is
 * `candles[:-1]` unconditionally — its poller only ever runs live, so the last
 * element is always the forming bar. A corpus prefix of length N was therefore
 * evaluated on N-1 bars, and this suite slices identically. The conditional
 * form of that policy is `candle-policy.ts`, tested separately: mixing the two
 * here would test the policy and the ports at once and localise neither.
 */

interface CorpusStep {
  bars: number;
  conditions: Record<string, { met: boolean; detail: string }>;
}
interface CorpusSeries {
  name: string;
  note: string;
  candles: { timestamp: string; open: number; high: number; low: number; close: number; volume: number }[];
  steps: CorpusStep[];
}

const series = (corpus as { series: CorpusSeries[] }).series;

function toCandles(raw: CorpusSeries['candles']): Candle[] {
  return raw.map((c) => ({
    timestamp: new Date(c.timestamp),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

describe('the parity corpus itself', () => {
  it('is present, non-trivial, and covers every certified condition', () => {
    expect(series.length).toBeGreaterThanOrEqual(8);
    const totalSteps = series.reduce((n, s) => n + s.steps.length, 0);
    expect(totalSteps).toBeGreaterThan(300);

    // Every condition in the registry must appear in the corpus, or a port
    // could ship unverified while this suite still passed.
    const covered = new Set<string>();
    for (const s of series) for (const step of s.steps) for (const k of Object.keys(step.conditions)) covered.add(k);
    for (const id of Object.keys(USER_CONDITIONS)) {
      expect(covered.has(id), `${id} is in USER_CONDITIONS but absent from the parity corpus`).toBe(true);
    }
  });

  it('contains both outcomes for every condition, so parity is not trivially satisfied', () => {
    // A corpus where a condition is always false would be matched by a TS
    // implementation that returns false unconditionally.
    for (const id of Object.keys(USER_CONDITIONS)) {
      const seen = new Set<boolean>();
      for (const s of series) for (const step of s.steps) if (step.conditions[id]) seen.add(step.conditions[id].met);
      expect(seen.has(true), `${id} is never true anywhere in the corpus`).toBe(true);
      expect(seen.has(false), `${id} is never false anywhere in the corpus`).toBe(true);
    }
  });
});

describe.each(series.map((s) => [s.name, s] as const))('replay parity — %s', (_name, s) => {
  const candles = toCandles(s.candles);

  it(`matches Python at every one of ${s.steps.length} bars (${s.note})`, () => {
    const divergences: string[] = [];

    for (const step of s.steps) {
      // Mirror `closed_candles`: the prefix minus its forming last bar.
      const bars = candles.slice(0, step.bars - 1);
      if (bars.length === 0) continue;
      const ctx = createContext(bars, '5m');

      for (const [conditionId, expected] of Object.entries(step.conditions)) {
        const impl = USER_CONDITIONS[conditionId];
        if (!impl) {
          divergences.push(`bar ${step.bars}: ${conditionId} has no TS implementation`);
          continue;
        }
        const actual = impl.evaluate(ctx);
        if (actual.met !== expected.met) {
          divergences.push(
            `bar ${step.bars} ${conditionId}: python=${expected.met} ts=${actual.met}\n` +
              `      python detail: ${expected.detail}\n` +
              `      ts detail:     ${actual.detail}`,
          );
        }
      }
    }

    expect(divergences.join('\n'), `${divergences.length} divergence(s)`).toBe('');
  });
});

describe('confirmation timing', () => {
  /**
   * Parity on the end state is not enough — a condition that eventually agrees
   * but confirms a bar early would place the agent's entry on the wrong bar,
   * at a different price, on a setup the user would not recognise. This asserts
   * the FIRST bar at which each condition becomes true is identical.
   */
  it('agrees on the exact bar each condition first becomes true', () => {
    const mismatches: string[] = [];

    for (const s of series) {
      const candles = toCandles(s.candles);
      const firstTruePython = new Map<string, number>();
      const firstTrueTs = new Map<string, number>();

      for (const step of s.steps) {
        const bars = candles.slice(0, step.bars - 1);
        if (bars.length === 0) continue;
        const ctx = createContext(bars, '5m');

        for (const [conditionId, expected] of Object.entries(step.conditions)) {
          if (expected.met && !firstTruePython.has(conditionId)) firstTruePython.set(conditionId, step.bars);
          const impl = USER_CONDITIONS[conditionId];
          if (impl?.evaluate(ctx).met && !firstTrueTs.has(conditionId)) firstTrueTs.set(conditionId, step.bars);
        }
      }

      for (const [conditionId, pythonBar] of firstTruePython) {
        const tsBar = firstTrueTs.get(conditionId);
        if (tsBar !== pythonBar) {
          mismatches.push(`${s.name}/${conditionId}: python first true at bar ${pythonBar}, ts at ${tsBar ?? 'never'}`);
        }
      }
      for (const [conditionId, tsBar] of firstTrueTs) {
        if (!firstTruePython.has(conditionId)) {
          mismatches.push(`${s.name}/${conditionId}: ts fires at bar ${tsBar}, python never does`);
        }
      }
    }

    expect(mismatches.join('\n')).toBe('');
  });
});

describe('the specific semantics Phase 1 flagged as easy to lose', () => {
  const find = (name: string) => series.find((s) => s.name === name)!;

  it('a wick through the EMA is not a reclaim — body only', () => {
    const s = find('wick-only-touch');
    const candles = toCandles(s.candles);
    // The scripted bar 13 has a long lower wick piercing the EMA with the body
    // clear above it. Neither engine may call that a reclaim.
    const finalStep = s.steps[s.steps.length - 1];
    expect(finalStep.conditions['ema7_body_reclaim'].met).toBe(false);

    const ctx = createContext(candles.slice(0, -1), '5m');
    expect(USER_CONDITIONS.ema7_body_reclaim.evaluate(ctx).met).toBe(false);
  });

  it('a reclaim with no follow-through stays unconfirmed in both engines', () => {
    const s = find('reclaim-no-followthrough');
    const candles = toCandles(s.candles);
    const finalStep = s.steps[s.steps.length - 1];
    expect(finalStep.conditions['ema7_body_reclaim'].met).toBe(true);
    expect(finalStep.conditions['reclaim_retest_or_consolidation'].met).toBe(false);

    const ctx = createContext(candles.slice(0, -1), '5m');
    expect(USER_CONDITIONS.ema7_body_reclaim.evaluate(ctx).met).toBe(true);
    expect(USER_CONDITIONS.reclaim_retest_or_consolidation.evaluate(ctx).met).toBe(false);
  });

  it('an instrument with no volume is unjudgeable, not false', () => {
    const s = find('zero-volume');
    const candles = toCandles(s.candles);
    const ctx = createContext(candles.slice(0, -1), '5m');
    const outcome = USER_CONDITIONS.volume_above_20_period_avg.evaluate(ctx);

    // Python returns False for both "not met" and "cannot say". The TS port
    // matches on `met` — which is what parity asserts — and additionally
    // carries the distinction the trading gate needs.
    expect(outcome.met).toBe(false);
    expect(outcome.indeterminate).toBe(true);
    expect(s.steps[s.steps.length - 1].conditions['volume_above_20_period_avg'].met).toBe(false);
  });
});
