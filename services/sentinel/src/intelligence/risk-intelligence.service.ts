/**
 * Module 6 — Risk Intelligence Engine.
 *
 * Evaluates eight dimensions of risk before any guidance is surfaced. Scores
 * run 0-100 where **higher means riskier**; the Confidence Engine inverts the
 * aggregate so that a risky read can only ever *lower* confidence.
 *
 * This engine deliberately consumes the signals the other agents have already
 * computed rather than re-deriving behaviour or re-querying news. The emotion
 * and news readings have exactly one owner each
 * (`EmotionIntelligenceService`, `NewsIntelligenceService`); this module
 * translates them into a risk dimension, it does not recompute them.
 *
 * Every factor states what it could not measure. A dimension with no data
 * reports a neutral score and says so, rather than inventing a number.
 */
import { Injectable } from '@nestjs/common';
import { AccountSummary, RiskAssessment, RiskFactor, RiskLevel, Signal } from '../domain';
import { istTimeLabel, minutesToClose, sessionProgress, SQUARE_OFF_MIN, istMinutesOfDay } from '../market-clock';
import { MarketSnapshot } from './market-intelligence.service';

/** Factor weights, summing to 1. */
const WEIGHTS = {
  market_risk: 0.15,
  trade_risk: 0.2,
  position_risk: 0.15,
  volatility_risk: 0.1,
  news_risk: 0.1,
  emotional_risk: 0.15,
  liquidity_risk: 0.1,
  time_risk: 0.05,
} as const;

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

@Injectable()
export class RiskIntelligenceService {
  assess(
    snapshot: MarketSnapshot,
    signals: Signal[],
    account: AccountSummary | undefined,
    at: Date = new Date(),
  ): RiskAssessment {
    const factors: RiskFactor[] = [
      this.marketRisk(snapshot),
      this.tradeRisk(snapshot),
      this.positionRisk(account, signals),
      this.volatilityRisk(snapshot),
      this.newsRisk(signals),
      this.emotionalRisk(signals),
      this.liquidityRisk(snapshot, at),
      this.timeRisk(at),
    ];

    const overallRisk = clamp(factors.reduce((sum, f) => sum + f.score * f.weight, 0));

    return {
      overallRisk,
      level: levelFor(overallRisk),
      factors,
      assessedAt: at.toISOString(),
    };
  }

  /** Risk signals worth putting on the Observation Feed in their own right. */
  signals(assessment: RiskAssessment): Signal[] {
    return assessment.factors
      .filter((f) => f.score >= 70)
      .map((f) => ({
        name: `elevated_${f.name}`,
        agent: 'risk' as const,
        triggered: true,
        // A risk factor's contribution to the composite gate is its weight —
        // the same weight it carries inside the risk aggregate, so one number
        // governs both paths.
        weight: f.weight,
        evidence: f.evidence,
        data: { score: f.score, ...f.data },
      }));
  }

  // 1. Market Risk — is the regime one where setups resolve or churn?
  private marketRisk(s: MarketSnapshot): RiskFactor {
    let score = 45;
    const evidence: string[] = [];
    const profile = s.marketProfile;

    if (!profile) {
      evidence.push('Not enough session history to classify the market regime');
    } else {
      evidence.push(`Session profile: ${profile.type}`);
      if (profile.trend === 'choppy') {
        score += 25;
        evidence.push('Choppy, non-directional structure — setups resolve unreliably here');
      }
      if (profile.volatility === 'high') {
        score += 15;
        evidence.push('High-volatility regime widens the range of outcomes');
      }
      if (profile.structure === 'trending') {
        score -= 15;
        evidence.push('Trending structure — the regime setups are designed for');
      }
      if (profile.structure === 'consolidating') {
        score += 10;
        evidence.push('Consolidating structure — direction is unresolved');
      }
    }

    if (s.breadthRatio !== null) {
      if (s.breadthRatio < 0.8) {
        score += 10;
        evidence.push(`Advance/decline ratio ${s.breadthRatio.toFixed(2)} — breadth is not confirming`);
      } else if (s.breadthRatio > 1.5) {
        score -= 5;
        evidence.push(`Advance/decline ratio ${s.breadthRatio.toFixed(2)} — broad participation`);
      }
    } else {
      evidence.push('Market breadth unavailable');
    }

    return { name: 'market_risk', score: clamp(score), weight: WEIGHTS.market_risk, evidence };
  }

