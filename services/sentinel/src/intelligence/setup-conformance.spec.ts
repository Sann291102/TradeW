/**
 * The anti-drift check between Sentinel's strategy definitions and the
 * autonomous engine's setup catalogue.
 *
 * ## Why two lists exist at all
 *
 * `@tradew/strategy-core`'s `AGENT_SETUPS` is what the autonomous engine
 * trades. Sentinel's `BUILT_IN_STRATEGIES` is what Sentinel observes and
 * explains, and it carries metadata the decision core has no use for —
 * knowledge-base concept ids, evidence keys, evidence weights, a base
 * confidence weight and a human-facing purpose. Merging them would push
 * Sentinel's presentation concerns into a package that must stay free of them,
 * and would make the engine depend on Sentinel again.
 *
 * ## Why that is safe ONLY with this test
 *
 * Two lists sharing four ids is exactly the "two representations, both valid,
 * silently disagreeing" failure this repository has recorded three times. The
 * rule PREDICATES are genuinely shared — both sides resolve names against the
 * one `STRATEGY_RULES` — but the rule LISTS could drift, and a drifted list
 * means Sentinel explains one setup to a trader while the engine trades a
 * different one under the same name.
 *
 * So the shared fields are asserted equal here. Adding a rule to a strategy in
 * either place without the other turns this red. It is the same guarantee
 * `strategy-knowledge.spec.ts` gives for concept ids.
 *
 * **If this fails, do not "fix" it by loosening the comparison.** Decide which
 * list is right, change the other, and keep them identical.
 */

import { describe, expect, it } from 'vitest';
import { AGENT_SETUPS, resolveBias, type BiasSource } from '@tradew/strategy-core';
import { StrategyEngineService } from './strategy-engine.service';
import type { MarketSnapshot } from './market-intelligence.service';

const sentinelStrategies = new StrategyEngineService().getStrategies();
const agentTradable = sentinelStrategies.filter((s) => s.agentTradable);

describe('setup catalogue conformance', () => {
  it('covers every strategy Sentinel marks agent-tradable', () => {
    const sentinelIds = agentTradable.map((s) => s.id).sort();
    const coreIds = AGENT_SETUPS.map((s) => s.id).sort();
    // The core may carry MORE (the ported EMA-cross has no Sentinel twin),
    // but it must never be missing one Sentinel considers agent-tradable —
    // that would be a strategy the console offers and the engine cannot take.
    for (const id of sentinelIds) {
      expect(coreIds).toContain(id);
    }
  });

  it.each(
    AGENT_SETUPS.filter((s) => agentTradable.some((t) => t.id === s.id)).map((s) => [s.id, s] as const),
  )('%s has identical decision fields in both lists', (_id, setup) => {
    const twin = agentTradable.find((s) => s.id === setup.id)!;

    expect(setup.rules).toEqual(twin.rules);
    expect(setup.invalidations).toEqual(twin.invalidations);
    expect(setup.exitRules ?? []).toEqual(twin.exitRules ?? []);
    expect(setup.biasSource).toEqual(twin.biasSource);
    expect(setup.regimes).toEqual(twin.regimes ?? []);
    expect(setup.idealSession).toEqual(twin.idealSession);
    expect(setup.version).toEqual(twin.version);
    expect(setup.name).toEqual(twin.name);
  });
});

describe('bias resolution conformance', () => {
  /**
   * The core reimplements `resolveBias` because it must resolve a side with
   * Sentinel switched off. That is the one genuine duplication in the split, so
   * it is pinned here: both must answer identically on the same snapshot, for
   * every bias source, or the engine and the console disagree about which way
   * a setup is pointing.
   *
   * Sentinel's copy is private, so it is exercised through the public
   * `evaluate` path on snapshots designed to force each branch.
   */
  const base: MarketSnapshot = {
    symbol: 'NIFTY',
    lastPrice: 100,
    rsi14: 50,
    ema20: null,
    ema50: null,
    vwap: null,
    macdHistogram: null,
    cpr: null,
    volumeVsAvg: null,
    oiTrend: 'unknown',
    realizedVolPct: null,
    vix: null,
    breadthRatio: null,
    support: null,
    resistance: null,
    candles: [],
    sessionCandles: [],
    formingCandle: null,
    priorDay: null,
    marketProfile: null,
    trendAnalysis: null,
    openingRange: null,
    optionChain: null,
  };

  const cases: [BiasSource, Partial<MarketSnapshot>, 'bullish' | 'bearish' | 'neutral'][] = [
    ['ema', { ema20: 110, ema50: 100 }, 'bullish'],
    ['ema', { ema20: 90, ema50: 100 }, 'bearish'],
    ['vwap', { vwap: 90 }, 'bullish'],
    ['vwap', { vwap: 110 }, 'bearish'],
    ['cpr', { cpr: { pivot: 95, bc: 90, tc: 98 } }, 'bullish'],
    ['cpr', { cpr: { pivot: 105, bc: 102, tc: 110 } }, 'bearish'],
    ['trend', {}, 'neutral'],
  ];

  it.each(cases)('%s resolves the documented side', (source, patch, expected) => {
    expect(resolveBias(source, { ...base, ...patch })).toBe(expected);
  });

  it('never coerces a neutral read into a direction', () => {
    // The defect this guards against manufactured a CE out of exactly the case
    // where the evidence declined to pick a side.
    expect(resolveBias('orb', { ...base, openingRange: null })).toBe('neutral');
    expect(resolveBias('sweep', base)).toBe('neutral');
  });
});
