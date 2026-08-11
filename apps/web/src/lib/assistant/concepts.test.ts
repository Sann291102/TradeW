import { describe, expect, it } from 'vitest';
import { resolveConceptQuestion, conceptReply } from './concepts';
import { resolveUtterance } from './router';

/**
 * Regression cover for the reported failure: asked to explain FVG, BOS, MSS
 * and CHoCH, the assistant answered with a single step — "✓ Open Research" —
 * having navigated to a page and taught the user nothing.
 *
 * The property pinned here is that an explain-question can never resolve to
 * navigation, and can never be handed to the conversation brain for a second
 * opinion (which reproduced the same "open a page" answer).
 */

describe('resolveConceptQuestion', () => {
  it('recognises the exact question that was reported', () => {
    const q = resolveConceptQuestion('How FVG concept works and what is BOS and MSS, CHOCH');
    expect(q).not.toBeNull();
    expect(q!.unsourced).toEqual(
      expect.arrayContaining([
        'Fair Value Gap',
        'Break of Structure',
        'Market Structure Shift',
        'Change of Character',
      ]),
    );
  });

  it.each([
    'what is a fair value gap',
    'explain order blocks',
    'what does CHoCH mean',
    'define break of structure',
  ])('classifies %j as a concept question', (t) => {
    expect(resolveConceptQuestion(t)).not.toBeNull();
  });

  it('is not fooled by a navigation request that mentions a concept', () => {
    expect(resolveConceptQuestion('open the FVG chart')).toBeNull();
    expect(resolveConceptQuestion('show me the option chain')).toBeNull();
  });

  it('still classifies "explain what X is" even though it contains a verb', () => {
    expect(resolveConceptQuestion('explain what an order block is')).not.toBeNull();
  });
});

describe('conceptReply', () => {
  it('names the concepts it cannot source rather than being vague', () => {
    const r = conceptReply({ unsourced: ['Fair Value Gap', 'Break of Structure'] });
    expect(r).toContain('Fair Value Gap');
    expect(r).toContain('Break of Structure');
  });

  it('says plainly that it will not improvise, and never claims to have answered', () => {
    const r = conceptReply({ unsourced: ['Fair Value Gap'] });
    expect(r).toMatch(/can't explain|won't improvise/i);
    expect(r).not.toMatch(/opened|open research/i);
  });
});

describe('router integration — the reported bug', () => {
  const plan = resolveUtterance('How FVG concept works and what is BOS and MSS, CHOCH');

  it('does NOT resolve to navigation', () => {
    expect(plan.actions).toEqual([]);
    expect(plan.intent).toBe('analysis');
  });

  it('is marked final, so the brain cannot replace it with "Open Research"', () => {
    // Without this the plan has analysis intent and no steps, which is exactly
    // the condition that sends an utterance to the conversation brain — and the
    // brain is what produced the navigation answer in the first place.
    expect(plan.final).toBe(true);
  });

  it('carries the observation-only disclaimer', () => {
    expect(plan.disclaimer).toBe(true);
  });

  /**
   * The ordering bug a test caught during development: "what is the current
   * price of NIFTY" opens with the same phrasing as "what is a fair value gap".
   * A price question is a lookup and must keep winning.
   */
  it('does not steal price questions from the quote resolver', () => {
    const q = resolveUtterance('what is the current price of nifty 50?');
    expect(q.intent).toBe('quote');
  });

  it('does not steal navigation', () => {
    expect(resolveUtterance('open research').intent).toBe('command');
  });
});
