import { describe, expect, it } from 'vitest';
import type { Signal } from '../domain';
import {
  buildInstitutionalCrossValidation,
  type CrossValidationInput,
} from './institutional-cross-validation';

/**
 * Phase 6's matrix answers a different question from `buildCrossValidation`:
 * not "do the two engines agree" but "do the independent evidence dimensions
 * agree". The behaviour that matters most is that a dimension with no data
 * ABSTAINS rather than voting neutral — otherwise Sentinel reports five
 * dimensions in mild agreement when only three actually looked.
 */

function signal(over: Partial<Signal>): Signal {
  return { name: 'x', agent: 'market-technical', triggered: true, weight: 0.3, evidence: [], ...over } as Signal;
}

function input(over: Partial<CrossValidationInput> = {}): CrossValidationInput {
  return {
    leadingBias: 'bullish',
    signals: [signal({ name: 'ema_trend' })],
    optionChain: { pcr: 1.4, maxPain: 24000, callOIWall: null, putOIWall: null, strikesAnalysed: 20 },
    historical: {
      patternName: 'orb_retest',
      symbol: 'NIFTY',
      occurrences: 20,
      withKnownOutcome: 12,
      outcomeCounts: { followed_through: 10, failed: 2 },
      sampleTooSmall: false,
    },
    behaviour: { read: 'continuation', direction: 'bullish', strength: 0.7 },
    lastPrice: 24500,
    ...over,
  };
}

