/**
 * The setup catalogue the autonomous engine trades, and how each one's levels
 * are anchored.
 *
 * ## What is new here, and what is only relocated
 *
 * The rule PREDICATES are not redefined — every `rules` and `invalidations`
 * entry below names a member of `STRATEGY_RULES`, which is the one shared
 * implementation in `rules.ts`. What this file adds is the field the existing
 * definitions never had and the autonomous engine cannot work without:
 * `archetype`.
 *
 * ## Why `archetype` exists
 *
 * A setup that says "the opening range broke on volume" describes a thesis but
 * names no price. The old path papered over that by sizing from account
 * percentages — a 3% risk budget and a 9% reward target — which produces a 1:3
 * ratio arithmetically while the stop sits wherever the arithmetic put it.
 * That is a budget, not an invalidation: it answers "how much am I willing to
 * lose?" and never "at what price is this idea wrong?".
 *
 * `archetype` names where THIS setup's thesis dies, so `levels.ts` can read a
 * real price off the chart. Each archetype is a different structural claim:
 *
 *   · `range-break`      — the range you broke out of. Back inside it, the
 *                          breakout did not happen.
 *   · `structure-shift`  — the swing whose violation would un-break the
 *                          structure you claimed just broke.
 *   · `pullback-swing`   — the low (or high) of the pullback you joined. Lose
 *                          it and the pullback was a reversal.
 *   · `sweep-reclaim`    — the extreme of the wick that took liquidity. Trade
 *                          back through it and the sweep was a genuine break.
 *   · `signal-bar`       — the bar that fired the signal. The simplest anchor,
 *                          and the one the EMA-cross backtest already used.
 *
 * ## `agentTradable` is not re-litigated here
 *
 * Every setup in `AGENT_SETUPS` is one Sentinel already marks `agentTradable`.
 * The eight observation-only strategies are deliberately absent: several are
 * built on bullish-only predicates and none declares what would invalidate a
 * POSITION, so an engine that traded them could only ever buy and would have
 * nothing to exit on.
 *
 * ## On drift
 *
 * These four ids also exist in Sentinel's `BUILT_IN_STRATEGIES`, which carries
 * Sentinel-only metadata (knowledge concepts, evidence keys and weights) that
 * the decision core has no use for. The two are kept in step by
 * `setup-conformance.spec.ts` in Sentinel, which fails if the shared fields —
 * rules, invalidations, exit rules, bias source, regimes, session — disagree.
 * Drift is therefore a red test, not a silent divergence.
 */

import { analyseStructure } from './market-structure';
import type { MarketSnapshot } from './snapshot';
import { STRATEGY_RULES, isKnownRule, type RuleOutcome } from './rules';

/** Where a setup's directional read comes from. Mirrors Sentinel's own. */
export type BiasSource =
  | 'orb'
  | 'cpr'
  | 'vwap'
  | 'ema'
  | 'sweep'
  | 'failed-breakout'
  | 'structure'
  | 'swing-structure'
  | 'wyckoff'
  | 'trend';

/** The regime bucket a setup declares itself applicable in. */
export type StrategyRegime = 'trending' | 'ranging' | 'consolidating' | 'breaking-out';

/** How `levels.ts` finds this setup's structural invalidation. */
export type SetupArchetype =
  | 'range-break'
  | 'structure-shift'
  | 'pullback-swing'
  | 'sweep-reclaim'
  | 'signal-bar';

export type SetupBias = 'bullish' | 'bearish' | 'neutral';

