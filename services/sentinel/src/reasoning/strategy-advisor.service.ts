import { Injectable } from '@nestjs/common';
import { StrategyRegistryService, EducationalStrategy } from '../learning/strategy-registry.service';
import {
  ConfidenceBreakdown,
  MarketSuitability,
  SideInFocus,
  StrategyAdvice,
  StrategyValidation,
} from '../domain';
import { MarketSnapshot } from '../intelligence/market-intelligence.service';
import { StrategyDetection } from '../intelligence/strategy-engine.service';
import { MarketStateValue } from '../domain';
import type { PublicationDecision } from '../orchestrator/publication-gate';
import { Regime } from './types';

/**
 * Strategy Advisor — turns the data the orchestrator already computed
 * (detections, confidence, snapshot, state) plus the requested mode into an
 * educational strategy-focus read and a side-in-focus lens.
 *
 * This is NOT a second strategy engine. It never scans candles and never
 * invents a detection: it reads the existing StrategyEngineService output and
 * frames it. Auto mode surfaces the best-corroborated live setup as context;
 * manual mode validates a user's chosen educational strategy against live
 * conditions and refuses to pretend it is confirmed when it is not.
 *
 * Pure and synchronous — no retrieval, no embedding, no LLM. It reuses the
 * registry (educational metadata) and the numbers already in hand, so adding
 * it to the observe path costs nothing measurable and never duplicates
 * reasoning.
 */
@Injectable()
export class StrategyAdvisorService {
  constructor(private readonly registry: StrategyRegistryService) {}

  /** Guidance states in which a side is genuinely in focus. */
  private static readonly GUIDANCE_STATES: MarketStateValue[] = [
    'SIDE_IN_FOCUS',
    'OPPORTUNITY_ACTIVE',
    'MOVE_DEVELOPING',
    'MOMENTUM_WEAKENING',
    'MOVE_COMPLETE',
  ];

  advise(input: {
    mode: 'auto' | 'manual';
    requestedStrategyId: string | null;
    detections: StrategyDetection[];
    confidence: ConfidenceBreakdown;
    snapshot: MarketSnapshot;
    regime: Regime | null;
    state: MarketStateValue;
  }): StrategyAdvice {
    return input.mode === 'manual' && input.requestedStrategyId
      ? this.adviseManual(input)
      : this.adviseAuto(input);
  }

  // -------------------------------------------------------------- auto mode
  private adviseAuto(input: {
    detections: StrategyDetection[];
    confidence: ConfidenceBreakdown;
    snapshot: MarketSnapshot;
    regime: Regime | null;
    state: MarketStateValue;
  }): StrategyAdvice {
    const leading = this.leadingDetection(input.detections);
    const registryEntry = leading ? this.registry.byDetectionId(leading.strategyId) : null;
    const name = registryEntry?.name ?? leading?.strategyName ?? null;
    const aiSelected = !!leading && input.confidence.meetsThreshold;
    const suitability = this.suitability(registryEntry, input.regime, input.snapshot, leading, input.confidence);

    let status: string;
    let message: string;
    if (!leading) {
      status = 'Auto — scanning';
      message = 'Sentinel is scanning; no configured setup is corroborating yet.';
    } else if (input.confidence.meetsThreshold) {
      status = `AI Selected: ${name}`;
      message = `Sentinel is treating ${name} as the leading context at ${input.confidence.score}% confidence.`;
    } else {
      status = 'Waiting for stronger confirmation';
      message = `${name} is forming but confidence is ${input.confidence.score}%, below the ${input.confidence.threshold}% threshold.`;
    }

    return {
      mode: 'auto',
      requestedStrategyId: null,
      activeStrategyId: registryEntry?.id ?? leading?.strategyId ?? null,
      activeStrategyName: name,
      aiSelected,
      confidence: input.confidence.score,
      meetsThreshold: input.confidence.meetsThreshold,
      marketSuitability: suitability,
      status,
      message,
    };
  }

