/**
 * Module 7 — Confidence Engine.
 *
 * Synthesises every intelligence module into one transparent percentage.
 * Seven weighted factors produce a base score; explicit, itemised deductions
 * then reduce it. Both halves are returned in full, because Master Plan
 * principle 7 requires that a trader be able to reconstruct the number.
 *
 * Guidance is surfaced only when the result clears the configured threshold
 * (default 85%). Below it Sentinel stays in Wait and Watch — silence is a
 * feature, not a gap (principle 1).
 */
import { Injectable } from '@nestjs/common';
import {
  ConfidenceBreakdown,
  ConfidenceDeduction,
  ConfidenceFactor,
  RiskAssessment,
  Signal,
} from '../domain';
import { HistoricalSimilarityResult } from '../brain/historical-similarity.service';
import { StrategyDetection } from '../intelligence/strategy-engine.service';
import { MarketSnapshot } from '../intelligence/market-intelligence.service';
import { istTimeLabel, minutesToClose, SQUARE_OFF_MIN, istMinutesOfDay } from '../market-clock';

/** Factor weights, summing to 1. */
export const CONFIDENCE_WEIGHTS = {
  trend_profile_alignment: 0.15,
  strategy_rules_match: 0.2,
  volume_liquidity_support: 0.12,
  news_environment_alignment: 0.1,
  option_chain_pcr_support: 0.1,
  historical_similarity_match: 0.13,
  risk_engine_score: 0.2,
} as const;

export type ConfidenceFactorName = keyof typeof CONFIDENCE_WEIGHTS;