export interface SetupDefinition {
  id: string;
  name: string;
  purpose: string;
  /** Rule names that must ALL confirm. Every one is a `STRATEGY_RULES` key. */
  rules: string[];
  /** Rule names, any of which cancels the setup before entry. */
  invalidations: string[];
  /** Rule names the position manager re-evaluates while the trade is open. */
  exitRules: string[];
  archetype: SetupArchetype;
  biasSource: BiasSource;
  regimes: StrategyRegime[];
  /** IST window 'HH:mm-HH:mm'. Absent means the whole session. */
  idealSession?: string;
  /** Semantic version of the RULE SET — calibration and journals key on it. */
  version: string;
  enabled: boolean;
  /**
   * Which sides this setup can actually produce.
   *
   * Declared rather than inferred because `rules.ts` carries an explicit
   * warning about this exact trap: `price_above_vwap` and `ema_fast_above_slow`
   * are bullish-ONLY predicates, so a setup built on them "is structurally
   * incapable of taking the short side of a market that is falling". The four
   * native agent setups use the direction-agnostic pairs and are `both`; the
   * ported EMA-cross uses the bullish-only pair because that is the rule the
   * backtest actually measured, and changing it would break the comparability
   * the port exists to preserve.
   *
   * Making it a field means the asymmetry shows up beside the win rate in the
   * journal instead of being a silent property of the rule list — a long-only
   * strategy measured across a falling season is not underperforming, it is
   * abstaining, and those must not look alike.
   */
  directionality: 'both' | 'long-only' | 'short-only';
}

/**
 * The directional read implied by a bias source, as a pure function of the
 * snapshot.
 *
 * Behaviourally identical to Sentinel's `resolveBias`, and deliberately so —
 * it is asserted against it by the conformance spec. It lives here because the
 * autonomous engine must be able to resolve a side with Sentinel switched off.
 *
 * `neutral` is a real answer and never a weak buy. Sentinel's own history
 * records a defect where coercing neutral to bullish "manufactured a CE out of
 * the precise case where the evidence declined to pick a direction"; the same
 * trap exists for spot and futures, so the honest answer is returned and the
 * caller refuses to trade on it.
 */
export function resolveBias(source: BiasSource, s: MarketSnapshot): SetupBias {
  const trend = s.trendAnalysis?.direction ?? 'neutral';
  const last = s.candles[s.candles.length - 1];

  switch (source) {
    case 'orb':
      if (!s.openingRange || !last) return trend;
      if (last.close > s.openingRange.high) return 'bullish';
      if (last.close < s.openingRange.low) return 'bearish';
      return 'neutral';
    case 'cpr':
      if (!s.cpr) return trend;
      if (s.lastPrice > s.cpr.tc) return 'bullish';
      if (s.lastPrice < s.cpr.bc) return 'bearish';
      return 'neutral';
    case 'vwap':
      if (s.vwap === null) return trend;
      return s.lastPrice > s.vwap ? 'bullish' : 'bearish';
    case 'ema':
      if (s.ema20 === null || s.ema50 === null) return trend;
      return s.ema20 > s.ema50 ? 'bullish' : 'bearish';
    case 'sweep':
      if (last && s.support !== null && last.low < s.support && last.close > s.support) return 'bullish';
      if (last && s.resistance !== null && last.high > s.resistance && last.close < s.resistance) return 'bearish';
      return 'neutral';
    case 'failed-breakout':
      if (last && s.resistance !== null && last.close < s.resistance) return 'bearish';
      if (last && s.support !== null && last.close > s.support) return 'bullish';
      return 'neutral';
    case 'swing-structure': {
      if (s.candles.length < 10) return trend;
      const st = analyseStructure(s.candles);
      if (st.event && st.eventDirection) return st.eventDirection;
      if (st.state === 'uptrend') return 'bullish';
      if (st.state === 'downtrend') return 'bearish';
      return 'neutral';
    }
    case 'structure':
    case 'wyckoff':
    case 'trend':
    default:
      return trend;
  }
}

/**
 * The setups an autonomous agent may act on.
 *
 * The first four mirror Sentinel's `agentTradable` definitions. The fifth is
 * the EMA-cross rule that until now existed ONLY inside the backtester as a
 * hand-written loop — ported into this vocabulary so that a backtest of it and
 * a live run of it evaluate the same predicates. It is given no special
 * standing: it competes with the others on the same journal evidence.
 */
