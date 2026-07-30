/**
 * Module 2 — the Strategy Engine's rule vocabulary.
 *
 * Strategy definitions are declarative (see `strategy-engine.service.ts` and
 * the YAML overlay it loads), so a rule is a *name* that resolves to one of
 * the deterministic predicates below. That keeps user-authored strategies
 * data rather than code: a YAML file can compose these rules but can never
 * introduce arbitrary logic into the observation path.
 *
 * Every predicate returns `{ ok, note }` — the note is what the "Why?"
 * inspector cites, so a rule that passes always explains itself with real
 * numbers rather than restating its own name.
 */

import { Candle } from '@tradew/types';
import { averageVolume, swingLevels } from './indicators';
import { MarketSnapshot } from './market-intelligence.service';

export interface RuleOutcome {
  ok: boolean;
  note: string;
}

export type StrategyRule = (s: MarketSnapshot) => RuleOutcome;

const no = (note: string): RuleOutcome => ({ ok: false, note });
const yes = (note: string): RuleOutcome => ({ ok: true, note });

/** The bar the strategy engine treats as "now". */
function lastBar(s: MarketSnapshot): Candle | null {
  return s.candles[s.candles.length - 1] ?? null;
}

/** Index of the first bar that closed beyond the opening range, if any. */
function orbBreakoutIndex(s: MarketSnapshot): number {
  if (!s.openingRange) return -1;
  const { high, low, establishedAt } = s.openingRange;
  return s.sessionCandles.findIndex(
    (c) => c.timestamp > establishedAt && (c.close > high || c.close < low),
  );
}