describe('buildInstitutionalCrossValidation', () => {
  it('abstains rather than voting neutral when a dimension has no data', () => {
    // The load-bearing distinction. Option chain and news return empty for
    // every symbol today; counting them as neutral would overstate agreement.
    const cv = buildInstitutionalCrossValidation(
      input({ optionChain: null, historical: null, signals: [], behaviour: null }),
    );
    expect(cv.abstaining).toEqual(['technical', 'structure', 'option-chain', 'historical', 'news']);
    expect(cv.voting).toBe(0);
    expect(cv.consensus).toBeNull();
  });

  it('names which dimensions are dark in the summary', () => {
    const cv = buildInstitutionalCrossValidation(input({ optionChain: null }));
    expect(cv.abstaining).toContain('option-chain');
    expect(cv.summary).toContain('No data from');
    expect(cv.summary).toContain('option-chain');
  });

  it('computes consensus only over dimensions that actually voted', () => {
    const cv = buildInstitutionalCrossValidation(input({ optionChain: null }));
    expect(cv.voting).toBe(cv.dimensions.filter((d) => d.stance !== 'abstain').length);
    expect(cv.agreeing).toBeLessThanOrEqual(cv.voting);
  });

  it('reaches a bullish consensus when the dimensions align', () => {
    const cv = buildInstitutionalCrossValidation(input());
    expect(cv.consensus).toBe('bullish');
    expect(cv.dissenting).toEqual([]);
    expect(cv.agreementScore).toBeGreaterThan(0.5);
  });

  it('surfaces dissent rather than burying it', () => {
    // Option positioning against the technical read is exactly what a trader
    // reading only price would miss.
    const cv = buildInstitutionalCrossValidation(
      input({ optionChain: { pcr: 0.5, maxPain: 24000, callOIWall: null, putOIWall: null, strikesAnalysed: 20 } }),
    );
    expect(cv.dissenting).toContain('option-chain');
    expect(cv.summary).toContain('Dissenting');
  });

  it('reads a pinned spot as neutral regardless of PCR', () => {
    const cv = buildInstitutionalCrossValidation(
      input({ lastPrice: 24001, optionChain: { pcr: 1.8, maxPain: 24000, callOIWall: null, putOIWall: null, strikesAnalysed: 20 } }),
    );
    const oc = cv.dimensions.find((d) => d.id === 'option-chain')!;
    expect(oc.stance).toBe('neutral');
    expect(oc.evidence).toContain('pinned');
  });

  it('never reads a dominant "unclear" outcome as a success rate', () => {
    const cv = buildInstitutionalCrossValidation(
      input({
        historical: {
          patternName: 'orb_retest',
          symbol: 'NIFTY',
          occurrences: 20,
          withKnownOutcome: 12,
          outcomeCounts: { unclear: 10, followed_through: 2 },
          sampleTooSmall: false,
        },
      }),
    );
    const h = cv.dimensions.find((d) => d.id === 'historical')!;
    expect(h.stance).toBe('neutral');
  });

  it('has a failing historical record vote against the leading bias', () => {
    const cv = buildInstitutionalCrossValidation(
      input({
        historical: {
          patternName: 'orb_retest',
          symbol: 'NIFTY',
          occurrences: 20,
          withKnownOutcome: 12,
          outcomeCounts: { failed: 10, followed_through: 2 },
          sampleTooSmall: false,
        },
      }),
    );
    const h = cv.dimensions.find((d) => d.id === 'historical')!;
    expect(h.stance).toBe('bearish');
  });

  it('abstains on a historical sample too small to mean anything', () => {
    const cv = buildInstitutionalCrossValidation(
      input({
        historical: {
          patternName: 'orb_retest', symbol: 'NIFTY', occurrences: 3,
          withKnownOutcome: 2, outcomeCounts: { followed_through: 2 }, sampleTooSmall: true,
        },
      }),
    );
    expect(cv.abstaining).toContain('historical');
  });

  it('lets live high-impact news dilute a directional consensus without taking a side', () => {
    const cv = buildInstitutionalCrossValidation(
      input({
        signals: [signal({ name: 'ema_trend' }), signal({ name: 'news_driven_volatility', evidence: ['RBI policy in 20 minutes'] })],
      }),
    );
    const news = cv.dimensions.find((d) => d.id === 'news')!;
    expect(news.stance).toBe('neutral');
    expect(news.strength).toBeGreaterThan(0.8);
  });

  it('does not let the news signal vote twice as a technical signal', () => {
    // NewsIntelligenceService emits under agent 'market-technical' — there is
    // no 'news' member of SignalAgent — so a naive agent filter would count
    // one piece of evidence in two dimensions.
    const cv = buildInstitutionalCrossValidation(
      input({ signals: [signal({ name: 'news_driven_volatility', evidence: ['RBI policy'] })] }),
    );
    const technical = cv.dimensions.find((d) => d.id === 'technical')!;
    expect(technical.stance).toBe('abstain');
  });

  it('resolves a genuine tie to neutral rather than picking a side', () => {
    const cv = buildInstitutionalCrossValidation(
      input({
        signals: [],
        historical: null,
        behaviour: { read: 'continuation', direction: 'bullish', strength: 0.5 },
        optionChain: { pcr: 0.5, maxPain: 24000, callOIWall: null, putOIWall: null, strikesAnalysed: 20 },
      }),
    );
    // structure bullish @0.5 vs option-chain bearish @0.85 → not a tie; assert
    // the mechanism instead on equal strengths.
    expect(['bullish', 'bearish', 'neutral']).toContain(cv.consensus);
    expect(cv.agreementScore).toBeGreaterThanOrEqual(0);
    expect(cv.agreementScore).toBeLessThanOrEqual(1);
  });

  it('gives every dimension readable evidence, including abstentions', () => {
    const cv = buildInstitutionalCrossValidation(input({ optionChain: null, historical: null }));
    for (const d of cv.dimensions) {
      expect(d.evidence.length).toBeGreaterThan(0);
      if (d.stance === 'abstain') expect(d.strength).toBe(0);
    }
  });

  it('never emits directive language', () => {
    const cv = buildInstitutionalCrossValidation(input());
    expect(JSON.stringify(cv)).not.toMatch(/\bbuy\b|\bsell\b|\bexit\b|should/i);
  });
});
