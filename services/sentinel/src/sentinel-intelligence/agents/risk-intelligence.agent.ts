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
import { judgePositioning } from '../../execution/option-positioning';
import type { AgentId, AgentVerdict, RiskProfile, Stance } from '../types';

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
 *
 * ## What it can only know by conferring
 *
 * The eight-factor assessment scores the ENVIRONMENT. It has no idea what the
 * desk intends to do in that environment, and the same 58/100 tape is a
 * materially different proposition when the rest of the desk has settled on a
 * direction that the option book is positioned against. That fact exists in no
 * single agent's inputs — it is the join of the desk's lean and the book's
 * defended levels — so it is exactly what the deliberation round is for.
 */
@Injectable()
export class RiskIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'risk-intelligence';
  readonly remit = 'The risk environment, scored against the trader’s stated profile and style.';

  reason(context: AgentContext): AgentVerdict {
    return this.read(context, []);
  }

  /**
   * A second look with the desk's lean in hand.
   *
   * Within remit throughout: this agent does not evaluate whether the lean is
   * right, and says nothing about direction. It reads the lean only to ask its
   * own question — is the environment more dangerous than the factor scores
   * alone can show — and answers on its own axis.
   */
  deliberate(context: AgentContext, peers: readonly AgentVerdict[]): AgentVerdict {
    return this.read(context, peers);
  }

  private read(context: AgentContext, peers: readonly AgentVerdict[]): AgentVerdict {
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

    let elevated = relative >= 1;
    let structural = Math.min(0.95, 0.3 + Math.min(1, relative) * 0.6);
    let headline = elevated
      ? `Risk reads ${risk.overallRisk.toFixed(0)}/100, above what a ${profile} profile would normally accept${drivers[0] ? `, driven by ${drivers[0].name.toLowerCase()}` : ''}.`
      : `Risk reads ${risk.overallRisk.toFixed(0)}/100, within the range a ${profile} profile would normally accept.`;

    // ---- the deliberation round -----------------------------------------
    //
    // Empty on the first pass. With peers present, one question: has the desk
    // settled on a direction that the option book is positioned against? That
    // is not an environment factor and could never be one — it is a property
    // of the desk's own conclusion, which the risk engine cannot see.
    const lean = leadingPeerDirection(peers);
    if (lean && context.positioning) {
      const judged = judgePositioning(context.positioning, lean === 'bullish' ? 'CE' : 'PE');
      if (judged.verdict === 'conflicts') {
        elevated = true;
        structural = Math.min(0.95, structural + 0.15);
        headline =
          `${headline} The desk leans ${lean} while option positioning is set against it` +
          `${judged.nextLevel === null ? '' : ` at ${judged.nextLevel}`}, which raises the environment's risk beyond what the factor scores alone show.`;
        builder.derived(
          `The desk's ${lean} lean runs into positioning that does not support it (${judged.summary})`,
          judged.score,
          0.8,
        );
      } else {
        builder.derived(
          `The desk's ${lean} lean is not contradicted by option positioning (${judged.verdict})`,
          judged.score,
          0.5,
        );
      }
    }

    return builder
      .quality(account ? 1 : 0.75)
      .conclude(
        elevated ? 'risk-elevated' : 'neutral',
        blendConfidence(structural, groundingScore(citations)),
        headline,
      )
      .build();
  }
}

/**
 * The direction the rest of the desk leans, or null when it has not settled.
 *
 * Weighted by each peer's confidence and data quality, abstentions excluded,
 * and `risk-elevated` ignored — a peer reporting a dangerous tape has taken no
 * direction, and this agent must not read its own axis back as one. Null when
 * the two sides are within a tenth of each other: a desk that has not settled
 * has no lean, and picking the marginally larger half would invent one.
 */
function leadingPeerDirection(peers: readonly AgentVerdict[]): 'bullish' | 'bearish' | null {
  const weightFor = (stance: Stance) =>
    peers
      .filter((p) => !p.abstained && p.stance === stance)
      .reduce((sum, p) => sum + p.confidence * p.dataQuality, 0);
  const bullish = weightFor('bullish');
  const bearish = weightFor('bearish');
  if (bullish === 0 && bearish === 0) return null;
  if (Math.abs(bullish - bearish) < 0.1) return null;
  return bullish > bearish ? 'bullish' : 'bearish';
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
