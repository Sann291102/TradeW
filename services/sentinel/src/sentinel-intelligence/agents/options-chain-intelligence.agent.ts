import { Injectable } from '@nestjs/common';
import {
  AgentContext,
  IntelligenceAgent,
  VerdictBuilder,
  blendConfidence,
  gatherCitations,
  gatherConcepts,
  groundingScore,
} from './agent.contract';
import type { AgentId, AgentVerdict } from '../types';

/**
 * Options Chain Intelligence — what positioning says, around the strike in focus.
 *
 * Reads the `OptionChainRead` the existing Market Intelligence engine already
 * derives (PCR, max pain, OI walls, front expiry only). Two behaviours are
 * worth calling out:
 *
 * **Positioning is not direction.** A put-heavy chain is routinely read as
 * bearish and is just as routinely the opposite — put writers are short
 * volatility below spot, which is a support structure. This agent reports
 * walls as *levels where price is likely to meet resistance to movement*, and
 * only takes a directional stance when spot's position relative to the walls
 * makes one structurally implied.
 *
 * **Max pain is a pin, not a forecast.** Proximity to max pain raises the odds
 * of range-bound behaviour into expiry; it says nothing about which way price
 * leaves afterwards, and the agent does not pretend otherwise.
 */
@Injectable()
export class OptionsChainIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'options-chain-intelligence';
  readonly remit = 'Option-chain positioning: OI walls, put-call ratio, max-pain pin and the strike in focus.';

  reason(context: AgentContext): AgentVerdict {
    const builder = new VerdictBuilder(this.id, context.subtask.id);
    const chain = context.snapshot?.optionChain ?? null;
    const spot = context.snapshot?.lastPrice ?? 0;

    if (!chain) {
      return builder
        .abstain(
          `No option chain is available for ${context.understood.market.symbol}, so positioning cannot be read.`,
        )
        .build();
    }

    builder.measured(
      `Put-Call OI ratio ${chain.pcr.toFixed(2)} across ${chain.strikesAnalysed} strikes at the front expiry`,
      chain.pcr,
      0.6,
    );
    builder.measured(`Max pain sits at ${chain.maxPain.toFixed(0)}`, chain.maxPain, 0.6);

    if (chain.callOIWall !== null) {
      builder.derived(
        `Heaviest call OI above spot is at ${chain.callOIWall.toFixed(0)} — writers are defending that level`,
        chain.callOIWall,
        0.7,
      );
    }
    if (chain.putOIWall !== null) {
      builder.derived(
        `Heaviest put OI below spot is at ${chain.putOIWall.toFixed(0)} — writers are defending that level`,
        chain.putOIWall,
        0.7,
      );
    }

    // ---- the strike in focus -------------------------------------------
    const strike = context.understood.strike;
    if (strike !== null && spot > 0) {
      const distancePct = ((strike - spot) / spot) * 100;
      const moneyness =
        Math.abs(distancePct) < 0.25
          ? 'at the money'
          : context.understood.right === 'PE'
            ? distancePct > 0
              ? 'in the money'
              : 'out of the money'
            : distancePct > 0
              ? 'out of the money'
              : 'in the money';
      builder.derived(
        `The ${strike}${context.understood.right ?? ''} strike is ${Math.abs(distancePct).toFixed(2)}% ${distancePct >= 0 ? 'above' : 'below'} spot ${spot.toFixed(1)} — ${moneyness}`,
        distancePct,
        0.8,
      );
    }

    const pinDistPct = spot > 0 ? Math.abs(spot - chain.maxPain) / spot : 1;
    const nearPin = pinDistPct < 0.003;
    if (nearPin) {
      builder.derived(
        `Spot is within ${(pinDistPct * 100).toFixed(2)}% of max pain — conditions that historically favour range-bound behaviour into expiry`,
        pinDistPct,
        0.75,
      );
    }

    const citations = gatherCitations(
      context,
      ['open interest wall option writers defend level', 'max pain pin expiry behaviour', 'put call ratio contrarian interpretation'],
      { preferKinds: ['book', 'knowledge-base'] },
    );
    if (citations.length > 0) {
      builder.knowledge(
        'The corpus treats concentrated open interest as a level participants have an economic incentive to defend, rather than as a directional signal on its own.',
        citations,
        0.65,
      );
    }
    builder.supporting(gatherConcepts(context, 'open interest positioning max pain put call ratio'));

    // ---- stance ---------------------------------------------------------
    // Direction is only taken when spot's position between the walls makes one
    // structurally implied — spot pressed against a call wall with a distant
    // put wall has asymmetric room below, and vice versa.
    let stance: 'bullish' | 'bearish' | 'neutral' | 'risk-elevated' = 'neutral';
    let structural = 0.35;
    let headline = `Positioning is balanced — PCR ${chain.pcr.toFixed(2)}, max pain ${chain.maxPain.toFixed(0)}.`;

    if (nearPin) {
      stance = 'neutral';
      structural = 0.6;
      headline = `Spot is pinned near max pain ${chain.maxPain.toFixed(0)} — positioning favours range-bound behaviour into expiry.`;
    } else if (chain.callOIWall !== null && chain.putOIWall !== null && spot > 0) {
      const roomUp = (chain.callOIWall - spot) / spot;
      const roomDown = (spot - chain.putOIWall) / spot;
      if (roomUp > roomDown * 2.2 && roomUp > 0.004) {
        stance = 'bullish';
        structural = 0.55;
        headline = `Spot sits well clear of the call wall at ${chain.callOIWall.toFixed(0)} with the put wall close below at ${chain.putOIWall.toFixed(0)} — more room above than below.`;
      } else if (roomDown > roomUp * 2.2 && roomDown > 0.004) {
        stance = 'bearish';
        structural = 0.55;
        headline = `Spot is pressed against the call wall at ${chain.callOIWall.toFixed(0)} with the put wall far below at ${chain.putOIWall.toFixed(0)} — more room below than above.`;
      }
    }

    if (chain.pcr > 1.8 || chain.pcr < 0.5) {
      // Extreme positioning is a fragility signal in either direction: an
      // unwind of a crowded side moves price violently regardless of which
      // side is crowded.
      stance = stance === 'neutral' ? 'risk-elevated' : stance;
      structural = Math.max(structural, 0.6);
      headline += ` Positioning is lopsided (PCR ${chain.pcr.toFixed(2)}), which makes an unwind more violent in either direction.`;
    }

    // Data quality follows chain depth: a five-strike chain supports far less
    // than a forty-strike one, and max pain over a thin chain is near-meaningless.
    const dataQuality = Math.min(1, chain.strikesAnalysed / 20);

    return builder
      .quality(dataQuality)
      .conclude(stance, blendConfidence(structural, groundingScore(citations)), headline)
      .build();
  }
}