/**
 * The default confidence bar.
 *
 * Lowered from the Master Plan's original fixed 85% to the canonical 70%
 * publication threshold. The 85 was doing filtering that structural checks
 * should do: it suppressed genuinely corroborated setups for being 84%
 * certain while still, in principle, admitting an 86% score assembled mostly
 * from factors reporting "no data".
 *
 * Confidence is now one of four conditions rather than the whole gate — see
 * `orchestrator/publication-gate.ts`, which additionally requires every
 * mandatory strategy confirmation, an absence of conflicting evidence, and
 * corroboration across independent reasoning modules. Quality comes from
 * corroboration, not from an artificially high percentage.
 *
 * Overridable per request, but the publication gate floors any request at 70:
 * a trader may demand more evidence, never less.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 70;

export interface ConfidenceInput {
  snapshot: MarketSnapshot;
  detections: StrategyDetection[];
  risk: RiskAssessment;
  signals: Signal[];
  historical: HistoricalSimilarityResult | null;
  threshold?: number;
  at?: Date;
}

const clamp = (n: number): number => Math.max(0, Math.min(100, n));

@Injectable()
export class ConfidenceEngine {
  /**
   * Recalibrated weights, keyed by factor name. Module 12 writes here after a
   * nightly backtest; until it does, the Master Plan defaults apply. Kept as
   * a delta so the published defaults stay visible in the code.
   */
  private weightOverrides: Partial<Record<ConfidenceFactorName, number>> = {};

  compute(input: ConfidenceInput): ConfidenceBreakdown {
    const at = input.at ?? new Date();
    const threshold = input.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

    const factors: ConfidenceFactor[] = [
      this.trendProfileAlignment(input),
      this.strategyRulesMatch(input),
      this.volumeLiquiditySupport(input),
      this.newsEnvironmentAlignment(input),
      this.optionChainSupport(input),
      this.historicalSimilarityMatch(input),
      this.riskEngineScore(input),
    ];

    const totalWeight = factors.reduce((s, f) => s + f.weight, 0) || 1;
    const weightedScore = factors.reduce((s, f) => s + f.score * f.weight, 0) / totalWeight;

    const deductions = this.deductions(input, at);
    const score = clamp(weightedScore - deductions.reduce((s, d) => s + d.points, 0));

    return {
      score: Number(score.toFixed(1)),
      weightedScore: Number(weightedScore.toFixed(1)),
      threshold,
      meetsThreshold: score >= threshold,
      factors,
      deductions,
      computedAt: at.toISOString(),
    };
  }

  private weight(name: ConfidenceFactorName): number {
    return this.weightOverrides[name] ?? CONFIDENCE_WEIGHTS[name];
  }

  // 1 ------------------------------------------------------------------
  private trendProfileAlignment({ snapshot, detections }: ConfidenceInput): ConfidenceFactor {
    const profile = snapshot.marketProfile;
    const trend = snapshot.trendAnalysis;
    const evidence: string[] = [];
    let score = 50;

    if (!profile || !trend) {
      evidence.push('Not enough session history to classify structure — treated as neutral, not as confirmation');
      return factor('trend_profile_alignment', 'Trend & Profile Alignment', 45, this.weight('trend_profile_alignment'), evidence);
    }

    const strongProfiles = ['Bullish Trend Day', 'Bearish Trend Day', 'Gap & Go'];
    const weakProfiles = ['High Volatility Range', 'Low Volatility Compression', 'Inside Day'];
    if (strongProfiles.includes(profile.type)) {
      score = 88;
      evidence.push(`${profile.type}: ${profile.description}`);
    } else if (weakProfiles.includes(profile.type)) {
      score = 38;
      evidence.push(`${profile.type} — structure has not resolved a direction`);
    } else {
      score = 62;
      evidence.push(`${profile.type}: ${profile.description}`);
    }

    evidence.push(`Directional persistence ${(trend.momentumScore * 100).toFixed(0)}%, session change ${trend.sessionChangePct >= 0 ? '+' : ''}${trend.sessionChangePct.toFixed(2)}%`);
    score += (trend.momentumScore - 0.5) * 20;

    // A setup that points against the day's structure is worth less, however
    // clean its own rules look.
    const leading = detections[0];
    if (leading && leading.bias !== 'neutral' && profile.trend !== 'neutral' && profile.trend !== 'choppy') {
      if (leading.bias === profile.trend) {
        score += 8;
        evidence.push(`${leading.strategyName} points ${leading.bias}, with the session structure`);
      } else {
        score -= 18;
        evidence.push(`${leading.strategyName} points ${leading.bias} against a ${profile.trend} session structure`);
      }
    }

    return factor('trend_profile_alignment', 'Trend & Profile Alignment', clamp(score), this.weight('trend_profile_alignment'), evidence);
  }

  // 2 ------------------------------------------------------------------
  private strategyRulesMatch({ detections }: ConfidenceInput): ConfidenceFactor {
    const weight = this.weight('strategy_rules_match');
    if (detections.length === 0) {
      return factor('strategy_rules_match', 'Strategy Rules Match', 0, weight, [
        'No configured strategy has any rule confirming right now',
      ]);
    }

    const best = detections[0];
    const evidence = [
      `${best.strategyName}: ${best.rulesMatched.length}/${best.rulesMatched.length + best.rulesUnmet.length} rules confirmed`,
      ...best.rulesMatched,
    ];
    if (best.rulesUnmet.length > 0) evidence.push(`Still unmet — ${best.rulesUnmet.join('; ')}`);
    if (best.invalidationsTriggered.length > 0) {
      evidence.push(`Invalidation triggered — ${best.invalidationsTriggered.join('; ')}`);
    }
    if (detections.length > 1) {
      const others = detections.slice(1).filter((d) => d.validated);
      if (others.length > 0) {
        evidence.push(`Corroborated by ${others.map((d) => d.strategyName).join(', ')}`);
      }
    }

    // A second independent validated setup is genuine corroboration; cap the
    // bonus so a long strategy list can never manufacture confidence.
    const corroboration = Math.min(10, Math.max(0, detections.filter((d) => d.validated).length - 1) * 5);
    return factor('strategy_rules_match', 'Strategy Rules Match', clamp(best.confidence + corroboration), weight, evidence);
  }

  // 3 ------------------------------------------------------------------
  private volumeLiquiditySupport({ snapshot }: ConfidenceInput): ConfidenceFactor {
    const weight = this.weight('volume_liquidity_support');
    const evidence: string[] = [];
    let score = 50;

    if (snapshot.volumeVsAvg === null) {
      evidence.push('No volume baseline available');
      score = 45;
    } else {
      const pct = (snapshot.volumeVsAvg * 100).toFixed(0);
      if (snapshot.volumeVsAvg >= 1.4) {
        score = 90;
        evidence.push(`Volume at ${pct}% of the 20-bar average — participation is confirming`);
      } else if (snapshot.volumeVsAvg >= 1.0) {
        score = 72;
        evidence.push(`Volume at ${pct}% of the 20-bar average`);
      } else if (snapshot.volumeVsAvg >= 0.7) {
        score = 48;
        evidence.push(`Volume at ${pct}% of the 20-bar average — thin`);
      } else {
        score = 25;
        evidence.push(`Volume at ${pct}% of the 20-bar average — participation is absent`);
      }
    }

    if (snapshot.breadthRatio !== null) {
      if (snapshot.breadthRatio > 1.5) {
        score += 8;
        evidence.push(`Advance/decline ratio ${snapshot.breadthRatio.toFixed(2)} — broad support`);
      } else if (snapshot.breadthRatio < 0.8) {
        score -= 12;
        evidence.push(`Advance/decline ratio ${snapshot.breadthRatio.toFixed(2)} — breadth is not confirming`);
      }
    }

    return factor('volume_liquidity_support', 'Volume & Liquidity Support', clamp(score), weight, evidence);
  }

  // 4 ------------------------------------------------------------------
  private newsEnvironmentAlignment({ signals }: ConfidenceInput): ConfidenceFactor {
    const weight = this.weight('news_environment_alignment');
    const news = signals.find((s) => s.name === 'news_driven_volatility');
    if (!news) {
      return factor('news_environment_alignment', 'News Environment Alignment', 50, weight, [
        'News intelligence did not report for this symbol',
      ]);
    }
    // A quiet tape is what a technical setup wants; live high-impact flow can
    // override any amount of structure, so it caps this factor low.
    const score = news.triggered ? 32 : 80;
    return factor('news_environment_alignment', 'News Environment Alignment', score, weight, news.evidence);
  }

  // 5 ------------------------------------------------------------------
  private optionChainSupport({ snapshot, detections }: ConfidenceInput): ConfidenceFactor {
    const weight = this.weight('option_chain_pcr_support');
    const oc = snapshot.optionChain;
    if (!oc) {
      return factor('option_chain_pcr_support', 'Option Chain & PCR Support', 50, weight, [
        'No option chain published for this instrument — factor held neutral',
      ]);
    }

    const evidence: string[] = [
      `Put-Call OI ratio ${oc.pcr.toFixed(2)} across ${oc.strikesAnalysed} front-expiry strikes`,
      `Max pain ${oc.maxPain.toFixed(0)} vs spot ${snapshot.lastPrice.toFixed(1)}`,
    ];
    let score = 55;

    const bias = detections[0]?.bias ?? snapshot.trendAnalysis?.direction ?? 'neutral';
    // PCR above 1 means put writers dominate — supportive of upside, and the
    // reverse below 1. Aligned positioning corroborates; opposed positioning
    // is a headwind.
    if (bias === 'bullish') {
      score += oc.pcr >= 1 ? 22 : -18;
      evidence.push(oc.pcr >= 1 ? 'Put-weighted positioning corroborates the bullish side' : 'Call-weighted positioning sits against the bullish side');
    } else if (bias === 'bearish') {
      score += oc.pcr <= 1 ? 22 : -18;
      evidence.push(oc.pcr <= 1 ? 'Call-weighted positioning corroborates the bearish side' : 'Put-weighted positioning sits against the bearish side');
    }

    if (snapshot.lastPrice > 0) {
      const pinDistPct = Math.abs(snapshot.lastPrice - oc.maxPain) / snapshot.lastPrice;
      if (pinDistPct < 0.003) {
        score -= 15;
        evidence.push(`Spot is pinned to max pain (${(pinDistPct * 100).toFixed(2)}% away) — directional follow-through is historically suppressed here`);
      }
    }

    if (oc.callOIWall !== null && bias === 'bullish' && oc.callOIWall > snapshot.lastPrice) {
      evidence.push(`Nearest call OI wall overhead at ${oc.callOIWall.toFixed(0)}`);
    }
    if (oc.putOIWall !== null && bias === 'bearish' && oc.putOIWall < snapshot.lastPrice) {
      evidence.push(`Nearest put OI wall below at ${oc.putOIWall.toFixed(0)}`);
    }

    return factor('option_chain_pcr_support', 'Option Chain & PCR Support', clamp(score), weight, evidence);
  }

  // 6 ------------------------------------------------------------------
  private historicalSimilarityMatch({ historical }: ConfidenceInput): ConfidenceFactor {
    const weight = this.weight('historical_similarity_match');
    if (!historical || historical.occurrences === 0) {
      return factor('historical_similarity_match', 'Historical Similarity Match', 50, weight, [
        'No prior recorded occurrences of this pattern on this symbol — held neutral rather than treated as confirmation',
      ]);
    }
    if (historical.sampleTooSmall) {
      return factor('historical_similarity_match', 'Historical Similarity Match', 45, weight, [
        `${historical.occurrences} prior occurrence(s) recorded but only ${historical.withKnownOutcome} with a known outcome — too few to score`,
      ]);
    }

    const total = Object.values(historical.outcomeCounts).reduce((a, b) => a + b, 0) || 1;
    const ranked = Object.entries(historical.outcomeCounts).sort((a, b) => b[1] - a[1]);
    const [topOutcome, topCount] = ranked[0];
    const share = topCount / total;
    const unclearShare = (historical.outcomeCounts.unclear ?? 0) / total;

    // A dominant *directional* outcome is signal; a dominant "unclear" is the
    // opposite, and must not be read as an 83%-style success rate.
    const score = topOutcome === 'unclear' ? clamp(50 - share * 40) : clamp(share * 100 - unclearShare * 25);

    return factor('historical_similarity_match', 'Historical Similarity Match', score, weight, [
      `${historical.occurrences} prior occurrences on this symbol, ${historical.withKnownOutcome} with a known outcome`,
      `Most frequent outcome: ${topOutcome.replace(/_/g, ' ')} at ${Math.round(share * 100)}%`,
      'Historical frequency, not a prediction for this instance',
    ]);
  }

  // 7 ------------------------------------------------------------------
  private riskEngineScore({ risk }: ConfidenceInput): ConfidenceFactor {
    const weight = this.weight('risk_engine_score');
    const evidence = [`Aggregate risk ${risk.overallRisk}/100 (${risk.level.replace(/_/g, ' ')})`];
    const worst = [...risk.factors].sort((a, b) => b.score - a.score).slice(0, 3);
    for (const f of worst) {
      evidence.push(`${f.name.replace(/_/g, ' ')} ${f.score}/100 — ${f.evidence[0] ?? 'no detail'}`);
    }
    // Confidence is the inverse of risk: a 20/100 risk read is an 80/100
    // confidence contribution.
    return factor('risk_engine_score', 'Risk Engine Score', clamp(100 - risk.overallRisk), weight, evidence);
  }

  // ------------------------------------------------------------ deductions
  private deductions({ snapshot, detections, risk }: ConfidenceInput, at: Date): ConfidenceDeduction[] {
    const out: ConfidenceDeduction[] = [];
    const bias = detections[0]?.bias ?? 'neutral';

    // Overhead/underfoot structure directly in the path of the setup.
    if (bias === 'bullish' && snapshot.resistance !== null && snapshot.lastPrice > 0) {
      const distPct = ((snapshot.resistance - snapshot.lastPrice) / snapshot.lastPrice) * 100;
      if (distPct > 0 && distPct < 0.5) {
        out.push({ reason: `Resistance overhead at ${snapshot.resistance.toFixed(1)}, ${distPct.toFixed(2)}% away`, points: 3.5 });
      }
    }
    if (bias === 'bearish' && snapshot.support !== null && snapshot.lastPrice > 0) {
      const distPct = ((snapshot.lastPrice - snapshot.support) / snapshot.lastPrice) * 100;
      if (distPct > 0 && distPct < 0.5) {
        out.push({ reason: `Support underfoot at ${snapshot.support.toFixed(1)}, ${distPct.toFixed(2)}% away`, points: 3.5 });
      }
    }

    if (snapshot.vix !== null && snapshot.vix > 20) {
      out.push({ reason: `India VIX at ${snapshot.vix.toFixed(1)} — elevated volatility widens the outcome range`, points: 5 });
    }

    const extremeRisk = risk.factors.filter((f) => f.score > 80);
    if (extremeRisk.length > 0) {
      out.push({
        reason: `${extremeRisk.length} risk factor(s) in the extreme band: ${extremeRisk.map((f) => f.name.replace(/_/g, ' ')).join(', ')}`,
        points: extremeRisk.length * 3,
      });
    }

    const mins = istMinutesOfDay(at);
    const remaining = minutesToClose(at);
    if (mins >= SQUARE_OFF_MIN && remaining >= 0) {
      out.push({ reason: `${istTimeLabel(at)} IST — inside the intraday square-off window`, points: 5 });
    }

    const invalidated = detections.filter((d) => d.invalidationsTriggered.length > 0);
    if (invalidated.length > 0) {
      out.push({
        reason: `Invalidation triggered on ${invalidated.map((d) => d.strategyName).join(', ')}`,
        points: 8,
      });
    }

    return out;
  }

  // ---------------------------------------------------- Module 12 hook
  /**
   * Apply recalibrated factor weights. Values are normalised so the weights
   * always sum to 1 — otherwise a recalibration pass could silently inflate
   * or deflate every score at once.
   */
  recalibrate(weights: Partial<Record<ConfidenceFactorName, number>>): Record<ConfidenceFactorName, number> {
    const merged = { ...CONFIDENCE_WEIGHTS, ...weights } as Record<ConfidenceFactorName, number>;
    const total = Object.values(merged).reduce((a, b) => a + b, 0);
    if (total <= 0) return { ...CONFIDENCE_WEIGHTS };
    const normalised = Object.fromEntries(
      Object.entries(merged).map(([k, v]) => [k, v / total]),
    ) as Record<ConfidenceFactorName, number>;
    this.weightOverrides = normalised;
    return normalised;
  }

  /** Weights currently in force, defaults plus any recalibration. */
  activeWeights(): Record<ConfidenceFactorName, number> {
    return { ...CONFIDENCE_WEIGHTS, ...this.weightOverrides };
  }
}

function factor(
  name: string,
  label: string,
  score: number,
  weight: number,
  evidence: string[],
): ConfidenceFactor {
  return { name, label, score: Math.round(score), weight, evidence };
}
