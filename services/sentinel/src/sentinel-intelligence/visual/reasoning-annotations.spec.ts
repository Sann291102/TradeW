import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import { buildReasoningAnnotations, type ReasoningAnnotationInput } from './reasoning-annotations';
import type { MarketBehaviourRead } from '../../intelligence/market-behaviour.service';
import type { LifecycleStatus } from '../../strategy/strategy-lifecycle.service';

/**
 * Phase 5 turns Sentinel's reasoning into chart drawings. The guarantees that
 * matter are inherited from the annotation engine and must hold here too:
 * every drawing explains itself, and a partial setup is never drawn as if it
 * were confirmed.
 */

function candles(): Candle[] {
  return [
    { timestamp: new Date(1_780_000_000_000), open: 100, high: 105, low: 95, close: 102, volume: 1000 },
    { timestamp: new Date(1_780_000_900_000), open: 102, high: 110, low: 100, close: 108, volume: 1200 },
  ] as Candle[];
}

function behaviour(over: Partial<MarketBehaviourRead> = {}): MarketBehaviourRead {
  return {
    regime: 'trending',
    structure: {
      state: 'uptrend',
      event: 'break-of-structure',
      eventDirection: 'bullish',
      lastSwingHigh: { index: 3, price: 110, timestamp: new Date(), kind: 'high' },
      lastSwingLow: { index: 1, price: 95, timestamp: new Date(), kind: 'low' },
      evidence: ['Higher high 110 over 105'],
    },
    liquidity: {
      pools: [
        { price: 110, side: 'above', touches: 3, swept: false },
        { price: 95, side: 'below', touches: 2, swept: true },
      ],
      recentSweep: { side: 'above', price: 108, reclaimed: true },
      evidence: [],
    },
    behaviour: { read: 'continuation', direction: 'bullish', strength: 0.7, evidence: [] },
    narrative: '',
    evidence: [],
    ...over,
  } as MarketBehaviourRead;
}

function lifecycle(over: Partial<LifecycleStatus> = {}): LifecycleStatus {
  return {
    strategyId: 'orb-retest',
    strategyName: 'Opening Range Breakout Retest',
    state: 'ACTIVE',
    label: 'Active',
    bias: 'bullish',
    reason: 'The setup remains confirmed and the move is underway',
    evidence: ['3/3 rules confirmed'],
    changed: false,
    enteredAt: new Date().toISOString(),
    history: [],
    ...over,
  } as LifecycleStatus;
}

function input(over: Partial<ReasoningAnnotationInput> = {}): ReasoningAnnotationInput {
  return {
    symbol: 'NIFTY',
    candles: candles(),
    behaviour: behaviour(),
    lifecycles: [lifecycle()],
    support: 95,
    resistance: 112,
    openingRange: { high: 106, low: 98 },
    ...over,
  };
}

describe('buildReasoningAnnotations', () => {
  it('returns nothing when there are no candles to anchor to', () => {
    expect(buildReasoningAnnotations(input({ candles: [] }))).toEqual([]);
  });

  it('every annotation explains itself with real numbers', () => {
    // The inherited guarantee: a condition note must be checkable against the
    // chart, never a restatement of the rule name.
    for (const a of buildReasoningAnnotations(input())) {
      expect(a.explanation.length).toBeGreaterThan(0);
      expect(a.triggeredBy.ruleId.length).toBeGreaterThan(0);
      expect(a.triggeredBy.conditionMet.length).toBeGreaterThan(0);
      expect(a.confidence).toBeGreaterThanOrEqual(0);
      expect(a.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('draws swing structure with the level that would change character', () => {
    const high = buildReasoningAnnotations(input()).find((a) => a.id === 'structure-swing-high');
    expect(high).toBeDefined();
    expect(high!.explanation).toContain('110.0');
    expect(high!.explanation).toContain('continue the existing structure');
  });

  it('distinguishes a sweep from acceptance in the explanation', () => {
    const swept = buildReasoningAnnotations(input()).find((a) => a.id === 'liquidity-sweep');
    expect(swept!.explanation).toContain('This is a sweep, not a breakout');

    const accepted = buildReasoningAnnotations(
      input({
        behaviour: behaviour({
          liquidity: { pools: [], recentSweep: { side: 'above', price: 108, reclaimed: false }, evidence: [] },
        } as Partial<MarketBehaviourRead>),
      }),
    ).find((a) => a.id === 'liquidity-sweep');
    expect(accepted!.explanation).toContain('accepted the new level');
  });

  it('marks already-swept liquidity differently from resting liquidity', () => {
    const annotations = buildReasoningAnnotations(input());
    const pools = annotations.filter((a) => a.kind === 'liquidity-pool');
    expect(pools).toHaveLength(2);
    expect(pools.find((p) => p.label.includes('swept'))).toBeDefined();
  });

  it('does NOT draw a forming setup as if it were confirmed', () => {
    // A drawing is a claim the setup is present. Rendering "forming" with
    // confirmed styling is how a chart starts lying to its reader.
    const forming = buildReasoningAnnotations(
      input({ lifecycles: [lifecycle({ state: 'FORMING', label: 'Forming' })] }),
    );
    expect(forming.some((a) => a.id.startsWith('strategy-'))).toBe(false);
  });

  it('draws a confirmed setup', () => {
    const confirmed = buildReasoningAnnotations(
      input({ lifecycles: [lifecycle({ state: 'CONFIRMED', label: 'Confirmed' })] }),
    );
    expect(confirmed.some((a) => a.id.startsWith('strategy-'))).toBe(true);
  });

  it('keeps an invalidated setup on the chart at reduced confidence rather than erasing it', () => {
    // A level that mattered and then broke is information; a chart that
    // erases its own history teaches nothing.
    const invalidated = buildReasoningAnnotations(
      input({ lifecycles: [lifecycle({ state: 'INVALIDATED', label: 'Invalidated' })] }),
    ).find((a) => a.id.startsWith('strategy-'));
    expect(invalidated).toBeDefined();
    expect(invalidated!.confidence).toBeLessThan(0.5);
  });

  it('degrades to level annotations when no behaviour read is available', () => {
    const out = buildReasoningAnnotations(input({ behaviour: null }));
    expect(out.some((a) => a.id === 'level-support')).toBe(true);
    expect(out.some((a) => a.id.startsWith('structure-'))).toBe(false);
  });

  it('anchors every level across the visible time span', () => {
    const [from, to] = [candles()[0].timestamp.getTime(), candles()[1].timestamp.getTime()];
    for (const a of buildReasoningAnnotations(input())) {
      expect(a.points[0].time).toBe(from);
      expect(a.points[a.points.length - 1].time).toBe(to);
    }
  });

  it('never emits directive language in any drawing', () => {
    const json = JSON.stringify(buildReasoningAnnotations(input()));
    expect(json).not.toMatch(/\bbuy\b|\bsell\b|\bexit now\b|take profit/i);
  });

  it('produces stable ids so a re-render does not duplicate drawings', () => {
    const first = buildReasoningAnnotations(input()).map((a) => a.id);
    const second = buildReasoningAnnotations(input()).map((a) => a.id);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });
});
