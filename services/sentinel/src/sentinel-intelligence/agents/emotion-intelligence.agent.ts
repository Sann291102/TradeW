import { Injectable } from '@nestjs/common';
import {
  AgentContext,
  IntelligenceAgent,
  VerdictBuilder,
  blendConfidence,
  gatherCitations,
  gatherConcepts,
  groundingScore,
  triggeredFrom,
} from './agent.contract';
import type { AgentId, AgentVerdict, TradeLike } from '../types';

/** Below this many trades, behavioural patterns are indistinguishable from noise. */
const MIN_TRADES_FOR_PATTERN = 4;

/**
 * Emotion Intelligence — what the trader's own recent actions show.
 *
 * The behavioural signals come from the existing `EmotionIntelligenceService`.
 * This agent adds a session-shape read over the same trades (clustering,
 * escalating size after losses, round-trip frequency) and grounds it in the
 * trading-psychology half of the corpus.
 *
 * It never reports an all-clear from thin data. With fewer than four trades
 * there is no behavioural pattern to find, and saying "no issues detected"
 * would be read as reassurance rather than as the absence of evidence it
 * actually is — so the agent abstains and the decomposer records why.
 */
@Injectable()
export class EmotionIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'emotion-intelligence';
  readonly remit = 'Behavioural patterns in the trader’s own recent activity — reflective, never judgemental.';

  reason(context: AgentContext): AgentVerdict {
    const builder = new VerdictBuilder(this.id, context.subtask.id);
    const trades = context.trades;

    if (trades.length === 0) {
      return builder.abstain('No recent trades were supplied, so behaviour cannot be read.').build();
    }
    if (trades.length < MIN_TRADES_FOR_PATTERN) {
      return builder
        .abstain(
          `Only ${trades.length} recent trade${trades.length === 1 ? '' : 's'} — fewer than ${MIN_TRADES_FOR_PATTERN}, which is too few to distinguish a pattern from ordinary activity.`,
        )
        .build();
    }

    const triggered = triggeredFrom(context.signals, 'emotion');
    for (const signal of triggered) {
      builder.measured(signal.evidence[0] ?? signal.name.replace(/_/g, ' '), null, Math.min(0.9, 0.4 + signal.weight));
    }

    // ---- session shape, computed here from the same trades --------------
    const shape = analyseSession(trades);

    builder.measured(
      `${trades.length} trades in the supplied window, ${shape.symbolsTraded} distinct symbol${shape.symbolsTraded === 1 ? '' : 's'}`,
      trades.length,
      0.4,
    );

    if (shape.medianGapMinutes !== null) {
      builder.derived(
        `Median gap between trades is ${shape.medianGapMinutes.toFixed(0)} minutes`,
        shape.medianGapMinutes,
        shape.medianGapMinutes < 5 ? 0.75 : 0.35,
      );
    }
    if (shape.rapidReentries > 0) {
      builder.derived(
        `${shape.rapidReentries} re-entry/re-entries within 3 minutes of the previous trade`,
        shape.rapidReentries,
        0.7,
      );
    }
    if (shape.sizeEscalationAfterLoss !== null) {
      builder.derived(
        `Average position size after a losing trade is ${shape.sizeEscalationAfterLoss.toFixed(2)}x the size after a winning one`,
        shape.sizeEscalationAfterLoss,
        shape.sizeEscalationAfterLoss > 1.4 ? 0.85 : 0.4,
      );
    }

    const cues = [
      ...triggered.map((s) => s.name.replace(/_/g, ' ')),
      ...(shape.rapidReentries >= 2 ? ['rapid re-entry'] : []),
      ...(shape.sizeEscalationAfterLoss !== null && shape.sizeEscalationAfterLoss > 1.4 ? ['size escalation after loss'] : []),
    ];

    const citations = gatherCitations(
      context,
      [cues.length > 0 ? `${cues.join(' ')} trading psychology` : 'trading discipline process consistency'],
      { preferKinds: ['book'] },
    );
    if (citations.length > 0) {
      builder.knowledge(
        cues.length > 0
          ? `The psychology literature names this pattern and describes it as a response to the previous outcome rather than to the current setup.`
          : 'The psychology literature treats consistent process between trades as the observable marker of discipline.',
        citations,
        0.65,
      );
    }
    builder.supporting(gatherConcepts(context, cues.join(' ') || 'trading discipline psychology'));

    if (cues.length === 0) {
      return builder
        .quality(Math.min(1, trades.length / 10))
        .conclude(
          'neutral',
          0.35,
          `Across ${trades.length} recent trades, spacing and sizing look consistent — no behavioural pattern stands out.`,
        )
        .build();
    }

    const structural = Math.min(
      0.95,
      0.3 + triggered.reduce((sum, s) => sum + s.weight, 0) + (shape.rapidReentries >= 2 ? 0.15 : 0),
    );

    return builder
      .quality(Math.min(1, trades.length / 10))
      .conclude(
        'risk-elevated',
        blendConfidence(structural, groundingScore(citations)),
        `Recent activity shows ${cues.slice(0, 2).join(' and ')} — worth a moment's reflection before the next decision.`,
      )
      .build();
  }
}

export interface SessionShape {
  symbolsTraded: number;
  medianGapMinutes: number | null;
  rapidReentries: number;
  /** Mean post-loss size ÷ mean post-win size, or null when either is absent. */
  sizeEscalationAfterLoss: number | null;
}

/**
 * Behavioural shape of a trade sequence.
 *
 * Trades arrive most-recent-first from `services/api`, so they are sorted
 * ascending here before any gap or sequence arithmetic — computing "the trade
 * after a loss" on a reversed list measures the trade *before* it, which
 * inverts the entire finding.
 */
export function analyseSession(trades: TradeLike[]): SessionShape {
  const ordered = [...trades].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const delta =
      (new Date(ordered[i].createdAt).getTime() - new Date(ordered[i - 1].createdAt).getTime()) / 60_000;
    if (Number.isFinite(delta) && delta >= 0) gaps.push(delta);
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGapMinutes = sortedGaps.length > 0 ? sortedGaps[Math.floor(sortedGaps.length / 2)] : null;
  const rapidReentries = gaps.filter((g) => g <= 3).length;

  const afterLoss: number[] = [];
  const afterWin: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1].realizedPnl;
    if (previous === undefined) continue;
    const notional = ordered[i].quantity * ordered[i].fillPrice;
    if (previous < 0) afterLoss.push(notional);
    else if (previous > 0) afterWin.push(notional);
  }

  const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
  const sizeEscalationAfterLoss =
    afterLoss.length > 0 && afterWin.length > 0 && mean(afterWin) > 0 ? mean(afterLoss) / mean(afterWin) : null;

  return {
    symbolsTraded: new Set(ordered.map((t) => t.symbol)).size,
    medianGapMinutes,
    rapidReentries,
    sizeEscalationAfterLoss,
  };
}
