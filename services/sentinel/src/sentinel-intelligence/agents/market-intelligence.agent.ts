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
import type { AgentId, AgentVerdict } from '../types';

/**
 * Market Intelligence — the structural read.
 *
 * Consumes the shared snapshot produced by the EXISTING
 * `MarketIntelligenceService` (Module 1) rather than recomputing indicators,
 * then does the thing that service does not: grounds the classification in the
 * learned corpus, so "this is a compression regime" arrives with the passages
 * that define compression and what it typically resolves into.
 */
@Injectable()
export class MarketIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'market-intelligence';
  readonly remit = 'Structure, regime and indicator posture for the symbol in focus.';

  reason(context: AgentContext): AgentVerdict {
    const builder = new VerdictBuilder(this.id, context.subtask.id);
    const snapshot = context.snapshot;

    if (!snapshot || snapshot.candles.length < 20) {
      return builder
        .abstain(
          snapshot
            ? `Only ${snapshot.candles.length} bars available for ${context.understood.market.symbol}; structure cannot be read from fewer than 20.`
            : `No market data available for ${context.understood.market.symbol}.`,
        )
        .build();
    }

    const profile = snapshot.marketProfile;
    const trend = snapshot.trendAnalysis;

    // ---- measured structure -------------------------------------------
    builder.measured(`Last price ${snapshot.lastPrice.toFixed(2)}`, snapshot.lastPrice, 0.3);

    if (profile) {
      builder.measured(`Session classified as ${profile.type} — ${profile.description}`, profile.type, 0.8);
      for (const line of profile.evidence.slice(0, 3)) builder.derived(line, null, 0.4);
    }
    if (trend) {
      builder.derived(
        `Session change ${trend.sessionChangePct >= 0 ? '+' : ''}${trend.sessionChangePct.toFixed(2)}% with ${(trend.momentumScore * 100).toFixed(0)}% directional persistence`,
        trend.sessionChangePct,
        0.7,
      );
    }
    if (snapshot.ema20 !== null && snapshot.ema50 !== null) {
      const posture = snapshot.ema20 > snapshot.ema50 ? 'above' : 'below';
      builder.derived(
        `EMA20 ${snapshot.ema20.toFixed(1)} is ${posture} EMA50 ${snapshot.ema50.toFixed(1)}`,
        snapshot.ema20 - snapshot.ema50,
        0.6,
      );
    }
    if (snapshot.vwap !== null) {
      builder.derived(
        `Price is ${snapshot.lastPrice >= snapshot.vwap ? 'above' : 'below'} VWAP ${snapshot.vwap.toFixed(1)}`,
        snapshot.lastPrice - snapshot.vwap,
        0.6,
      );
    }
    if (snapshot.rsi14 !== null) {
      builder.measured(`RSI(14) at ${snapshot.rsi14.toFixed(1)}`, snapshot.rsi14, 0.5);
    }
    for (const signal of triggeredFrom(context.signals, 'market-technical')) {
      builder.derived(signal.evidence[0] ?? signal.name, null, Math.min(0.8, signal.weight + 0.2));
    }

    // ---- knowledge grounding -------------------------------------------
    const profileQuery = profile
      ? `${profile.type} ${profile.structure} ${profile.trend} market regime`
      : `${context.understood.market.symbol} market structure`;
    const citations = gatherCitations(context, [profileQuery], { preferKinds: ['book', 'knowledge-base'] });
    const concepts = gatherConcepts(context, profileQuery);

    if (citations.length > 0 && profile) {
      builder.knowledge(
        `The literature characterises ${profile.structure} structure the way this session is behaving.`,
        citations,
        0.6,
      );
    }
    builder.supporting(concepts);

    // ---- verdict --------------------------------------------------------
    const bias = profile?.trend ?? trend?.direction ?? 'neutral';
    const stance = bias === 'bullish' ? 'bullish' : bias === 'bearish' ? 'bearish' : 'neutral';

    // Structural confidence rises with directional persistence and with how
    // many independent indicators agree with the profile's own read.
    const agreement = this.indicatorAgreement(context, stance);
    const persistence = trend?.momentumScore ?? 0.3;
    const structural = 0.35 + 0.35 * persistence + 0.3 * agreement;

    const grounding = groundingScore(citations);
    const dataQuality = Math.min(1, snapshot.candles.length / 60) * (profile ? 1 : 0.7);

    return builder
      .quality(dataQuality)
      .conclude(
        stance,
        blendConfidence(structural, grounding),
        profile
          ? `${profile.type}: ${profile.description}.`
          : `${context.understood.market.symbol} is showing ${stance} structure on the ${context.understood.timeframe} timeframe.`,
      )
      .build();
  }

  /**
   * 0..1 — the share of available directional indicators pointing the same way
   * as the profile classification.
   *
   * Counted only over indicators that actually have a value: dividing by a
   * fixed denominator would penalise a thin tape for missing data rather than
   * for genuine disagreement.
   */
  private indicatorAgreement(context: AgentContext, stance: string): number {
    const snapshot = context.snapshot;
    if (!snapshot || stance === 'neutral') return 0.5;
    const bullish = stance === 'bullish';

    const votes: boolean[] = [];
    if (snapshot.ema20 !== null && snapshot.ema50 !== null) {
      votes.push(bullish ? snapshot.ema20 > snapshot.ema50 : snapshot.ema20 < snapshot.ema50);
    }
    if (snapshot.vwap !== null) {
      votes.push(bullish ? snapshot.lastPrice > snapshot.vwap : snapshot.lastPrice < snapshot.vwap);
    }
    if (snapshot.macdHistogram !== null) {
      votes.push(bullish ? snapshot.macdHistogram > 0 : snapshot.macdHistogram < 0);
    }
    if (snapshot.rsi14 !== null) {
      votes.push(bullish ? snapshot.rsi14 > 50 : snapshot.rsi14 < 50);
    }
    if (snapshot.cpr) {
      votes.push(bullish ? snapshot.lastPrice > snapshot.cpr.tc : snapshot.lastPrice < snapshot.cpr.bc);
    }

    if (votes.length === 0) return 0.5;
    return votes.filter(Boolean).length / votes.length;
  }
}