export const STRATEGY_RULES: Record<string, StrategyRule> = {
  // ------------------------------------------------------------ opening range
  orb_breakout: (s) => {
    const idx = orbBreakoutIndex(s);
    if (idx === -1 || !s.openingRange) return no('No close beyond the opening range yet');
    const bar = s.sessionCandles[idx];
    const side = bar.close > s.openingRange.high ? 'above' : 'below';
    const level = side === 'above' ? s.openingRange.high : s.openingRange.low;
    return yes(`A 15m bar closed ${side} the opening range at ${level.toFixed(1)}`);
  },

  orb_retest: (s) => {
    const idx = orbBreakoutIndex(s);
    if (idx === -1 || !s.openingRange) return no('No opening-range breakout to retest');
    const { high, low } = s.openingRange;
    const level = s.sessionCandles[idx].close > high ? high : low;
    const after = s.sessionCandles.slice(idx + 1, idx + 4);
    const touched = after.some((c) => c.low <= level && c.high >= level);
    return touched
      ? yes(`Price returned to test ${level.toFixed(1)} within ${after.length} bars of the breakout`)
      : no(`No retest of ${level.toFixed(1)} within 3 bars of the breakout`);
  },

  orb_retest_volume_lower: (s) => {
    const idx = orbBreakoutIndex(s);
    if (idx === -1 || !s.openingRange) return no('No opening-range breakout to compare against');
    const { high, low } = s.openingRange;
    const level = s.sessionCandles[idx].close > high ? high : low;
    const breakoutVol = s.sessionCandles[idx].volume;
    const retest = s.sessionCandles.slice(idx + 1, idx + 4).find((c) => c.low <= level && c.high >= level);
    if (!retest) return no('No retest bar to measure');
    return retest.volume < breakoutVol
      ? yes(`Retest volume ${Math.round(retest.volume).toLocaleString()} is below breakout volume ${Math.round(breakoutVol).toLocaleString()}`)
      : no(`Retest volume ${Math.round(retest.volume).toLocaleString()} is not below breakout volume ${Math.round(breakoutVol).toLocaleString()}`);
  },

  orb_reentry: (s) => {
    if (!s.openingRange) return no('No opening range established');
    const last = lastBar(s);
    if (!last) return no('No bars available');
    const idx = orbBreakoutIndex(s);
    if (idx === -1) return no('No breakout to invalidate');
    const inside = last.close > s.openingRange.low && last.close < s.openingRange.high;
    return inside
      ? yes(`Price closed back inside the opening range at ${last.close.toFixed(1)}`)
      : no('Price is holding outside the opening range');
  },

  // ---------------------------------------------------------------- CPR
  cpr_level_interaction: (s) => {
    if (!s.cpr) return no('No prior-day CPR available');
    const last = lastBar(s);
    const prev = s.candles[s.candles.length - 2];
    if (!last || !prev) return no('Not enough bars');
    if (last.close > s.cpr.tc) return yes(`Price closed above the CPR top at ${s.cpr.tc.toFixed(1)}`);
    if (prev.low <= s.cpr.bc && last.close > s.cpr.bc) {
      return yes(`Price tested the CPR bottom at ${s.cpr.bc.toFixed(1)} and closed back above it`);
    }
    if (last.close < s.cpr.bc) return yes(`Price closed below the CPR bottom at ${s.cpr.bc.toFixed(1)}`);
    return no(`Price is inside the CPR (${s.cpr.bc.toFixed(1)}–${s.cpr.tc.toFixed(1)})`);
  },

  cpr_reentry: (s) => {
    if (!s.cpr) return no('No prior-day CPR available');
    const last = lastBar(s);
    if (!last) return no('No bars available');
    const inside = last.close >= s.cpr.bc && last.close <= s.cpr.tc;
    return inside
      ? yes(`Price re-entered the CPR at ${last.close.toFixed(1)}`)
      : no('Price is holding outside the CPR');
  },

  // --------------------------------------------------------------- VWAP
  price_above_vwap: (s) => {
    if (s.vwap === null) return no('VWAP unavailable');
    return s.lastPrice > s.vwap
      ? yes(`Price ${s.lastPrice.toFixed(1)} is above VWAP ${s.vwap.toFixed(1)}`)
      : no(`Price ${s.lastPrice.toFixed(1)} is below VWAP ${s.vwap.toFixed(1)}`);
  },

  vwap_pullback_touch: (s) => {
    if (s.vwap === null) return no('VWAP unavailable');
    const recent = s.candles.slice(-3);
    const touched = recent.some((c) => c.low <= s.vwap! && c.high >= s.vwap!);
    return touched
      ? yes(`Price pulled back into VWAP ${s.vwap.toFixed(1)} within the last 3 bars`)
      : no(`No pullback into VWAP ${s.vwap.toFixed(1)} in the last 3 bars`);
  },

  pullback_volume_lower: (s) => {
    if (s.candles.length < 10) return no('Not enough history to compare pullback volume');
    const trendVol = averageVolume(s.candles.slice(-10, -3), 7);
    const pullbackVol = averageVolume(s.candles.slice(-3), 3);
    return pullbackVol < trendVol
      ? yes(`Pullback volume is ${((pullbackVol / Math.max(1, trendVol)) * 100).toFixed(0)}% of the preceding trend volume`)
      : no(`Pullback volume is ${((pullbackVol / Math.max(1, trendVol)) * 100).toFixed(0)}% of the preceding trend volume — not a quiet pullback`);
  },

  vwap_lost_on_volume: (s) => {
    if (s.vwap === null) return no('VWAP unavailable');
    const last = lastBar(s);
    if (!last) return no('No bars available');
    const avgVol = averageVolume(s.candles);
    const lost = last.close < s.vwap && avgVol > 0 && last.volume > avgVol * 1.5;
    return lost
      ? yes(`Price closed below VWAP ${s.vwap.toFixed(1)} on ${(last.volume / avgVol).toFixed(1)}x average volume`)
      : no('VWAP has not been lost on expanding volume');
  },

  // ---------------------------------------------------------------- EMA
  ema_fast_above_slow: (s) => {
    if (s.ema20 === null || s.ema50 === null) return no('EMA pair unavailable');
    return s.ema20 > s.ema50
      ? yes(`EMA20 ${s.ema20.toFixed(1)} is above EMA50 ${s.ema50.toFixed(1)}`)
      : no(`EMA20 ${s.ema20.toFixed(1)} is below EMA50 ${s.ema50.toFixed(1)}`);
  },

  ema_fast_below_slow: (s) => {
    if (s.ema20 === null || s.ema50 === null) return no('EMA pair unavailable');
    return s.ema20 < s.ema50
      ? yes(`EMA20 ${s.ema20.toFixed(1)} crossed below EMA50 ${s.ema50.toFixed(1)}`)
      : no('The EMA pair has not crossed back');
  },

  price_at_ema_confluence: (s) => {
    if (s.ema20 === null || s.ema50 === null) return no('EMA pair unavailable');
    const zone = (s.ema20 + s.ema50) / 2;
    const distPct = zone !== 0 ? Math.abs(s.lastPrice - zone) / zone : 1;
    return distPct < 0.003
      ? yes(`Price is within ${(distPct * 100).toFixed(2)}% of the EMA20/50 confluence at ${zone.toFixed(1)}`)
      : no(`Price is ${(distPct * 100).toFixed(2)}% away from the EMA20/50 confluence at ${zone.toFixed(1)}`);
  },

  // ------------------------------------------------------------ liquidity
  liquidity_sweep: (s) => {
    const last = lastBar(s);
    if (!last) return no('No bars available');
    if (s.resistance !== null && last.high > s.resistance && last.close < s.resistance) {
      return yes(`A wick pierced resistance ${s.resistance.toFixed(1)} and closed back below it`);
    }
    if (s.support !== null && last.low < s.support && last.close > s.support) {
      return yes(`A wick pierced support ${s.support.toFixed(1)} and closed back above it`);
    }
    return no('No sweep-and-reclaim of a swing level in the latest bar');
  },

  sweep_volume_spike: (s) => {
    const last = lastBar(s);
    if (!last) return no('No bars available');
    const avgVol = averageVolume(s.candles);
    if (avgVol <= 0) return no('No volume baseline');
    return last.volume > avgVol * 1.5
      ? yes(`Sweep bar traded ${(last.volume / avgVol).toFixed(1)}x the 20-bar average volume`)
      : no(`Sweep bar traded only ${(last.volume / avgVol).toFixed(1)}x the 20-bar average volume`);
  },

  sweep_not_reclaimed: (s) => {
    const last = lastBar(s);
    if (!last) return no('No bars available');
    if (s.resistance !== null && last.close > s.resistance) {
      return yes(`Price closed above resistance ${s.resistance.toFixed(1)} — this is acceptance, not a sweep`);
    }
    if (s.support !== null && last.close < s.support) {
      return yes(`Price closed below support ${s.support.toFixed(1)} — this is acceptance, not a sweep`);
    }
    return no('The swept level was reclaimed');
  },

  // ------------------------------------------------------- fake breakout
  broke_key_level: (s) => {
    const recent = s.candles.slice(-4);
    if (recent.length < 2) return no('Not enough bars');
    if (s.resistance !== null && recent.some((c) => c.close > s.resistance!)) {
      return yes(`A bar closed above resistance ${s.resistance.toFixed(1)} within the last 4 bars`);
    }
    if (s.support !== null && recent.some((c) => c.close < s.support!)) {
      return yes(`A bar closed below support ${s.support.toFixed(1)} within the last 4 bars`);
    }
    return no('No recent close beyond a key swing level');
  },

  breakout_failed: (s) => {
    const last = lastBar(s);
    if (!last) return no('No bars available');
    const recent = s.candles.slice(-4, -1);
    if (s.resistance !== null && recent.some((c) => c.close > s.resistance!) && last.close < s.resistance) {
      return yes(`The move above ${s.resistance.toFixed(1)} reversed back below it`);
    }
    if (s.support !== null && recent.some((c) => c.close < s.support!) && last.close > s.support) {
      return yes(`The move below ${s.support.toFixed(1)} reversed back above it`);
    }
    return no('The breakout has not failed');
  },

  breakout_volume_fading: (s) => {
    if (s.candles.length < 3) return no('Not enough bars');
    const last = s.candles[s.candles.length - 1];
    const prev = s.candles[s.candles.length - 2];
    return last.volume < prev.volume * 0.7
      ? yes(`Volume fell to ${((last.volume / Math.max(1, prev.volume)) * 100).toFixed(0)}% of the breakout bar`)
      : no(`Volume held at ${((last.volume / Math.max(1, prev.volume)) * 100).toFixed(0)}% of the breakout bar`);
  },

  breakout_sustained: (s) => {
    const last = lastBar(s);
    if (!last) return no('No bars available');
    const avgVol = averageVolume(s.candles);
    const beyond =
      (s.resistance !== null && last.close > s.resistance) || (s.support !== null && last.close < s.support);
    return beyond && avgVol > 0 && last.volume > avgVol
      ? yes(`The breakout is holding on ${(last.volume / avgVol).toFixed(1)}x average volume`)
      : no('The breakout is not being sustained on volume');
  },

  // ----------------------------------------------------------- ICT / SMC
  fair_value_gap: (s) => {
    if (s.candles.length < 3) return no('Not enough bars');
    const [c1, , c3] = s.candles.slice(-3);
    if (c1.high < c3.low) return yes(`Bullish fair value gap between ${c1.high.toFixed(1)} and ${c3.low.toFixed(1)}`);
    if (c1.low > c3.high) return yes(`Bearish fair value gap between ${c3.high.toFixed(1)} and ${c1.low.toFixed(1)}`);
    return no('No unmitigated fair value gap in the last 3 bars');
  },

  market_structure_shift: (s) => {
    const levels = swingLevels(s.candles);
    const last = lastBar(s);
    if (!levels || !last) return no('No swing structure available');
    if (last.close > levels.resistance) return yes(`Structure shifted up through ${levels.resistance.toFixed(1)}`);
    if (last.close < levels.support) return yes(`Structure shifted down through ${levels.support.toFixed(1)}`);
    return no('Swing structure is intact — no shift');
  },

  order_block_mitigated: (s) => {
    // The last opposite-colour bar preceding the impulse that broke structure.
    const window = s.candles.slice(-12);
    if (window.length < 4) return no('Not enough bars to locate an order block');
    const last = window[window.length - 1];
    const impulseUp = last.close > window[0].close;
    for (let i = window.length - 2; i >= 1; i--) {
      const c = window[i];
      const isBlock = impulseUp ? c.close < c.open : c.close > c.open;
      if (!isBlock) continue;
      const mitigated = last.low <= c.high && last.high >= c.low;
      return mitigated
        ? yes(`Price returned into the ${impulseUp ? 'bullish' : 'bearish'} order block at ${c.low.toFixed(1)}–${c.high.toFixed(1)}`)
        : no(`The ${impulseUp ? 'bullish' : 'bearish'} order block at ${c.low.toFixed(1)}–${c.high.toFixed(1)} is unmitigated`);
    }
    return no('No order block identified in the last 12 bars');
  },

  structure_shift_invalidated: (s) => {
    const levels = swingLevels(s.candles);
    const last = lastBar(s);
    if (!levels || !last) return no('No swing structure available');
    const inside = last.close <= levels.resistance && last.close >= levels.support;
    return inside
      ? yes(`Price fell back inside ${levels.support.toFixed(1)}–${levels.resistance.toFixed(1)}, undoing the shift`)
      : no('The structure shift is holding');
  },

  // ------------------------------------------------------------- Wyckoff
  wyckoff_spring_or_upthrust: (s) => {
    if (s.candles.length < 3) return no('Not enough bars');
    const last = s.candles[s.candles.length - 1];
    const prev = s.candles[s.candles.length - 2];
    if (s.support !== null && prev.low < s.support && last.close > s.support) {
      return yes(`Spring: the probe below ${s.support.toFixed(1)} was reclaimed on the next bar`);
    }
    if (s.resistance !== null && prev.high > s.resistance && last.close < s.resistance) {
      return yes(`Upthrust: the probe above ${s.resistance.toFixed(1)} was rejected on the next bar`);
    }
    return no('No spring or upthrust in the last two bars');
  },

  range_bound_context: (s) => {
    const p = s.marketProfile;
    if (!p) return no('No market profile classified yet');
    const ranging = p.structure === 'ranging' || p.structure === 'consolidating';
    return ranging
      ? yes(`Session profile is ${p.type} — a trading range, the context Wyckoff phases require`)
      : no(`Session profile is ${p.type} — not a trading range`);
  },

  range_broken: (s) => {
    const last = lastBar(s);
    if (!last) return no('No bars available');
    if (s.support !== null && last.close < s.support) return yes(`Range floor ${s.support.toFixed(1)} gave way`);
    if (s.resistance !== null && last.close > s.resistance) return yes(`Range ceiling ${s.resistance.toFixed(1)} gave way`);
    return no('The range is still holding');
  },

  // ------------------------------------------------------------- shared
  volume_supports_move: (s) => {
    const last = lastBar(s);
    if (!last) return no('No bars available');
    const avgVol = averageVolume(s.candles);
    if (avgVol <= 0) return no('No volume baseline');
    return last.volume >= avgVol
      ? yes(`Current bar volume is ${(last.volume / avgVol).toFixed(1)}x the 20-bar average`)
      : no(`Current bar volume is only ${(last.volume / avgVol).toFixed(1)}x the 20-bar average`);
  },
};

export function isKnownRule(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(STRATEGY_RULES, id);
}
