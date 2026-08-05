import { describe, expect, it } from 'vitest';
import type { ConfidenceBreakdown, MarketProfile, ObserveResponse } from '../domain';
import type { HistoricalSimilarityResult } from '../brain/historical-similarity.service';
import type { StrategyDetection } from '../intelligence/strategy-engine.service';
import {
  MIN_CORROBORATING_SOURCES,
  PUBLICATION_CONFIDENCE_THRESHOLD,
  evaluatePublication,
  resolveThreshold,
  type BehaviourGateInput,
} from './publication-gate';

/**
 * The publication gate is the single most important behavioural guarantee in
 * the orchestrator: it decides what reaches a trader. These tests construct
 * it with plain objects and no infrastructure, which is the whole reason the
 * gate is a pure function taking resolved inputs.
 */

function confidence(score: number, threshold = PUBLICATION_CONFIDENCE_THRESHOLD): ConfidenceBreakdown {
  return {
    score,
    weightedScore: score,
    threshold,
    meetsThreshold: score >= threshold,
    factors: [
      { name: 'strategy_rules_match', label: 'Strategy Rules Match', score, weight: 0.2, evidence: [] },
      { name: 'risk_engine_score', label: 'Risk Engine Score', score, weight: 0.2, evidence: [] },
    ],
    deductions: [],
    computedAt: new Date('2026-08-06T04:30:00Z').toISOString(),
  };
}

function detection(over: Partial<StrategyDetection> = {}): StrategyDetection {
  return {
    strategyId: 'orb-retest',
    strategyName: 'Opening Range Breakout Retest',
    bias: 'bullish',
    confidence: 88,
    rulesMatched: ['ORB breakout confirmed', 'Retest touched the boundary', 'Retest volume lower'],
    rulesUnmet: [],
    invalidationsTriggered: [],
    validated: true,
    source: 'built-in',
    ...over,
  } as StrategyDetection;
}

const bullishProfile: MarketProfile = {
  type: 'Bullish Trend Day',
  trend: 'bullish',
  description: 'higher highs and higher lows through the session',
} as MarketProfile;

const bearishProfile: MarketProfile = {
  type: 'Bearish Trend Day',
  trend: 'bearish',
  description: 'lower highs and lower lows through the session',
} as MarketProfile;

function historical(over: Partial<HistoricalSimilarityResult> = {}): HistoricalSimilarityResult {
  return {
    patternName: 'orb_retest',
    symbol: 'NIFTY',
    occurrences: 20,
    withKnownOutcome: 12,
    outcomeCounts: { followed_through: 9, failed: 3 },
    sampleTooSmall: false,
    ...over,
  };
}

function agreeingCrossValidation(): ObserveResponse['crossValidation'] {
  return {
    surfaced: true,
    agreesWithConclusion: true,
    citations: [],
    supportingConcepts: [],
    corroboratingAgents: 3,
    silenceReason: null,
  };
}

/** The happy path: everything corroborates. */
function publishableInput() {
  return {
    state: 'SIDE_IN_FOCUS' as const,
    confidence: confidence(82),
    detections: [detection()],
    marketProfile: bullishProfile,
    historical: historical(),
    crossValidation: agreeingCrossValidation(),
  };
}

describe('resolveThreshold', () => {
  it('defaults to the canonical publication threshold', () => {
    expect(resolveThreshold(undefined)).toBe(PUBLICATION_CONFIDENCE_THRESHOLD);
  });

  it('lets a trader raise the bar', () => {
    expect(resolveThreshold(90)).toBe(90);
  });

  it('never lets a request lower the bar below the canonical threshold', () => {
    // Otherwise any caller could opt out of the publication rule by asking.
    expect(resolveThreshold(10)).toBe(PUBLICATION_CONFIDENCE_THRESHOLD);
    expect(resolveThreshold(0)).toBe(PUBLICATION_CONFIDENCE_THRESHOLD);
    expect(resolveThreshold(-50)).toBe(PUBLICATION_CONFIDENCE_THRESHOLD);
  });

  it('ignores a malformed threshold rather than trusting it', () => {
    expect(resolveThreshold(Number.NaN)).toBe(PUBLICATION_CONFIDENCE_THRESHOLD);
    expect(resolveThreshold(Number.POSITIVE_INFINITY)).toBe(PUBLICATION_CONFIDENCE_THRESHOLD);
  });
});