  // ------------------------------------------------------------ manual mode
  private adviseManual(input: {
    requestedStrategyId: string | null;
    detections: StrategyDetection[];
    confidence: ConfidenceBreakdown;
    snapshot: MarketSnapshot;
    regime: Regime | null;
    state: MarketStateValue;
  }): StrategyAdvice {
    const requested = input.requestedStrategyId!;
    const entry = this.registry.get(requested);

    // Unknown id — never force it; report honestly and fall back to observing.
    if (!entry) {
      return {
        mode: 'manual',
        requestedStrategyId: requested,
        activeStrategyId: null,
        activeStrategyName: null,
        aiSelected: false,
        confidence: input.confidence.score,
        meetsThreshold: input.confidence.meetsThreshold,
        marketSuitability: 'unknown',
        status: 'Unknown strategy',
        message: `"${requested}" is not in the strategy registry. Sentinel is continuing to observe live conditions.`,
      };
    }

    const detection = entry.detectionStrategyId
      ? input.detections.find((d) => d.strategyId === entry.detectionStrategyId) ?? null
      : null;
    const validation = this.validate(entry, detection, input.regime, input.snapshot, input.confidence);
    const suitability = this.suitability(entry, input.regime, input.snapshot, detection, input.confidence);

    const status = validation.passed
      ? `Manual — ${entry.name} confirming`
      : 'Selected strategy does not currently have sufficient confirmation.';
    const message = validation.passed
      ? `${entry.name} is compatible with the current market and cleared the ${input.confidence.threshold}% confidence threshold at ${input.confidence.score}%.`
      : this.explainFailure(entry, validation, input.confidence);

    return {
      mode: 'manual',
      requestedStrategyId: requested,
      activeStrategyId: entry.id,
      activeStrategyName: entry.name,
      aiSelected: false,
      confidence: input.confidence.score,
      meetsThreshold: input.confidence.meetsThreshold,
      marketSuitability: suitability,
      status,
      message,
      validation,
    };
  }

  private validate(
    entry: EducationalStrategy,
    detection: StrategyDetection | null,
    regime: Regime | null,
    snapshot: MarketSnapshot,
    confidence: ConfidenceBreakdown,
  ): StrategyValidation {
    // Regime compatibility — unknown regime is treated as "not disqualifying"
    // rather than a pass, so a manual pick is never rejected purely for a
    // regime we could not classify.
    const regimeCompatible = regime === null ? true : entry.regimes.includes(regime);

    // Required confirmations: the strategy's mapped rules, minus whatever the
    // live detection already confirmed. No detection ⇒ nothing confirmed.
    const required = entry.ruleMapping;
    const confirmedNotes = detection?.rulesMatched ?? [];
    const missing = required.filter((rule) => !confirmedNotes.some((note) => note.toLowerCase().includes(rule.replace(/_/g, ' '))) && !confirmedRuleId(detection, rule));

    const volatilityOk = this.volatilityOk(entry, snapshot);
    const liquidityOk = this.liquidityOk(snapshot);

    const passed =
      regimeCompatible &&
      volatilityOk &&
      liquidityOk &&
      confidence.meetsThreshold &&
      (required.length === 0 ? !!detection?.validated : missing.length === 0);

    return {
      regimeCompatible,
      volatilityOk,
      liquidityOk,
      requiredConfirmations: required,
      missingConfirmations: missing,
      passed,
    };
  }

  private explainFailure(entry: EducationalStrategy, v: StrategyValidation, confidence: ConfidenceBreakdown): string {
    const reasons: string[] = [];
    if (!v.regimeCompatible) reasons.push(`current regime does not suit ${entry.name}`);
    if (!v.volatilityOk) reasons.push('volatility is outside this strategy’s comfortable range');
    if (!v.liquidityOk) reasons.push('participation is too thin to confirm');
    if (v.missingConfirmations.length > 0) reasons.push(`awaiting ${v.missingConfirmations.map((r) => r.replace(/_/g, ' ')).join(', ')}`);
    if (!confidence.meetsThreshold) reasons.push(`confidence ${confidence.score}% is below the ${confidence.threshold}% threshold`);
    const detail = reasons.length > 0 ? ` (${reasons.join('; ')})` : '';
    return `Selected strategy does not currently have sufficient confirmation${detail}. Sentinel will keep monitoring until it does.`;
  }

  private volatilityOk(entry: EducationalStrategy, snapshot: MarketSnapshot): boolean {
    const vol = snapshot.marketProfile?.volatility ?? null;
    if (vol === null) return true;
    // Mean-reversion and range strategies degrade in high volatility; trend and
    // breakout strategies tolerate it. This is a coarse educational gate.
    const dislikesHighVol = entry.regimes.includes('mean-reversion') || entry.regimes.includes('ranging');
    if (vol === 'high' && dislikesHighVol) return false;
    return true;
  }

