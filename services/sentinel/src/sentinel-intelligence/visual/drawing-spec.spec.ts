import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import { describeCondition, validateSpec } from './drawing-spec';
import { buildChartContext, evaluateCondition, resolveOperand } from './chart-context';

/**
 * A learned TradingView strategy is DATA, never code. These tests hold that
 * line from two directions: validation must reject anything outside the closed
 * vocabulary, and evaluation must restate the live numbers that made each
 * condition true so a drawn annotation is checkable against the chart.
 */

const MINUTE = 60_000;

function candles(closes: number[], volume = 1000): Candle[] {
  const start = Date.UTC(2026, 7, 3, 3, 45);
  return closes.map((close, i) => ({
    timestamp: new Date(start + i * 15 * MINUTE),
    open: i === 0 ? close : closes[i - 1],
    high: close + 2,
    low: close - 2,
    close,
    volume,
  }));
}

const validSpec = {
  id: 'my-orb-retest',
  name: 'My ORB Retest',
  description: 'Opening range break, then a lower-volume retest.',
  symbols: ['NIFTY'],
  timeframes: ['15m'],
  bias: 'bullish',
  conditions: [
    { kind: 'compare', left: { ref: 'price' }, op: '>', right: { ref: 'openingRange.high' } },
    { kind: 'structure', pattern: 'liquidity-sweep' },
  ],
  invalidations: [{ kind: 'compare', left: { ref: 'price' }, op: '<', right: { ref: 'vwap' } }],
  drawings: [
    {
      kind: 'resistance',
      anchor: 'nearest-level-above',
      label: 'ORB high {price}',
      rationale: 'The opening range high is the level the whole setup is measured from.',
    },
  ],
};

describe('validateSpec', () => {
  it('accepts a well-formed specification', () => {
    const { spec, issues } = validateSpec(validSpec);
    expect(issues).toEqual([]);
    expect(spec).not.toBeNull();
    expect(spec!.id).toBe('my-orb-retest');
    expect(spec!.conditions).toHaveLength(2);
  });

  it('rejects an operand outside the closed vocabulary', () => {
    const { spec, issues } = validateSpec({
      ...validSpec,
      conditions: [{ kind: 'compare', left: { ref: 'secretBackdoor' }, op: '>', right: { value: 1 } }],
    });

    expect(spec).toBeNull();
    expect(issues.some((i) => i.message.includes('unknown reference'))).toBe(true);
  });

  it('rejects a condition kind it does not know', () => {
    const { spec, issues } = validateSpec({
      ...validSpec,
      conditions: [{ kind: 'evaluate', expression: 'process.exit(1)' }],
    });

    expect(spec).toBeNull();
    expect(issues.some((i) => i.field.endsWith('.kind'))).toBe(true);
  });

  it('rejects a drawing with no stated rationale', () => {
    // Every annotation must explain why it is there; a drawing that cannot
    // satisfy that is refused rather than defaulted to a placeholder.
    const { spec, issues } = validateSpec({
      ...validSpec,
      drawings: [{ kind: 'resistance', anchor: 'nearest-level-above', label: 'x' }],
    });

    expect(spec).toBeNull();
    expect(issues.some((i) => i.field.endsWith('.rationale'))).toBe(true);
  });

  it('rejects a strategy with no conditions, which would match every bar', () => {
    const { spec, issues } = validateSpec({ ...validSpec, conditions: [] });
    expect(spec).toBeNull();
    expect(issues.some((i) => i.field === 'conditions')).toBe(true);
  });

  it('requires a tolerance for within-pct', () => {
    const { spec, issues } = validateSpec({
      ...validSpec,
      conditions: [{ kind: 'compare', left: { ref: 'price' }, op: 'within-pct', right: { ref: 'vwap' } }],
    });

    expect(spec).toBeNull();
    expect(issues.some((i) => i.field.endsWith('.tolerancePct'))).toBe(true);
  });

  it('collects every issue in one pass rather than failing on the first', () => {
    const { issues } = validateSpec({ id: 'Bad Id', name: '', conditions: [], drawings: [] });
    expect(issues.length).toBeGreaterThan(2);
  });

  it('describes a condition in plain English for the annotation explanation', () => {
    expect(describeCondition({ kind: 'compare', left: { ref: 'price' }, op: '>', right: { ref: 'vwap' } }))
      .toBe('price is above vwap');
    expect(describeCondition({ kind: 'structure', pattern: 'liquidity-sweep' }))
      .toBe('liquidity sweep is present');
  });
});

describe('operand resolution', () => {
  it('reads live values off the chart context', () => {
    const context = buildChartContext(candles([100, 101, 102, 103, 104]), null);
    expect(resolveOperand({ ref: 'close' }, context)).toBe(104);
    expect(resolveOperand({ value: 42 }, context)).toBe(42);
  });

  it('returns null for a value that genuinely does not exist', () => {
    // No prior day means no CPR. Null must propagate to an unmet condition
    // with a stated reason, never to a fabricated default.
    const context = buildChartContext(candles([100, 101, 102]), null);
    expect(resolveOperand({ ref: 'cpr.pivot' }, context)).toBeNull();
  });

  it('does not report an EMA before it has warmed up', () => {
    const context = buildChartContext(candles([100, 101, 102]), null);
    expect(resolveOperand({ ref: 'ema20' }, context)).toBeNull();
  });
});

describe('condition evaluation', () => {
  it('states the live numbers behind a satisfied comparison', () => {
    const context = buildChartContext(candles([100, 105, 110]), null);
    const result = evaluateCondition(
      { kind: 'compare', left: { ref: 'close' }, op: '>', right: { value: 105 } },
      context,
    );

    expect(result.met).toBe(true);
    // The note must contain the actual figures, not a restatement of the rule.
    expect(result.note).toMatch(/110\.00/);
    expect(result.note).toMatch(/105\.00/);
  });

  it('states why a condition could not be evaluated at all', () => {
    const context = buildChartContext(candles([100, 101, 102]), null);
    const result = evaluateCondition(
      { kind: 'compare', left: { ref: 'close' }, op: '>', right: { ref: 'cpr.pivot' } },
      context,
    );

    expect(result.met).toBe(false);
    expect(result.note).toMatch(/unavailable/);
  });

  it('detects a cross using the previous bar, not just the current one', () => {
    const rising = buildChartContext(candles([100, 100, 100, 100, 110]), null);
    const result = evaluateCondition(
      { kind: 'compare', left: { ref: 'close' }, op: 'crosses-above', right: { value: 105 } },
      rising,
    );

    expect(result.met).toBe(true);
    expect(result.note).toMatch(/crossed above/);
  });

  it('evaluates a volume multiple against its own average', () => {
    const bars = candles([100, 101, 102, 103, 104]);
    bars[bars.length - 1].volume = 5000; // 5x the 1000 baseline
    const context = buildChartContext(bars, null);

    const result = evaluateCondition(
      {
        kind: 'multiple-of',
        left: { ref: 'volume' },
        op: '>=',
        multiplier: 1.5,
        right: { ref: 'volume.avg20' },
      },
      context,
    );

    expect(result.met).toBe(true);
    expect(result.note).toMatch(/×/);
  });

  it('reports an absent structural pattern as unmet with a reason', () => {
    const context = buildChartContext(candles([100, 101, 102, 103, 104]), null);
    const result = evaluateCondition({ kind: 'structure', pattern: 'fair-value-gap' }, context);

    expect(result.met).toBe(false);
    expect(result.note).toMatch(/No unmitigated fair value gap/);
  });
});
