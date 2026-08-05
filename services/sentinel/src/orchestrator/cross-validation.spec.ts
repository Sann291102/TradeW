import { describe, expect, it } from 'vitest';
import { buildCrossValidation } from './sentinel-orchestrator.service';
import type { ReasoningRun, SynthesisResult } from '../sentinel-intelligence/types';

/**
 * `buildCrossValidation` is the merge point between the two reasoning
 * engines: it reads SentinelIntelligence's cached background verdict and
 * judges whether it agrees with the orchestrator's own leading detection,
 * without ever being able to change or block the orchestrator's answer. See
 * `knowledge/Patterns/2026-08-05 - ...reasoning engine merge` (once written).
 */

function synthesis(overrides: Partial<SynthesisResult>): SynthesisResult {
  return {
    surfaced: false,
    observation: null,
    silenceReason: 'below confidence threshold',
    confidence: 0,
    threshold: 0.7,
    corroboratingAgents: 0,
    requiredCorroboration: 2,
    leadingStance: 'neutral',
    corroboration: [],
    conflicts: [],
    validationFailures: [],
    livePerformance: null,
    ...overrides,
  };
}

function run(overrides: Partial<SynthesisResult>): ReasoningRun {
  return { synthesis: synthesis(overrides) } as ReasoningRun;
}

describe('buildCrossValidation', () => {
  it('returns null when there is no cached background run', () => {
    expect(buildCrossValidation(null, 'bullish', 'orb_breakout')).toBeNull();
  });

  it('agrees when the cached run surfaced the same directional stance', () => {
    const cv = buildCrossValidation(
      run({
        surfaced: true,
        silenceReason: null,
        leadingStance: 'bullish',
        corroboratingAgents: 3,
        observation: {
          status: 'Bullish side in focus',
          content: 'evidence',
          confidence: 0.8,
          pattern: 'orb_breakout',
          citations: [
            {
              chunkId: 'a:0',
              sourceId: 'a',
              sourceTitle: 'Trading in the Zone',
              sourcePath: 'docs/Trading Books/tz.pdf',
              sourceKind: 'book',
              locator: 'p. 12',
              charStart: 0,
              charEnd: 10,
              quote: 'a breakout without volume confirmation is unreliable',
              relevance: 0.9,
            },
          ],
          supportingConcepts: [{ conceptId: 'c1', name: 'liquidity sweep', relevance: 'corroborates the read', weight: 0.6, citations: [] }],
          disclaimer: 'not advice',
        },
      }),
      'bullish',
      'orb_breakout',
    );

    expect(cv).not.toBeNull();
    expect(cv!.surfaced).toBe(true);
    expect(cv!.agreesWithConclusion).toBe(true);
    expect(cv!.citations).toHaveLength(1);
    expect(cv!.citations[0].quote).toMatch(/volume confirmation/);
    expect(cv!.supportingConcepts).toHaveLength(1);
    expect(cv!.corroboratingAgents).toBe(3);
    expect(cv!.silenceReason).toBeNull();
  });

  it('does not agree when the cached run surfaced the opposite stance', () => {
    const cv = buildCrossValidation(
      run({
        surfaced: true,
        leadingStance: 'bearish',
        observation: {
          status: 'Bearish side in focus',
          content: 'evidence',
          confidence: 0.75,
          pattern: 'breakdown',
          citations: [],
          supportingConcepts: [],
          disclaimer: 'not advice',
        },
      }),
      'bullish',
      'orb_breakout',
    );

    expect(cv!.surfaced).toBe(true);
    expect(cv!.agreesWithConclusion).toBe(false);
  });

  it('never agrees when the cached run stayed silent, and carries no citations', () => {
    const cv = buildCrossValidation(run({ surfaced: false, silenceReason: 'no live-performance track record' }), 'bullish', 'orb_breakout');

    expect(cv!.surfaced).toBe(false);
    expect(cv!.agreesWithConclusion).toBe(false);
    expect(cv!.citations).toEqual([]);
    expect(cv!.supportingConcepts).toEqual([]);
    expect(cv!.silenceReason).toBe('no live-performance track record');
  });

  it('agrees on a matching pattern id even when the stance label differs', () => {
    // e.g. the orchestrator's leading bias is derived from trend direction
    // wording that does not exactly match SentinelIntelligence's Stance enum,
    // but both are clearly talking about the same named setup.
    const cv = buildCrossValidation(
      run({
        surfaced: true,
        leadingStance: 'no-read',
        observation: {
          status: 'Setup active',
          content: 'evidence',
          confidence: 0.72,
          pattern: 'orb_breakout',
          citations: [],
          supportingConcepts: [],
          disclaimer: 'not advice',
        },
      }),
      'bullish',
      'orb_breakout',
    );

    expect(cv!.agreesWithConclusion).toBe(true);
  });
});