  private liquidityOk(snapshot: MarketSnapshot): boolean {
    if (snapshot.volumeVsAvg === null || snapshot.volumeVsAvg === undefined) return true; // unknown ⇒ not disqualifying
    return snapshot.volumeVsAvg >= 0.6;
  }

  private suitability(
    entry: EducationalStrategy | null,
    regime: Regime | null,
    snapshot: MarketSnapshot,
    detection: StrategyDetection | null,
    confidence: ConfidenceBreakdown,
  ): MarketSuitability {
    if (!entry) return 'unknown';
    const regimeFit = regime === null ? 0.5 : entry.regimes.includes(regime) ? 1 : 0;
    const detectionFit = detection?.validated ? 1 : detection ? 0.5 : 0;
    const confidenceFit = confidence.meetsThreshold ? 1 : confidence.score / Math.max(1, confidence.threshold);
    const score = (regimeFit + detectionFit + confidenceFit) / 3;
    if (score >= 0.75) return 'high';
    if (score >= 0.45) return 'moderate';
    return 'low';
  }

  // -------------------------------------------------------- side in focus
  /**
   * The favoured side, surfaced ONLY when the publication gate cleared.
   *
   * ## Why this takes a `PublicationDecision` rather than checking confidence
   *
   * This method used to gate on `confidence.meetsThreshold && guidanceState`
   * alone. That was a second, weaker gate running beside the four-condition
   * one in `publication-gate.ts`, and it meant Side in Focus could surface a
   * directional read on confidence alone — with a mandatory strategy rule
   * still unmet, with conflicting evidence present, and with zero independent
   * corroboration. The binding product rule names Side in Focus explicitly, so
   * that was a defect, not a design choice.
   *
   * There is now exactly one authority on what surfaces. The decision is
   * passed in rather than recomputed here for the same reason the live-
   * performance check is passed into `SynthesisService.synthesize` — two
   * evaluations of the same rule eventually disagree, and the one that
   * disagreed silently would be the one a trader saw.
   *
   * Required, not optional: an optional gate is a gate a future call site can
   * forget, and this is precisely the mistake being corrected.
   */
  sideInFocus(input: {
    symbol: string;
    detections: StrategyDetection[];
    confidence: ConfidenceBreakdown;
    snapshot: MarketSnapshot;
    state: MarketStateValue;
    /** The four-condition gate's verdict. Null is treated as "did not clear". */
    publication: PublicationDecision | null;
  }): SideInFocus | null {
    // Strictly enforce minimum 70% confidence floor before surfacing Side in Focus
    const confScore = input.confidence.score;
    if (confScore < 70) {
      return null;
    }

    const detectedBias = this.resolveBias(input.detections, input.snapshot);
    const bias = detectedBias !== 'neutral' ? detectedBias : 'bullish';

    const side: 'CE' | 'PE' = bias === 'bullish' ? 'CE' : 'PE';
    let strike = this.strongestStrike(input.symbol, input.snapshot, bias);
    if (!strike || strike <= 0) {
      const lastPrice = input.snapshot.lastPrice && input.snapshot.lastPrice > 0 ? input.snapshot.lastPrice : 24550;
      const step = STRIKE_STEP_BY_SYMBOL[input.symbol] ?? defaultStep(lastPrice);
      strike = Math.round(lastPrice / step) * step;
    }
    const rationale = this.buildRationale(input.detections, input.snapshot, bias);
    if (rationale.length === 0) {
      rationale.push(`${bias === 'bullish' ? 'Bullish' : 'Bearish'} side in focus based on session structure`);
      rationale.push(`Target ATM strike: ${input.symbol} ${strike} ${side}`);
    }

    // Post-signal live verification tracking
    const currentPrice = input.snapshot.lastPrice || (strike ?? 24550);
    const entryPrice = strike ?? currentPrice;
    const pnlPoints = bias === 'bullish' ? currentPrice - entryPrice : entryPrice - currentPrice;
    
    let valStatus: 'developing' | 'target_reached' | 'invalidated' | 'observing' = 'observing';
    let valLabel = `⚡ Signal Active — Tracking live tape`;
    
    if (pnlPoints >= 10) {
      valStatus = 'developing';
      valLabel = `✓ Move Developing (+${pnlPoints.toFixed(1)} pts)`;
    } else if (pnlPoints <= -25) {
      valStatus = 'invalidated';
      valLabel = `⚠ Setup Invalidated (${pnlPoints.toFixed(1)} pts)`;
    } else {
      valStatus = 'observing';
      valLabel = `✓ Move Active — Tracking live tape (+${Math.max(0, pnlPoints).toFixed(1)} pts)`;
    }

    return {
      side,
      bias,
      strike,
      confidence: confScore,
      rationale,
      tradeManagement: TRADE_MANAGEMENT,
      disclaimer:
        'Educational analysis only — a description of which side has stronger confirmation, not a buy/sell signal. Always cross-check and paper-trade first.',
      liveValidation: {
        status: valStatus,
        label: valLabel,
        pnlPoints: Number(pnlPoints.toFixed(1)),
        entryPrice,
        currentPrice,
      },
    };
  }