export const AGENT_SETUPS: readonly SetupDefinition[] = [
  {
    id: 'agent-smc-structure-shift',
    name: 'Smart Money Structure Shift',
    purpose:
      'Take the side of a confirmed swing-structure break that displaced with participation and then returned into the order block it left behind.',
    rules: ['structure_break_confirmed', 'displacement_bar', 'order_block_mitigated', 'volume_supports_move'],
    invalidations: ['structure_reversed', 'structure_shift_invalidated'],
    exitRules: ['structure_reversed', 'structure_shift_invalidated'],
    // The break is the thesis, so the swing whose violation would un-break it
    // is the invalidation. Not the order block: price is INSIDE the block at
    // entry (that is what `order_block_mitigated` means), so a stop there
    // would be at or through the entry.
    archetype: 'structure-shift',
    biasSource: 'swing-structure',
    regimes: ['trending', 'breaking-out'],
    version: '1.0.0',
    enabled: true,
    directionality: 'both',
  },
  {
    id: 'agent-trend-momentum',
    name: 'Trend Momentum Continuation',
    purpose:
      'Join an established, still-accelerating trend on the side the EMA stack and VWAP agree on, after a quiet pullback rather than into an extension.',
    rules: ['ema_stack_aligned', 'trend_momentum_confirmed', 'price_beyond_vwap', 'pullback_volume_lower'],
    invalidations: ['momentum_faded', 'vwap_reclaimed_against'],
    exitRules: ['momentum_faded', 'vwap_reclaimed_against', 'structure_reversed'],
    // The trade is "this pullback holds". The pullback's own extreme is the
    // price at which it did not.
    archetype: 'pullback-swing',
    biasSource: 'ema',
    regimes: ['trending'],
    version: '1.0.0',
    enabled: true,
    directionality: 'both',
  },
  {
    id: 'agent-opening-range-expansion',
    name: 'Opening Range Expansion',
    purpose:
      'Take a decisive break of the opening range that is expanding the session range on real volume, rather than drifting through it.',
    rules: ['orb_breakout', 'session_range_expanding', 'volume_supports_move', 'price_beyond_vwap'],
    invalidations: ['orb_reentry'],
    exitRules: ['orb_reentry', 'momentum_faded'],
    archetype: 'range-break',
    biasSource: 'orb',
    regimes: ['breaking-out', 'trending'],
    idealSession: '09:30-12:00',
    version: '1.0.0',
    enabled: true,
    directionality: 'both',
  },
  {
    id: 'agent-exhaustion-reversal',
    name: 'Exhaustion Reversal',
    purpose:
      'Fade a stretched move that has run a 20-bar liquidity pool, been rejected on the bar that took it, and closed back through the level.',
    rules: ['liquidity_pool_swept', 'momentum_stretched', 'rejection_bar', 'sweep_volume_spike'],
    invalidations: ['sweep_not_reclaimed', 'range_broken'],
    exitRules: ['sweep_not_reclaimed', 'range_broken', 'structure_reversed'],
    // The wick that took the liquidity is the whole thesis. Price trading back
    // through its extreme means the sweep was a real break.
    archetype: 'sweep-reclaim',
    biasSource: 'sweep',
    regimes: ['ranging', 'consolidating'],
    version: '1.0.0',
    enabled: true,
    directionality: 'both',
  },
  {
    id: 'agent-ema-cross',
    name: 'EMA Cross Continuation',
    purpose:
      'Join a trend on a fresh reclaim of the fast EMA, confirmed by participation — the rule the backtester has measured since 2026-07-24, now expressed in the shared vocabulary.',
    // Ported, not reimplemented. The backtest loop tested three things: an EMA
    // relationship, an optional trend filter and an optional volume
    // confirmation. Each maps to a rule that already exists, so the strategy
    // stops being a private loop and becomes comparable with every other
    // setup in this table.
    rules: ['ema_fast_above_slow', 'price_above_vwap', 'volume_supports_move'],
    invalidations: ['ema_fast_below_slow'],
    exitRules: ['ema_fast_below_slow', 'momentum_faded'],
    // `stop = signalLow * (1 - buffer)` in `EmaCrossConfig` is exactly a
    // signal-bar anchor, so the ported version keeps the same invalidation the
    // measured results were produced with.
    archetype: 'signal-bar',
    biasSource: 'ema',
    regimes: ['trending', 'breaking-out'],
    version: '1.0.0',
    enabled: true,
    directionality: 'long-only',
  },
];

