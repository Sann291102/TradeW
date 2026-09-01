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
import { describeOIAction, judgePositioning } from '../../execution/option-positioning';
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
 *
 * ## What the 2026-09-01 pass added
 *
 * Everything above reads a SNAPSHOT of the book. A snapshot is the weakest
 * thing a chain has to say: a 66-lakh call wall being added to and a 66-lakh
 * call wall being unwound are identical in it and mean opposite things. So the
 * agent now also reads `context.positioning` — the same shared read every
 * other agent sees — which carries, per strike, today's change in open
 * interest and the four-quadrant action that change plus the premium implies.
 *
 * That turns each wall from a level into a level plus a verb, and it is what
 * makes the difference between "there is resistance at 24,100" (true on every
 * day of the week and useful on none of them) and "the writers at 24,100
 * reduced today while price rose", which is a statement about what is
 * happening now.
 *
 * The stance still refuses to be a direction generator. Change in positioning
 * can move the agent's confidence and can flip a neutral read to a directional
 * one where the structure is unambiguous, but the vocabulary stays
 * observational throughout — levels are defended, moves through them are
 * accepted or rejected, and nothing here is a call to act.
 */
@Injectable()
export class OptionsChainIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'options-chain-intelligence';
  readonly remit = 'Option-chain positioning: OI walls, put-call ratio, max-pain pin and the strike in focus.';

  reason(context: AgentContext): AgentVerdict {
    return this.read(context, []);
  }

  /**
   * The one thing this agent knows that no other agent can see.
   *
   * Market, strategy and historical intelligence all read the INDEX. This
   * agent reads the option book, and the book's answer to "is the level you
   * are heading for being defended harder or lighter today" is not derivable
   * from any chart. So when the desk has settled on a direction, the useful
   * contribution is not to restate positioning — it is to say whether the book
   * corroborates that specific direction or contradicts it, and to name which
   * level decides it.
   *
   * Strictly within remit (rule 2 on `IntelligenceAgent.deliberate`): the peer
   * verdicts are read for one thing only, the direction the rest of the desk
   * leans, and nothing about the structure behind that lean is restated here.
   */
  deliberate(context: AgentContext, peers: readonly AgentVerdict[]): AgentVerdict {
    return this.read(context, peers);
  }

  private read(context: AgentContext, peers: readonly AgentVerdict[]): AgentVerdict {
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

    // ---- the levels, and what their defenders did today -----------------
    //
    // `positioning` supersedes the two raw wall strikes when it is present:
    // it carries the same levels ranked in the order price would meet them,
    // plus the verb. The raw walls remain the fallback for a chain whose
    // positioning could not be read at all, because a level with no verb is
    // still better than no level.
    const positioning = context.positioning;
    const nearestResistance = positioning?.resistances[0] ?? null;
    const nearestSupport = positioning?.supports[0] ?? null;

    if (nearestResistance) {
      builder.derived(nearestResistance.note, nearestResistance.strike, nearestResistance.defence === 'unknown' ? 0.6 : 0.8);
    } else if (chain.callOIWall !== null) {
      builder.derived(
        `Heaviest call OI above spot is at ${chain.callOIWall.toFixed(0)} — writers are defending that level`,
        chain.callOIWall,
        0.7,
      );
    }
    if (nearestSupport) {
      builder.derived(nearestSupport.note, nearestSupport.strike, nearestSupport.defence === 'unknown' ? 0.6 : 0.8);
    } else if (chain.putOIWall !== null) {
      builder.derived(
        `Heaviest put OI below spot is at ${chain.putOIWall.toFixed(0)} — writers are defending that level`,
        chain.putOIWall,
        0.7,
      );
    }

    if (positioning?.hasOIChange) {
      builder.measured(
        `Previous-day open interest was published for ${(positioning.oiChangeCoverage * 100).toFixed(0)}% of the chain's legs, so today's change in positioning is readable`,
        positioning.oiChangeCoverage,
        0.9,
      );
      builder.derived(positioning.migration.note, positioning.migration.callShiftSteps ?? 0, 0.75);
      const atm = positioning.strikes.find((row) => row.strike === positioning.atmStrike);
      if (atm) {
        builder.derived(
          `At the ${atm.strike} strike nearest spot, calls show ${describeOIAction(atm.callAction)} and puts show ${describeOIAction(atm.putAction)}; strike-level put-call OI ratio ${atm.pcr === null ? 'not computable' : atm.pcr.toFixed(2)}`,
          atm.pcr ?? 0,
          0.7,
        );
      }
    } else if (positioning) {
      builder.derived(
        "Previous-day open interest was not published for enough of this chain, so the levels below are known by size only and not by whether they are being reinforced or reduced",
        positioning.oiChangeCoverage,
        0.5,
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

    // ---- what today's change does to that stance ------------------------
    //
    // Applied AFTER the static read rather than instead of it, and it moves
    // the stance only where the structure is unambiguous: the level ahead is
    // being abandoned by its defenders, the level behind is being reinforced,
    // and the whole book migrated the same way. Two of the three agreeing is
    // enough to raise confidence in the static read; all three is enough to
    // take a direction the static read left neutral.
    //
    // Deliberately does not act on migration alone. A book migrating up while
    // the levels themselves are unchanged is far more often a roll into the
    // next expiry than a directional statement, and this agent has no way to
    // tell those apart.
    if (positioning?.hasOIChange) {
      const migratedUp = positioning.migration.direction === 'up';
      const migratedDown = positioning.migration.direction === 'down';
      const bullishVotes =
        (nearestResistance?.defence === 'eroding' ? 1 : 0) +
        (nearestSupport?.defence === 'reinforcing' ? 1 : 0) +
        (migratedUp ? 1 : 0);
      const bearishVotes =
        (nearestSupport?.defence === 'eroding' ? 1 : 0) +
        (nearestResistance?.defence === 'reinforcing' ? 1 : 0) +
        (migratedDown ? 1 : 0);

      if (bullishVotes >= 2 && bullishVotes > bearishVotes) {
        if (stance === 'neutral' && bullishVotes === 3) stance = 'bullish';
        structural = Math.min(0.8, structural + 0.05 * bullishVotes);
        headline += ` Today the structure moved with a bullish reading: ${bullishVotes} of three positioning changes point that way.`;
      } else if (bearishVotes >= 2 && bearishVotes > bullishVotes) {
        if (stance === 'neutral' && bearishVotes === 3) stance = 'bearish';
        structural = Math.min(0.8, structural + 0.05 * bearishVotes);
        headline += ` Today the structure moved with a bearish reading: ${bearishVotes} of three positioning changes point that way.`;
      } else if (bullishVotes > 0 && bullishVotes === bearishVotes) {
        // Both sides adding is a widening fight over the same ground, not a
        // direction, and the honest report is that the book is contested.
        structural = Math.max(structural, 0.5);
        headline += ' Both sides added to their levels today, so the book is contested rather than trending.';
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
    //
    // Halved when today's change could not be read. That is not a penalty for
    // a missing field — it is an accurate statement about how much of the
    // question this verdict actually answered, and it is what stops a
    // change-blind read carrying the same weight in synthesis as a complete one.
    const depthQuality = Math.min(1, chain.strikesAnalysed / 20);
    const dataQuality = positioning?.hasOIChange ? depthQuality : depthQuality * 0.5;

    // ---- the deliberation round -----------------------------------------
    //
    // Empty on the first pass, so everything above is exactly what this agent
    // has always said on its own. With peers present, the agent answers ONE
    // question that no other agent on the desk can: does the option book
    // corroborate the direction the rest of them settled on, and which level
    // decides it.
    const lean = leadingPeerDirection(peers);
    if (lean && positioning) {
      const judged = judgePositioning(positioning, lean === 'bullish' ? 'CE' : 'PE');
      builder.derived(
        `The rest of the desk leans ${lean}; against that direction the book reads "${judged.verdict}" — ${judged.summary}`,
        judged.score,
        positioning.hasOIChange ? 0.85 : 0.5,
      );
      for (const signal of judged.signals) {
        if (signal.value === 0) continue;
        builder.derived(
          `${signal.label} ${signal.value > 0 ? 'supports' : 'opposes'} the ${lean} case: ${signal.detail}`,
          signal.value,
          0.7,
        );
      }

      if (judged.verdict === 'conflicts') {
        // The disagreement IS the contribution, and it is expressed as this
        // agent's own stance rather than as a note on someone else's — a
        // verdict the cross-checker can weigh, not a comment it must parse.
        //
        // The stance is `risk-elevated`, never the opposite direction. The book
        // disagreeing with a bullish structure is not a bearish read of the
        // book; it is a statement that the structure is heading into defended
        // ground, and the honest expression of that is elevated risk.
        stance = 'risk-elevated';
        structural = Math.max(structural, 0.65);
        headline =
          `The desk leans ${lean}, and option positioning does not corroborate it: ` +
          `${judged.nextLevel === null ? 'no defended level stands in the path' : `the level that decides it is ${judged.nextLevel}`}. ${judged.summary}`;
      } else if (judged.verdict === 'confirms') {
        // Corroboration is REPORTED and does not move the stance or the
        // confidence. The synthesis already rewards agreement between agents;
        // an agent that also rewarded it internally would have the same
        // agreement counted twice. See rule 3 on `IntelligenceAgent.deliberate`.
        headline += ` Option positioning corroborates the ${lean} lean${judged.nextLevel === null ? '' : `, with ${judged.nextLevel} the level that decides it`}.`;
      } else {
        headline += ` Option positioning is neither for nor against the desk's ${lean} lean.`;
      }
    }

    return builder
      .quality(dataQuality)
      .conclude(stance, blendConfidence(structural, groundingScore(citations)), headline)
      .build();
  }
}

/**
 * The direction the rest of the desk leans, or null when it has not settled.
 *
 * Weighted by each peer's own confidence, abstentions excluded, and
 * `risk-elevated` ignored entirely — a peer reporting a dangerous tape has not
 * taken a direction, and counting it as one would let a risk warning decide
 * which side this agent judges the book against.
 *
 * Null when the two sides are within a tenth of each other. A desk that has
 * not settled has no lean to corroborate, and picking the marginally larger
 * half would manufacture one.
 */
function leadingPeerDirection(peers: readonly AgentVerdict[]): 'bullish' | 'bearish' | null {
  let bullish = 0;
  let bearish = 0;
  for (const peer of peers) {
    if (peer.abstained) continue;
    const weight = peer.confidence * peer.dataQuality;
    if (peer.stance === 'bullish') bullish += weight;
    else if (peer.stance === 'bearish') bearish += weight;
  }
  if (bullish === 0 && bearish === 0) return null;
  if (Math.abs(bullish - bearish) < 0.1) return null;
  return bullish > bearish ? 'bullish' : 'bearish';
}