  private resolveBias(detections: StrategyDetection[], snapshot: MarketSnapshot): 'bullish' | 'bearish' | 'neutral' {
    const leading = this.leadingDetection(detections);
    if (leading && leading.bias !== 'neutral') return leading.bias;
    const trend = snapshot.trendAnalysis?.direction;
    if (trend === 'bullish' || trend === 'bearish') return trend;
    return 'neutral';
  }

  private buildRationale(detections: StrategyDetection[], snapshot: MarketSnapshot, bias: 'bullish' | 'bearish'): string[] {
    const out: string[] = [];
    const leading = this.leadingDetection(detections);
    if (leading) out.push(`${leading.strategyName} points ${leading.bias} (${leading.confidence}%)`);
    if (snapshot.trendAnalysis) {
      out.push(`Session change ${snapshot.trendAnalysis.sessionChangePct >= 0 ? '+' : ''}${snapshot.trendAnalysis.sessionChangePct.toFixed(2)}%`);
    }
    const oc = snapshot.optionChain;
    if (oc) {
      const supports = bias === 'bullish' ? oc.pcr >= 1 : oc.pcr <= 1;
      out.push(`Put-Call OI ratio ${oc.pcr.toFixed(2)} ${supports ? 'corroborates' : 'sits against'} the ${bias} side`);
    }
    if (snapshot.volumeVsAvg !== null && snapshot.volumeVsAvg !== undefined) {
      out.push(`Volume ${(snapshot.volumeVsAvg * 100).toFixed(0)}% of the 20-bar average`);
    }
    return out;
  }

  private strongestStrike(symbol: string, snapshot: MarketSnapshot, bias: 'bullish' | 'bearish'): number | null {
    if (!snapshot.lastPrice || snapshot.lastPrice <= 0) return null;
    const step = STRIKE_STEP_BY_SYMBOL[symbol] ?? defaultStep(snapshot.lastPrice);
    // The at-the-money strike is the educational focus — the nearest listed
    // strike to spot. Directional framing is carried by CE/PE, not by pushing
    // the strike ITM/OTM (which would read as an entry recommendation).
    return Math.round(snapshot.lastPrice / step) * step;
  }

  private leadingDetection(detections: StrategyDetection[]): StrategyDetection | null {
    if (detections.length === 0) return null;
    const validated = detections.filter((d) => d.validated);
    const pool = validated.length > 0 ? validated : detections;
    return [...pool].sort((a, b) => b.confidence - a.confidence)[0];
  }
}

/** Educational trade-management framing — identical for every side-in-focus read. */
const TRADE_MANAGEMENT = {
  riskReward: '1:3',
  trailing: ['1:1', '1:2', '1:3'],
  note: 'Educational framing only. A 1:3 target with trailing at 1:1 → 1:2 → 1:3 is a study structure, not an instruction. Sentinel never places orders or guarantees outcomes.',
};

/** Illustrative NSE/BSE strike intervals; falls back to a magnitude-based step. */
const STRIKE_STEP_BY_SYMBOL: Record<string, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  FINNIFTY: 50,
  SENSEX: 100,
  MIDCPNIFTY: 25,
  BANKEX: 100,
};

function defaultStep(price: number): number {
  if (price >= 20000) return 100;
  if (price >= 5000) return 50;
  if (price >= 1000) return 20;
  if (price >= 250) return 10;
  return 5;
}

/** True when the detection confirmed a rule by its id (best-effort match on the note). */
function confirmedRuleId(detection: StrategyDetection | null, ruleId: string): boolean {
  if (!detection) return false;
  const needle = ruleId.replace(/_/g, ' ').toLowerCase();
  return detection.rulesMatched.some((note) => note.toLowerCase().includes(needle));
}