  // 2. Trade Risk — how close is price to the level that would invalidate it?
  private tradeRisk(s: MarketSnapshot): RiskFactor {
    let score = 35;
    const evidence: string[] = [];

    const candidates: { label: string; level: number }[] = [];
    if (s.support !== null) candidates.push({ label: 'support', level: s.support });
    if (s.resistance !== null) candidates.push({ label: 'resistance', level: s.resistance });

    if (candidates.length === 0 || s.lastPrice === 0) {
      evidence.push('No swing levels identified — the invalidation distance cannot be measured');
      return { name: 'trade_risk', score: 50, weight: WEIGHTS.trade_risk, evidence };
    }

    const nearest = candidates.reduce((a, b) =>
      Math.abs(s.lastPrice - a.level) <= Math.abs(s.lastPrice - b.level) ? a : b,
    );
    const distancePct = (Math.abs(s.lastPrice - nearest.level) / s.lastPrice) * 100;

    if (distancePct < 0.25) {
      score += 35;
      evidence.push(`Price is ${distancePct.toFixed(2)}% from ${nearest.label} ${nearest.level.toFixed(1)} — invalidation is immediate`);
    } else if (distancePct < 0.75) {
      score += 20;
      evidence.push(`Price is ${distancePct.toFixed(2)}% from ${nearest.label} ${nearest.level.toFixed(1)}`);
    } else if (distancePct < 1.5) {
      score += 5;
      evidence.push(`Price is ${distancePct.toFixed(2)}% from ${nearest.label} ${nearest.level.toFixed(1)}`);
    } else {
      score -= 10;
      evidence.push(`Price is ${distancePct.toFixed(2)}% from ${nearest.label} ${nearest.level.toFixed(1)} — room before invalidation`);
    }

    if (s.realizedVolPct !== null && s.realizedVolPct > 1.2) {
      score += 10;
      evidence.push(`Realized volatility ${s.realizedVolPct.toFixed(2)}% per bar can cross that distance inside a single bar`);
    }

    return {
      name: 'trade_risk',
      score: clamp(score),
      weight: WEIGHTS.trade_risk,
      evidence,
      data: { nearestLevel: nearest.level, nearestLevelType: nearest.label, distancePct },
    };
  }

  // 3. Position Risk — margin utilisation and sizing, from services/api.
  private positionRisk(account: AccountSummary | undefined, signals: Signal[]): RiskFactor {
    let score = 30;
    const evidence: string[] = [];
    const data: Record<string, unknown> = {};

    const marginUsed = account?.marginUsed;
    const marginAvailable = account?.marginAvailable;
    if (typeof marginUsed === 'number' && typeof marginAvailable === 'number' && marginUsed + marginAvailable > 0) {
      const ratio = marginUsed / (marginUsed + marginAvailable);
      data.marginRatio = ratio;
      if (ratio > 0.8) {
        score += 35;
        evidence.push(`Margin utilisation is ${(ratio * 100).toFixed(0)}% — little headroom left`);
      } else if (ratio > 0.6) {
        score += 20;
        evidence.push(`Margin utilisation is ${(ratio * 100).toFixed(0)}%`);
      } else if (ratio > 0.4) {
        score += 10;
        evidence.push(`Margin utilisation is ${(ratio * 100).toFixed(0)}%`);
      } else {
        score -= 5;
        evidence.push(`Margin utilisation is ${(ratio * 100).toFixed(0)}% — conservative`);
      }
    } else {
      evidence.push('Margin utilisation not supplied for this account');
    }

    const leverage = account?.leverage;
    if (typeof leverage === 'number' && leverage > 0) {
      data.leverage = leverage;
      if (leverage > 5) {
        score += 20;
        evidence.push(`Account leverage is ${leverage}x`);
      } else if (leverage > 3) {
        score += 10;
        evidence.push(`Account leverage is ${leverage}x`);
      }
    }

    // Sizing drift is already measured by the Emotion agent — reuse its verdict
    // rather than recomputing it from trades this engine never sees.
    const drift = signals.find((sig) => sig.name === 'position_sizing_drift');
    if (drift?.triggered) {
      score += 15;
      evidence.push(...drift.evidence);
    }

    return { name: 'position_risk', score: clamp(score), weight: WEIGHTS.position_risk, evidence, data };
  }

