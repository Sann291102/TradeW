import { describe, expect, it } from 'vitest';
import { enforceVocabulary, hasDirectiveLanguage } from './vocabulary';

/**
 * The vocabulary enforcer is the last thing between a model — or a
 * deterministic composer — and a trader. These tests pin both halves of its
 * job: it must rewrite genuine directives, and it must leave legitimate
 * analytical English alone.
 *
 * The second half is not a nicety. Over-rewriting produced visibly broken
 * output twice: "not advice" became "not observation", and "the short-term
 * trend reference" became "the observe-term trend reference".
 */

describe('directive rewriting', () => {
  it('rewrites bare imperatives', () => {
    expect(enforceVocabulary('buy now').clean).not.toMatch(/\bbuy\b/i);
    expect(enforceVocabulary('you should sell').clean).not.toMatch(/\bsell\b/i);
  });

  it('rewrites directional instructions', () => {
    expect(enforceVocabulary('go long here').clean).toMatch(/bullish side in focus/i);
    expect(enforceVocabulary('short the index').clean).not.toMatch(/\bshort the\b/i);
  });

  it('rewrites stop-loss and target language', () => {
    expect(enforceVocabulary('place a stop-loss at 24300').clean).toMatch(/invalidation level/i);
    expect(enforceVocabulary('target of 24800').clean).not.toMatch(/\btarget\b/i);
  });

  it('reports every phrase it had to change', () => {
    const { violations } = enforceVocabulary('buy now and set a stop-loss at 100');
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe('legitimate analytical English is left alone', () => {
  // Regression: the bare-imperative rule matched inside "short-term" because a
  // hyphen is a word boundary, turning the phrase into "observe-term".
  it.each(['short-term', 'short term', 'short-dated', 'short-lived', 'short interest', 'short squeeze', 'short covering'])(
    'does not mangle "%s"',
    (phrase) => {
      const input = `The ${phrase} reference is worth noting.`;
      expect(enforceVocabulary(input).clean).toContain(phrase);
    },
  );

  it('does not flag a surviving "short-term" as a residual breach', () => {
    // The synthesis gate fails CLOSED on this probe, so a false positive here
    // silently withholds a correct observation.
    expect(hasDirectiveLanguage('Momentum on the short-term trend reference is easing.')).toBe(false);
  });

  it('still flags a genuine residual directive', () => {
    expect(hasDirectiveLanguage('You should buy here.')).toBe(true);
    expect(hasDirectiveLanguage('short the index into expiry')).toBe(true);
  });

  it('leaves the reviewed closing disclaimer intact when it is not enforced', () => {
    // The composer appends this AFTER enforcement precisely because the noun
    // "advice" is itself on the rewrite table.
    const closer = 'This is an observation of current market state, not advice.';
    expect(hasDirectiveLanguage(closer)).toBe(false);
  });
});