describe('evaluatePublication — the four conditions', () => {
  it('publishes when all four conditions hold', () => {
    const decision = evaluatePublication(publishableInput());
    expect(decision.publish).toBe(true);
    expect(decision.waitAndWatchReason).toBeNull();
    expect(decision.conditions.every((c) => c.passed)).toBe(true);
  });

  it('records every condition it checked, passed or not', () => {
    // "Why?" must be able to show what was evaluated, not only what failed.
    const decision = evaluatePublication(publishableInput());
    expect(decision.conditions.map((c) => c.id)).toEqual([
      'state-permits-guidance',
      'adaptive-confidence',
      'mandatory-confirmations',
      'no-conflicting-evidence',
      'corroboration',
    ]);
  });

  it('holds back a read below the confidence threshold', () => {
    const decision = evaluatePublication({ ...publishableInput(), confidence: confidence(69.9) });
    expect(decision.publish).toBe(false);
    expect(decision.waitAndWatchReason).toContain('below the 70% publication threshold');
    expect(decision.waitAndWatchReason).toContain('Wait and Watch');
  });

  it('publishes at exactly the threshold — the bar is inclusive', () => {
    const decision = evaluatePublication({ ...publishableInput(), confidence: confidence(70) });
    expect(decision.publish).toBe(true);
  });

  it('never publishes on confidence alone when a mandatory rule is unmet', () => {
    // The core of the rule: a 95% score cannot buy its way past a forming setup.
    const decision = evaluatePublication({
      ...publishableInput(),
      confidence: confidence(95),
      detections: [detection({ validated: false, rulesUnmet: ['Retest volume lower'] })],
    });
    expect(decision.publish).toBe(false);
    expect(decision.waitAndWatchReason).toContain('Retest volume lower');
    expect(decision.waitAndWatchReason).toContain('Every mandatory confirmation must validate');
  });

  it('never publishes when an invalidation has triggered', () => {
    const decision = evaluatePublication({
      ...publishableInput(),
      confidence: confidence(95),
      detections: [detection({ validated: false, invalidationsTriggered: ['Bar closed back inside the ORB range'] })],
    });
    expect(decision.publish).toBe(false);
    expect(decision.waitAndWatchReason).toContain('invalidation');
  });

  it('holds back when the setup points against the session structure', () => {
    const decision = evaluatePublication({ ...publishableInput(), marketProfile: bearishProfile });
    expect(decision.publish).toBe(false);
    expect(decision.conflicts[0]).toContain('points bullish against a bearish session structure');
  });

  it('holds back when the second engine surfaced a disagreeing verdict', () => {
    const decision = evaluatePublication({
      ...publishableInput(),
      crossValidation: { ...agreeingCrossValidation()!, agreesWithConclusion: false },
    });
    expect(decision.publish).toBe(false);
    expect(decision.conflicts.join(' ')).toContain('does not agree');
  });

  it('does NOT treat second-engine silence as disagreement', () => {
    // Engine 2's background coverage is deliberately sparse. Treating its
    // silence as a conflict would make Engine 1 hostage to that coverage gap.
    const decision = evaluatePublication({ ...publishableInput(), crossValidation: null });
    expect(decision.conflicts).toEqual([]);
    // Structure + history still corroborate, so this still publishes.
    expect(decision.publish).toBe(true);
  });

  it('requires two independent corroborating sources, not one', () => {
    const decision = evaluatePublication({
      ...publishableInput(),
      marketProfile: null, // no structural corroboration
      crossValidation: null, // no second-engine corroboration
      historical: historical(), // leaves exactly one source
    });
    expect(decision.corroboratingSources).toHaveLength(1);
    expect(decision.publish).toBe(false);
    expect(decision.waitAndWatchReason).toContain('A single source is not corroboration');
  });

  it('does not count the leading detection as its own corroboration', () => {
    // The claim under test must not be able to satisfy the requirement.
    const decision = evaluatePublication({
      ...publishableInput(),
      marketProfile: null,
      crossValidation: null,
      historical: null,
    });
    expect(decision.corroboratingSources).toEqual([]);
    expect(decision.publish).toBe(false);
  });

  it('does not count a historical sample too small to mean anything', () => {
    const decision = evaluatePublication({
      ...publishableInput(),
      marketProfile: null,
      crossValidation: null,
      historical: historical({ sampleTooSmall: true, withKnownOutcome: 2 }),
    });
    expect(decision.corroboratingSources).toEqual([]);
    expect(decision.publish).toBe(false);
  });

  it('holds back when no strategy is detecting at all', () => {
    const decision = evaluatePublication({ ...publishableInput(), detections: [] });
    expect(decision.publish).toBe(false);
    expect(decision.waitAndWatchReason).toContain('No strategy is currently detecting');
  });

  it('holds back in a state where guidance is not meaningful', () => {
    const decision = evaluatePublication({ ...publishableInput(), state: 'OBSERVATION' });
    expect(decision.publish).toBe(false);
    expect(decision.waitAndWatchReason).toContain('no setup has reached a guidance state');
  });

  it('names the binding constraint, not merely the first failure it could find', () => {
    // Confidence is fine here; the missing confirmation is the real reason.
    const decision = evaluatePublication({
      ...publishableInput(),
      confidence: confidence(91),
      detections: [detection({ validated: false, rulesUnmet: ['Retest touched the boundary'] })],
    });
    expect(decision.waitAndWatchReason).not.toContain('below the');
    expect(decision.waitAndWatchReason).toContain('Retest touched the boundary');
  });

  it('always explains itself — every condition carries readable evidence', () => {
    const decision = evaluatePublication(publishableInput());
    for (const condition of decision.conditions) {
      expect(condition.detail.length).toBeGreaterThan(0);
      expect(condition.label.length).toBeGreaterThan(0);
    }
  });

  it('honours a raised threshold from the request', () => {
    const decision = evaluatePublication({
      ...publishableInput(),
      confidence: confidence(82, 90),
      requestedThreshold: 90,
    });
    expect(decision.threshold).toBe(90);
    expect(decision.publish).toBe(false);
  });

  it('MIN_CORROBORATING_SOURCES is the documented floor', () => {
    expect(MIN_CORROBORATING_SOURCES).toBe(2);
  });
});