  // 4. Volatility Risk — India VIX and realized volatility.
  private volatilityRisk(s: MarketSnapshot): RiskFactor {
    let score = 30;
    const evidence: string[] = [];

    if (s.vix === null) {
      evidence.push('India VIX unavailable');
      score = 50;
    } else if (s.vix > 25) {
      score += 40;
      evidence.push(`India VIX at ${s.vix.toFixed(1)} — extreme`);
    } else if (s.vix > 20) {
      score += 25;
      evidence.push(`India VIX at ${s.vix.toFixed(1)} — elevated`);
    } else if (s.vix > 15) {
      score += 10;
      evidence.push(`India VIX at ${s.vix.toFixed(1)} — moderately elevated`);
    } else if (s.vix < 11) {
      score += 5;
      evidence.push(`India VIX at ${s.vix.toFixed(1)} — compressed, which historically precedes expansion`);
    } else {
      score -= 10;
      evidence.push(`India VIX at ${s.vix.toFixed(1)} — stable`);
    }

    if (s.realizedVolPct !== null) {
      if (s.realizedVolPct > 1.5) {
        score += 15;
        evidence.push(`Realized volatility ${s.realizedVolPct.toFixed(2)}% per bar over the last 20 bars`);
      } else if (s.realizedVolPct < 0.4) {
        score -= 5;
        evidence.push(`Realized volatility ${s.realizedVolPct.toFixed(2)}% per bar — quiet tape`);
      }
    }

    return { name: 'volatility_risk', score: clamp(score), weight: WEIGHTS.volatility_risk, evidence, data: { vix: s.vix } };
  }

  /**
   * 5. News Risk. The market data contract exposes *published* news
   * (`getNews(symbols, sinceHours)`), not a forward economic calendar, so this
   * factor measures recent high-impact flow and says so plainly rather than
   * claiming a look-ahead it does not have.
   */
  private newsRisk(signals: Signal[]): RiskFactor {
    const newsSignal = signals.find((sig) => sig.name === 'news_driven_volatility');
    if (!newsSignal) {
      return {
        name: 'news_risk',
        score: 40,
        weight: WEIGHTS.news_risk,
        evidence: ['News intelligence did not report for this symbol'],
      };
    }
    const score = newsSignal.triggered ? 65 : 20;
    return {
      name: 'news_risk',
      score,
      weight: WEIGHTS.news_risk,
      evidence: [
        ...newsSignal.evidence,
        'Measured over published news in the last 24h — Sentinel does not have a forward economic calendar feed',
      ],
      data: newsSignal.data,
    };
  }

