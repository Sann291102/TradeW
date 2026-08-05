import { Injectable } from '@nestjs/common';
import { Signal } from '../domain';
import { regimeFromProfile } from '../reasoning/regime-intelligence.service';
import type { Regime } from '../reasoning/types';
import type { MarketSnapshot } from './market-intelligence.service';
import {
  analyseLiquidity,
  analyseStructure,
  readBehaviour,
  type LiquidityRead,
  type MarketBehaviour,
  type MarketStructure,
} from './market-structure';

/**
 * Market Behaviour Intelligence — Phase 2.
 *
 * Sentinel already computed indicators (Module 1) and matched strategies
 * (Module 2). What it could not do was describe *behaviour*: that price made a
 * higher low, ran the stops resting above the previous high, and continued —
 * as opposed to printing an RSI of 62.
 *
 * This service composes the pure analysis in `market-structure.ts` into one
 * read per observation, and emits it as observation-only `Signal`s so it flows
 * through every existing surface — the confidence engine, the agent activity
 * timeline, and the publication gate's corroboration count — without any of
 * them needing to know this module exists.
 *
 * ## Why this is not a second market classifier
 *
 * Regime classification is delegated to `regimeFromProfile`, the same function
 * `RegimeIntelligenceService` uses. A second classifier reading the same
 * snapshot would eventually disagree with the first, and there would be no
 * principled way to say which was right. Structure and liquidity are genuinely
 * new reads; the regime is borrowed.
 */
export interface MarketBehaviourRead {
  regime: Regime | null;
  structure: MarketStructure;
  liquidity: LiquidityRead;
  behaviour: MarketBehaviour;
  /** A trader-readable narrative composed from the three reads above. */
  narrative: string;
  evidence: string[];
}

@Injectable()
export class MarketBehaviourService {
  /**
   * Analyse one snapshot.
   *
   * Synchronous and pure over its input — it fetches nothing. The snapshot has
   * already paid for the market data, and re-fetching here would let the
   * behaviour read and the detection that triggered it disagree by a tick.
   */
  analyse(snapshot: MarketSnapshot): MarketBehaviourRead {
    const candles = snapshot.candles ?? [];
    const structure = analyseStructure(candles);
    const liquidity = analyseLiquidity(candles);
    const behaviour = readBehaviour(structure, liquidity, {
      volumeVsAvg: snapshot.volumeVsAvg,
      momentumScore: snapshot.trendAnalysis?.momentumScore ?? null,
    });
    const regime = snapshot.marketProfile ? regimeFromProfile(snapshot.marketProfile) : null;

    const evidence = [...structure.evidence, ...liquidity.evidence, ...behaviour.evidence];
    return {
      regime,
      structure,
      liquidity,
      behaviour,
      narrative: composeNarrative(snapshot.symbol, regime, structure, liquidity, behaviour),
      evidence: [...new Set(evidence)],
    };
  }

  /**
   * Behaviour as observation-only signals.
   *
   * Weights are capped well below the risk agents' range on purpose: a
   * structural read is context, and must not be able to trip the composite
   * risk-warning threshold on its own. That threshold exists for behavioural
   * and trap signals, and diluting it with structure would make genuine safety
   * warnings harder to distinguish.
   */
  signals(read: MarketBehaviourRead): Signal[] {
    const out: Signal[] = [];

    out.push({
      name: 'market_structure',
      agent: 'market-technical',
      triggered: read.structure.state !== 'undefined' && read.structure.state !== 'range',
      weight: 0.15,
      evidence: read.structure.evidence,
      data: {
        state: read.structure.state,
        event: read.structure.event,
        direction: read.structure.eventDirection,
        lastSwingHigh: read.structure.lastSwingHigh?.price ?? null,
        lastSwingLow: read.structure.lastSwingLow?.price ?? null,
      },
    });

    out.push({
      name: 'liquidity_behaviour',
      agent: 'market-technical',
      triggered: read.liquidity.recentSweep !== null,
      weight: 0.15,
      evidence: read.liquidity.evidence,
      data: {
        pools: read.liquidity.pools.slice(0, 3),
        sweep: read.liquidity.recentSweep,
      },
    });

    // A change of character is the one behaviour read that genuinely warrants
    // attention on its own — it is the earliest structural evidence that a
    // trend a trader may be positioned with is failing.
    out.push({
      name: read.behaviour.read === 'reversal-risk' ? 'reversal_risk' : 'trend_continuation',
      agent: 'market-technical',
      triggered: read.behaviour.read === 'continuation' || read.behaviour.read === 'reversal-risk',
      weight: read.behaviour.read === 'reversal-risk' ? 0.25 : 0.2,
      evidence: read.behaviour.evidence,
      data: {
        read: read.behaviour.read,
        direction: read.behaviour.direction,
        strength: read.behaviour.strength,
        regime: read.regime,
      },
    });

    return out;
  }
}

/**
 * The trader-facing sentence.
 *
 * Non-directive by construction: it names what the market is doing and what
 * that behaviour is called, never what to do about it. Phrasing is checked
 * against the vocabulary enforcer downstream like every other composed string.
 */
function composeNarrative(
  symbol: string,
  regime: Regime | null,
  structure: MarketStructure,
  liquidity: LiquidityRead,
  behaviour: MarketBehaviour,
): string {
  if (structure.state === 'undefined') {
    return `${symbol}: not enough confirmed structure yet to describe market behaviour.`;
  }

  const parts: string[] = [];
  parts.push(`${symbol} is in ${describeStructure(structure.state)}`);
  if (regime) parts.push(`within a ${regime.replace(/-/g, ' ')} regime`);

  let sentence = parts.join(' ') + '.';

  if (structure.event === 'change-of-character') {
    sentence += ` Character has changed ${structure.eventDirection === 'bullish' ? 'upward' : 'downward'} — the prior trend is no longer making the sequence it needs to continue.`;
  } else if (structure.event === 'break-of-structure') {
    sentence += ` Structure broke ${structure.eventDirection === 'bullish' ? 'higher' : 'lower'}, continuing the existing sequence.`;
  }

  const sweep = liquidity.recentSweep;
  if (sweep?.reclaimed) {
    sentence += ` Liquidity resting ${sweep.side} ${sweep.price.toFixed(1)} was taken and the level reclaimed.`;
  }

  const unswept = liquidity.pools.filter((p) => !p.swept).slice(0, 1)[0];
  if (unswept) {
    sentence += ` Untested liquidity remains at ${unswept.price.toFixed(1)} (${unswept.touches} touches).`;
  }

  sentence += ` Current behaviour reads as ${behaviour.read.replace(/-/g, ' ')} at ${(behaviour.strength * 100).toFixed(0)}% supporting evidence.`;
  return sentence;
}

function describeStructure(state: MarketStructure['state']): string {
  switch (state) {
    case 'uptrend':
      return 'an uptrend structure (higher highs, higher lows)';
    case 'downtrend':
      return 'a downtrend structure (lower highs, lower lows)';
    case 'range':
      return 'a ranging structure with no directional sequence';
    default:
      return 'an undefined structure';
  }
}
