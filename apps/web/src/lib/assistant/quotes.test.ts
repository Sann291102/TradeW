import { describe, expect, it } from 'vitest';
import { resolveQuoteQuestion, findSymbols } from './quotes';
import { resolveUtterance } from './router';

/**
 * The quote branch sits between the hard boundaries and the analysis fallback,
 * which makes its edges safety-relevant rather than cosmetic:
 *
 * - claim too much and a judgement question ("should I buy NIFTY here") gets
 *   answered with a bare price, which reads as endorsement;
 * - claim too little and the assistant goes back to saying it cannot look up a
 *   number it is rendering on screen.
 *
 * These tests pin both edges.
 */

describe('findSymbols', () => {
  it('resolves the spoken form of an index', () => {
    expect(findSymbols('what is the current price of nifty 50?')).toEqual(['NIFTY']);
  });

  it('does not confuse bank nifty with nifty', () => {
    expect(findSymbols('bank nifty price')).toEqual(['BANKNIFTY']);
  });

  it('finds more than one instrument in one question', () => {
    const found = findSymbols('price of nifty and banknifty');
    expect(found).toContain('NIFTY');
    expect(found).toContain('BANKNIFTY');
  });

  it('never reports the same symbol twice', () => {
    const found = findSymbols('nifty nifty nifty price');
    expect(found).toEqual(['NIFTY']);
  });
});

describe('resolveQuoteQuestion', () => {
  it.each([
    'what is the current price of nifty 50?',
    'nifty price',
    'what is RELIANCE trading at',
    'ltp of sensex',
    'where is banknifty trading now',
  ])('classifies %j as a price lookup', (q) => {
    expect(resolveQuoteQuestion(q)?.ask).toBe('price');
  });

  it('asks for the range when the question does', () => {
    expect(resolveQuoteQuestion('RELIANCE day range')?.ask).toBe('range');
    expect(resolveQuoteQuestion("what was nifty's high today")?.ask).toBe('range');
  });

  it('asks for volume when the question does', () => {
    expect(resolveQuoteQuestion('sensex volume')?.ask).toBe('volume');
  });

  it('is not a quote question without an instrument', () => {
    expect(resolveQuoteQuestion('what is the price')).toBeNull();
  });

  it('is not a quote question without a price word', () => {
    expect(resolveQuoteQuestion('open nifty chart')).toBeNull();
  });

  // The important half.
  it.each([
    'should I buy nifty at this price?',
    'is RELIANCE cheap right now',
    'what is a good entry price for banknifty',
    'will nifty go up from this level',
    'what is your target price for sensex',
  ])('refuses to treat the judgement question %j as a lookup', (q) => {
    expect(resolveQuoteQuestion(q)).toBeNull();
  });
});

describe('router integration', () => {
  it('routes a price question to the quote intent with a quote action', () => {
    const plan = resolveUtterance('what is the current price of nifty 50?');
    expect(plan.intent).toBe('quote');
    expect(plan.actions).toEqual([{ type: 'quote', symbols: ['NIFTY'], ask: 'price' }]);
    // A number is something a user might act on, so the disclaimer rides along.
    expect(plan.disclaimer).toBe(true);
  });

  it('still refuses advice even when the utterance names a price', () => {
    const plan = resolveUtterance('should I buy nifty at this price?');
    expect(plan.intent).toBe('refusal');
    expect(plan.actions).toEqual([]);
  });

  it('never emits an order action from a price question', () => {
    for (const q of ['nifty price', 'buy nifty at market', 'RELIANCE day range']) {
      const plan = resolveUtterance(q);
      expect(plan.actions.every((a) => a.type !== ('placeOrder' as never))).toBe(true);
    }
  });

  it('leaves genuine analysis questions to the analysis fallback', () => {
    // Deliberately phrased without a symbol or the word "chart": both are
    // command triggers, and `resolveCommand` runs first, so those would resolve
    // to "open the chart" rather than reaching the fallback. That is existing
    // behaviour and arguably right — the user probably does want the chart —
    // but it makes them useless for testing THIS boundary.
    const plan = resolveUtterance('is volume confirming the move');
    expect(plan.intent).toBe('analysis');
  });
});