  // 6. Emotional Risk — the Emotion agent's readings, weighted into risk.
  private emotionalRisk(signals: Signal[]): RiskFactor {
    const emotion = signals.filter((sig) => sig.agent === 'emotion');
    if (emotion.length === 0) {
      return {
        name: 'emotional_risk',
        score: 20,
        weight: WEIGHTS.emotional_risk,
        evidence: ['No trade history supplied for this session — behavioural risk cannot be assessed'],
      };
    }

    const triggered = emotion.filter((sig) => sig.triggered);
    if (triggered.length === 0) {
      return {
        name: 'emotional_risk',
        score: 15,
        weight: WEIGHTS.emotional_risk,
        evidence: [`None of the ${emotion.length} behavioural checks triggered this session`],
      };
    }

    // Each triggered behaviour contributes its own weight, scaled into 0-100.
    const raw = triggered.reduce((sum, sig) => sum + sig.weight, 0);
    const score = clamp(20 + raw * 100);
    return {
      name: 'emotional_risk',
      score,
      weight: WEIGHTS.emotional_risk,
      evidence: triggered.flatMap((sig) => sig.evidence),
      data: { triggered: triggered.map((sig) => sig.name) },
    };
  }

  /**
   * 7. Liquidity Risk. Order-book depth is not part of the MarketDataProvider
   * contract, so this is measured from participation and time of day — the
   * observable proxies — and the limitation is stated in the evidence.
   */
  private liquidityRisk(s: MarketSnapshot, at: Date): RiskFactor {
    let score = 30;
    const evidence: string[] = [];

    if (s.volumeVsAvg === null) {
      evidence.push('Volume baseline unavailable');
      score = 50;
    } else if (s.volumeVsAvg < 0.5) {
      score += 30;
      evidence.push(`Current volume is ${(s.volumeVsAvg * 100).toFixed(0)}% of the 20-bar average — thin participation`);
    } else if (s.volumeVsAvg < 0.7) {
      score += 18;
      evidence.push(`Current volume is ${(s.volumeVsAvg * 100).toFixed(0)}% of the 20-bar average`);
    } else if (s.volumeVsAvg > 1.5) {
      score -= 12;
      evidence.push(`Current volume is ${(s.volumeVsAvg * 100).toFixed(0)}% of the 20-bar average — deep participation`);
    }

    const mins = istMinutesOfDay(at);
    if (mins >= 12 * 60 && mins <= 13 * 60) {
      score += 8;
      evidence.push('Midday lull — liquidity is typically at its session low');
    }

    evidence.push('Measured from traded volume; bid-ask depth is not exposed by the market data contract');

    return { name: 'liquidity_risk', score: clamp(score), weight: WEIGHTS.liquidity_risk, evidence };
  }

  // 8. Time Risk — where in the session we are.
  private timeRisk(at: Date): RiskFactor {
    const evidence: string[] = [];
    const remaining = minutesToClose(at);
    const progress = sessionProgress(at);
    const mins = istMinutesOfDay(at);
    let score = 15;

    if (remaining < 0 || progress <= 0) {
      evidence.push(`${istTimeLabel(at)} IST — outside regular trading hours`);
      return { name: 'time_risk', score: 85, weight: WEIGHTS.time_risk, evidence };
    }

    if (remaining <= 15) {
      score += 45;
      evidence.push(`${remaining} minutes to the close — closing auction dynamics dominate`);
    } else if (remaining <= 30) {
      score += 30;
      evidence.push(`${remaining} minutes to the close`);
    } else if (mins >= SQUARE_OFF_MIN) {
      score += 25;
      evidence.push(`${istTimeLabel(at)} IST — inside the intraday square-off window`);
    } else if (progress > 0.8) {
      score += 15;
      evidence.push(`${(progress * 100).toFixed(0)}% of the session has elapsed`);
    } else {
      evidence.push(`${(progress * 100).toFixed(0)}% of the session has elapsed (${istTimeLabel(at)} IST)`);
    }

    return { name: 'time_risk', score: clamp(score), weight: WEIGHTS.time_risk, evidence, data: { minutesToClose: remaining } };
  }
}

function levelFor(score: number): RiskLevel {
  if (score <= 20) return 'very_low';
  if (score <= 40) return 'low';
  if (score <= 60) return 'moderate';
  if (score <= 80) return 'high';
  return 'extreme';
}