describe('evaluatePublication — Phase 2 market behaviour', () => {
  /** Strips every other corroboration source so behaviour is isolated. */
  function behaviourOnly(behaviour: BehaviourGateInput) {
    return {
      ...publishableInput(),
      marketProfile: null,
      crossValidation: null,
      historical: historical(), // exactly one non-behaviour source
      behaviour,
    };
  }

  it('counts a well-supported continuation in the setup direction as corroboration', () => {
    const decision = evaluatePublication(
      behaviourOnly({ read: 'continuation', direction: 'bullish', strength: 0.7, structureState: 'uptrend' }),
    );
    expect(decision.corroboratingSources).toHaveLength(2);
    expect(decision.publish).toBe(true);
  });

  it('does not let indecision corroborate anything', () => {
    const decision = evaluatePublication(
      behaviourOnly({ read: 'indecision', direction: 'neutral', strength: 0.9, structureState: 'range' }),
    );
    expect(decision.corroboratingSources).toHaveLength(1);
    expect(decision.publish).toBe(false);
  });

  it('does not count a continuation read that is barely supported', () => {
    const decision = evaluatePublication(
      behaviourOnly({ read: 'continuation', direction: 'bullish', strength: 0.2, structureState: 'uptrend' }),
    );
    expect(decision.corroboratingSources).toHaveLength(1);
    expect(decision.publish).toBe(false);
  });

  it('treats reversal risk against the setup as conflicting evidence', () => {
    const decision = evaluatePublication({
      ...publishableInput(),
      behaviour: { read: 'reversal-risk', direction: 'bearish', strength: 0.6, structureState: 'uptrend' },
    });
    expect(decision.publish).toBe(false);
    expect(decision.conflicts.join(' ')).toContain('reversal risk against a bullish setup');
  });

  it('does not let a marginal structural wobble veto a clean setup', () => {
    // Below MIN_BEHAVIOUR_STRENGTH the read is not well-supported enough to
    // override four otherwise-satisfied conditions.
    const decision = evaluatePublication({
      ...publishableInput(),
      behaviour: { read: 'reversal-risk', direction: 'bearish', strength: 0.1, structureState: 'uptrend' },
    });
    expect(decision.conflicts).toEqual([]);
    expect(decision.publish).toBe(true);
  });

  it('is unaffected when no behaviour read is supplied', () => {
    // Backwards compatibility: callers predating Phase 2 must not regress.
    const withOut = evaluatePublication({ ...publishableInput(), behaviour: null });
    expect(withOut.publish).toBe(true);
  });
});
