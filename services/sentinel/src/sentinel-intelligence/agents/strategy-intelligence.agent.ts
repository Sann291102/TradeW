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
import type { StrategyDetection } from '../../intelligence/strategy-engine.service';

/**
 * Strategy Intelligence — does a learned method actually confirm right now?
 *
 * Rule evaluation is delegated to the existing declarative Strategy Engine
 * (Module 2), which keeps user-authored strategies as *data*: a YAML file can
 * compose named predicates but can never introduce logic into the observation
 * path. This agent adds two things on top: it grounds each strategy in the
 * corpus that describes it, and it reports unmet rules as prominently as met
 * ones.
 *
 * That second point is the whole design. A strategy at "4 of 7 rules" is not a
 * setup, and an agent that reported only the 4 would be systematically
 * optimistic — the single most dangerous failure mode available to something
 * that comments on live markets.
 */
@Injectable()
export class StrategyIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'strategy-intelligence';
  readonly remit = 'Whether learned strategy rules confirm, partially confirm, or invalidate on live structure.';

  reason(context: AgentContext): AgentVerdict {
    const builder = new VerdictBuilder(this.id, context.subtask.id);
    const requested = context.understood.strategyIds;

    if (!context.snapshot) {
      return builder.abstain('No market data available, so no strategy rule could be evaluated.').build();
    }

    // When the user named strategies, judge those. Otherwise judge whatever
    // the engine found — but never silently substitute one for the other.
    const relevant = requested.length > 0 ? context.detections.filter((d) => matches(d, requested)) : context.detections;

    if (requested.length > 0 && relevant.length === 0) {
      const citations = gatherCitations(context, requested.map((id) => id.replace(/-/g, ' ')), {
        preferKinds: ['user-rule', 'book'],
      });
      const builderWithKnowledge = citations.length > 0
        ? builder.knowledge(
            `The corpus describes ${requested.join(', ')}, but the engine has no live detection for it on this symbol and timeframe.`,
            citations,
            0.4,
          )
        : builder;
      return builderWithKnowledge
        .quality(0.6)
        .conclude(
          'neutral',
          0.25,
          `${requested.join(', ')} is not currently detected on ${context.understood.market.symbol}. No rules are confirming.`,
        )
        .build();
    }

    if (relevant.length === 0) {
      return builder
        .quality(0.8)
        .conclude('neutral', 0.2, 'No strategy in the handbook currently has confirming rules on this structure.')
        .build();
    }

    const leading = [...relevant].sort((a, b) => b.confidence - a.confidence)[0];
    const totalRules = leading.rulesMatched.length + leading.rulesUnmet.length;
    const matchRatio = totalRules > 0 ? leading.rulesMatched.length / totalRules : 0;

    builder.measured(
      `${leading.strategyName}: ${leading.rulesMatched.length} of ${totalRules} rules confirmed`,
      matchRatio,
      0.9,
    );
    for (const rule of leading.rulesMatched.slice(0, 4)) builder.derived(rule, true, 0.6);

    // Unmet rules are evidence too, and carry real strength — this is what
    // stops a half-formed setup being reported as a setup.
    for (const rule of leading.rulesUnmet.slice(0, 3)) {
      builder.derived(`Not yet confirmed — ${rule}`, false, 0.5);
    }
    for (const invalidation of leading.invalidationsTriggered) {
      builder.derived(`Invalidation triggered — ${invalidation}`, false, 0.9);
    }

    for (const other of relevant.slice(1, 3)) {
      builder.derived(
        `${other.strategyName} also partially confirming (${other.rulesMatched.length}/${other.rulesMatched.length + other.rulesUnmet.length})`,
        other.confidence,
        0.35,
      );
    }

    const strategyQuery = `${leading.strategyName} ${leading.rulesMatched.slice(0, 2).join(' ')}`;
    const citations = gatherCitations(context, [strategyQuery], { preferKinds: ['user-rule', 'book'] });
    if (citations.length > 0) {
      builder.knowledge(
        `${leading.strategyName} is described in the learned corpus, and the rules confirming here are the ones it names.`,
        citations,
        0.65,
      );
    }
    builder.supporting(gatherConcepts(context, strategyQuery));

    // An invalidated setup is a bearish-for-the-setup fact regardless of its
    // nominal bias, so it collapses to neutral rather than reporting the
    // direction the strategy would have implied had it held.
    const invalidated = leading.invalidationsTriggered.length > 0;
    const stance = invalidated
      ? 'neutral'
      : leading.bias === 'bullish'
        ? 'bullish'
        : leading.bias === 'bearish'
          ? 'bearish'
          : 'neutral';

    // Rule-match ratio is the dominant term: the engine's own confidence
    // already scales with it, and squaring the emphasis here keeps partial
    // setups well below the surfacing gate.
    const structural = invalidated ? 0.2 : Math.min(1, matchRatio * (leading.validated ? 1 : 0.75));
    const grounding = groundingScore(citations);

    return builder
      .quality(totalRules > 0 ? 1 : 0.5)
      .conclude(
        stance,
        blendConfidence(structural, grounding),
        invalidated
          ? `${leading.strategyName} has invalidated — ${leading.invalidationsTriggered[0]}.`
          : leading.validated
            ? `${leading.strategyName} is fully confirmed: all ${totalRules} rules met.`
            : `${leading.strategyName} is forming — ${leading.rulesMatched.length} of ${totalRules} rules confirmed.`,
      )
      .build();
  }
}

/**
 * Match a detection against a requested id.
 *
 * Compares on a normalised slug so `orb-breakout`, `orb_breakout` and
 * `ORB Breakout` all resolve to the same strategy — users and YAML authors
 * write it all three ways.
 */
function matches(detection: StrategyDetection, requested: string[]): boolean {
  const target = normalise(detection.strategyId);
  const name = normalise(detection.strategyName);
  return requested.some((id) => {
    const wanted = normalise(id);
    return target === wanted || name === wanted || target.includes(wanted) || wanted.includes(target);
  });
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