/** One setup evaluated against one snapshot. */
export interface SetupDetection {
  setup: SetupDefinition;
  bias: SetupBias;
  /** Every rule that confirmed, with the note it cited. */
  confirmed: { ruleId: string; note: string }[];
  /** Every rule that did not, with the note explaining why. */
  unmet: { ruleId: string; note: string }[];
  /** Invalidation rules that fired. A non-empty list cancels the setup. */
  invalidated: { ruleId: string; note: string }[];
  /** True only when every rule confirmed and nothing invalidated. */
  validated: boolean;
  /** 0..100 — the share of rules that confirmed, halved if invalidated. */
  quality: number;
}

function runRule(ruleId: string, snapshot: MarketSnapshot): RuleOutcome {
  const rule = STRATEGY_RULES[ruleId];
  // An unknown rule is a definition error, and the safe reading is "did not
  // confirm" — never "confirmed by default", which would let a typo create a
  // setup out of nothing.
  if (!rule) return { ok: false, note: `Unknown rule '${ruleId}' — treated as unmet` };
  return rule(snapshot);
}

/**
 * Evaluate one setup against a snapshot.
 *
 * Reports the full picture rather than a boolean: an unmet rule and its note
 * are what the rejection journal cites, and "how close did it get?" is
 * unanswerable from a boolean.
 */
export function evaluateSetup(setup: SetupDefinition, snapshot: MarketSnapshot): SetupDetection {
  const confirmed: { ruleId: string; note: string }[] = [];
  const unmet: { ruleId: string; note: string }[] = [];
  for (const ruleId of setup.rules) {
    const outcome = runRule(ruleId, snapshot);
    (outcome.ok ? confirmed : unmet).push({ ruleId, note: outcome.note });
  }

  const invalidated: { ruleId: string; note: string }[] = [];
  for (const ruleId of setup.invalidations) {
    const outcome = runRule(ruleId, snapshot);
    if (outcome.ok) invalidated.push({ ruleId, note: outcome.note });
  }

  const validated = unmet.length === 0 && invalidated.length === 0;
  const share = setup.rules.length === 0 ? 0 : confirmed.length / setup.rules.length;
  const quality = Math.round(share * (invalidated.length > 0 ? 50 : 100));

  return {
    setup,
    bias: resolveBias(setup.biasSource, snapshot),
    confirmed,
    unmet,
    invalidated,
    validated,
    quality,
  };
}

/**
 * Evaluate every enabled setup, strongest first.
 *
 * Returns ALL of them, including the ones that did not validate. The engine
 * needs the near-misses: a candidate that confirmed three of four rules is the
 * record that makes "why did nothing trade today?" answerable, and discarding
 * it here would make the rejection journal impossible to build.
 */
export function detectSetups(
  snapshot: MarketSnapshot,
  catalogue: readonly SetupDefinition[] = AGENT_SETUPS,
): SetupDetection[] {
  return catalogue
    .filter((s) => s.enabled)
    .map((s) => evaluateSetup(s, snapshot))
    .sort((a, b) => b.quality - a.quality);
}

/**
 * Every rule name the catalogue depends on that `STRATEGY_RULES` does not
 * define.
 *
 * Exists so a definition typo fails a test rather than silently producing a
 * setup that can never validate — the same guarantee Sentinel's
 * `strategy-knowledge.spec.ts` gives for knowledge concepts.
 */
export function unknownRuleNames(
  catalogue: readonly SetupDefinition[] = AGENT_SETUPS,
): string[] {
  const names = new Set<string>();
  for (const setup of catalogue) {
    for (const id of [...setup.rules, ...setup.invalidations, ...setup.exitRules]) {
      if (!isKnownRule(id)) names.add(id);
    }
  }
  return [...names].sort();
}
