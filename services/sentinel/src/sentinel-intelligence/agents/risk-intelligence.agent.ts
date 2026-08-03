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
import type { AgentId, AgentVerdict, RiskProfile } from '../types';

/**
 * Risk Intelligence — how dangerous is the current environment?
 *
 * Reads the existing eight-factor `RiskAssessment` (Module 6) and adds the
 * request-specific layer the shared engine cannot know about: the trader's
 * stated risk profile and style. The same 62/100 environment is a different
 * proposition for a conservative positional participant than for an aggressive
 * scalper, and this agent says so explicitly rather than reporting one number
 * as if it applied to everyone.
 *
 * The stance is always `risk-elevated` or `neutral` — never directional. Risk
 * is orthogonal to direction, and reporting it on the directional axis would
 * make the cross-checker treat "this is dangerous" as disagreement with "this
 * is bullish", which are not in conflict at all.
 */
@Injectable()
export class RiskIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'risk-intelligence';
  readonly remit = 'The risk environment, scored against the trader’s stated profile and style.';

  reason(context: AgentContext): AgentVerdict {
    const builder = new VerdictBuilder(this.id, context.subtask.id);
    const risk = context.risk;

    if (!risk) {
      return builder.abstain('The risk engine did not run for this observation.').build();
    }

    builder.measured(
      `Overall risk scores ${risk.overallRisk.toFixed(0)}/100 (${risk.level.replace(/_/g, ' ')})`,
      risk.overallRisk,
      0.9,
    );

    // Surface the factors actually driving the score, not all eight — an
    // undifferentiated list of eight numbers is not evidence, it is noise.
    const drivers = [...risk.factors]
      .filter((f) => f.score >= 50)
      .sort((a, b) => b.score * b.weight - a.score * a.weight)
      .slice(0, 4);

    for (const factor of drivers) {
      builder.derived(
        `${factor.name} at ${factor.score.toFixed(0)}/100${factor.evidence[0] ? ` — ${factor.evidence[0]}` : ''}`,
        factor.score,
        Math.min(0.85, 0.3 + factor.weight * 2),
      );
    }

    if (drivers.length === 0) {
      builder.derived('No individual risk factor scores above 50/100', risk.overallRisk, 0.5);
    }

    // ---- account context, when it exists --------------------------------
    const account = context.account;
    if (account?.marginUsed !== undefined && account.totalCapital) {
      const utilisation = (account.marginUsed / account.totalCapital) * 100;
      builder.measured(
        `Margin utilisation is ${utilisation.toFixed(1)}% of total capital`,
        utilisation,
        utilisation > 60 ? 0.8 : 0.4,
      );
    } else {
      // Explicitly unmeasured, never assumed to be zero — a fabricated "0%
      // utilised" reads as a safe account rather than an unknown one.
      builder.derived('Margin utilisation is unmeasured — no account snapshot was supplied', null, 0.2);
    }

    // ---- profile-relative reading ---------------------------------------
    const profile = context.understood.riskProfile;
    const tolerance = TOLERANCE[profile];
    const relative = risk.overallRisk / Math.max(1, tolerance);

    builder.derived(
      `Against a ${profile} profile (tolerance ${tolerance}/100), this environment reads at ${(relative * 100).toFixed(0)}% of tolerance`,
      relative,
      0.7,
    );

    if (context.understood.style === 'scalping' && (context.snapshot?.realizedVolPct ?? 0) > 1.2) {
      builder.derived(
        `Realized volatility of ${(context.snapshot?.realizedVolPct ?? 0).toFixed(2)}% per bar is elevated for a scalping timeframe`,
        context.snapshot?.realizedVolPct ?? null,
        0.6,
      );
    }

    const citations = gatherCitations(
      context,
      ['position sizing volatility risk of ruin', `${profile} risk tolerance drawdown`],
      { preferKinds: ['book', 'knowledge-base'] },
    );
    if (citations.length > 0) {
      builder.knowledge(
        'The literature is consistent that position size, not entry accuracy, is what determines survival through a losing sequence.',
        citations,
        0.6,
      );
    }
    builder.supporting(gatherConcepts(context, `risk management ${profile} position sizing`));

    const elevated = relative >= 1;
    const structural = Math.min(0.95, 0.3 + Math.min(1, relative) * 0.6);

    return builder
      .quality(account ? 1 : 0.75)
      .conclude(
        elevated ? 'risk-elevated' : 'neutral',
        blendConfidence(structural, groundingScore(citations)),
        elevated
          ? `Risk reads ${risk.overallRisk.toFixed(0)}/100, above what a ${profile} profile would normally accept${drivers[0] ? `, driven by ${drivers[0].name.toLowerCase()}` : ''}.`
          : `Risk reads ${risk.overallRisk.toFixed(0)}/100, within the range a ${profile} profile would normally accept.`,
      )
      .build();
  }
}

/**
 * Risk score a profile is assumed to tolerate before the environment is called
 * elevated *for that trader*. These are thresholds for framing an observation,
 * not position-sizing advice.
 */
const TOLERANCE: Record<RiskProfile, number> = {
  conservative: 40,
  balanced: 60,
  aggressive: 78,
  unspecified: 60,
};
