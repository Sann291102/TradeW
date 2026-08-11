import { describe, expect, it } from 'vitest';
import { contractBadge, extractSafetyFeed } from './deriveContext';
import type { Observation, SideInFocus, Synthesis } from './types';

/**
 * The Live Safety Feed's "Side in Focus" label is reached by two unrelated
 * routes, and only one of them knows a contract side.
 *
 * These pin the boundary between them. The bug they cover shipped: the badge
 * was recovered in the view by substring-matching the card's prose for
 * 'CE'/'PE', so a bearish CPR breakdown — which contains neither — fell
 * through to a bullish "CE CALL" with green styling and a `positive`-toned
 * confidence badge. A user reading that card would conclude Sentinel favoured
 * calls on a signal that said the opposite. The mirror case was just as bad:
 * any incidental uppercase 'PE' (as in "OPEN range") forced "PE PUT".
 *
 * The rule now: a card renders a side only when it carries one as data.
 */

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    agent: 'strategy',
    category: 'strategy',
    pattern: 'cpr_breakout_bounce',
    content:
      'CPR Breakout / Bounce (bearish side): 2/2 rules confirmed; Price closed below the CPR bottom at 24572.6; Current bar volume is 1.2x the 20-bar average',
    evidence: ['Price closed below the CPR bottom at 24572.6'],
    confidence: 0.8,
    ...overrides,
  };
}

function sideInFocus(overrides: Partial<SideInFocus> = {}): SideInFocus {
  return {
    side: 'CE',
    bias: 'bullish',
    strike: 24550,
    confidence: 82,
    rationale: ['Liquidity Sweep points bullish (82%)'],
    tradeManagement: { riskReward: '1:3', trailing: ['1:1', '1:2', '1:3'], note: 'Educational framing only.' },
    disclaimer: 'Educational analysis only — not a buy/sell signal.',
    ...overrides,
  } as SideInFocus;
}

describe('extractSafetyFeed — which cards carry a side', () => {
  it('gives a bearish pattern detection NO side, even though it is labelled Side in Focus', () => {
    const cards = extractSafetyFeed([observation()], null, null);
    const card = cards.find((c) => c.action === 'Side in Focus');

    expect(card).toBeDefined();
    // The regression: this card used to render "CE CALL" on a bearish signal.
    expect(card!.side).toBeUndefined();
    expect(card!.bias).toBeUndefined();
  });

  it('does not let an incidental uppercase PE in the prose imply a put', () => {
    const cards = extractSafetyFeed(
      [observation({ pattern: 'orb_retest', content: 'ORB Retest (bullish side): price reclaimed the OPEN range high' })],
      null,
      null,
    );
    expect(cards.find((c) => c.action === 'Side in Focus')!.side).toBeUndefined();
  });

  it('carries the real directional read’s side through as data', () => {
    const ce = extractSafetyFeed([], null, sideInFocus());
    expect(ce[0].side).toBe('CE');
    expect(ce[0].bias).toBe('bullish');

    const pe = extractSafetyFeed([], null, sideInFocus({ side: 'PE', bias: 'bearish' }));
    expect(pe[0].side).toBe('PE');
    expect(pe[0].bias).toBe('bearish');
  });

  it('omits a directional read that did not clear the 70% floor', () => {
    const cards = extractSafetyFeed([], null, sideInFocus({ confidence: 65 }));
    expect(cards.find((c) => c.side)).toBeUndefined();
  });
});

describe('contractBadge — the rule that actually renders the badge', () => {
  // These are the cases the shipped bug got wrong. Each asserts against the
  // FULL pipeline: a real card built by extractSafetyFeed, then the badge rule
  // applied to it, so neither half can regress alone.
  const badgeFor = (cards: ReturnType<typeof extractSafetyFeed>) =>
    contractBadge(cards.find((c) => c.action === 'Side in Focus')!);

  it('shows NO badge on a bearish CPR breakdown (was: "CE CALL")', () => {
    expect(badgeFor(extractSafetyFeed([observation()], null, null))).toBeNull();
  });

  it('shows NO badge when the prose merely contains "OPEN" (was: "PE PUT")', () => {
    const cards = extractSafetyFeed(
      [observation({ pattern: 'orb_retest', content: 'ORB Retest: price reclaimed the OPEN range high' })],
      null,
      null,
    );
    expect(badgeFor(cards)).toBeNull();
  });

  it('shows PE PUT on a genuine bearish read, and never mislabels it a call', () => {
    const badge = badgeFor(extractSafetyFeed([], null, sideInFocus({ side: 'PE', bias: 'bearish' })));
    expect(badge).toEqual({ side: 'PE', label: 'PE PUT', tone: 'down' });
  });

  it('shows CE CALL on a genuine bullish read', () => {
    expect(badgeFor(extractSafetyFeed([], null, sideInFocus()))).toEqual({ side: 'CE', label: 'CE CALL', tone: 'up' });
  });
});

describe('extractSafetyFeed — the synthesis duplicate', () => {
  const synthesis: Synthesis = {
    // The LLM rewrite of an observation the feed already carries, complete
    // with the tutor-voice tail the synthesis prompt asks for.
    content:
      'Observations suggest a possible position sizing drift in the NIFTY market. Consider waiting for confirmation of price action before making further decisions.',
    pattern: 'position_sizing_drift',
    confidence: 0.73,
    disclaimer: 'Observation only.',
  };

  const drift = observation({
    agent: 'emotion',
    category: 'behaviour',
    pattern: 'position_sizing_drift',
    content: 'Position sizing on the last trade was 2.4x your session average',
    evidence: ['Position sizing on the last trade was 2.4x your session average'],
    confidence: 0.7,
  });

  it('drops the synthesis when it restates a pattern already in the feed', () => {
    const cards = extractSafetyFeed([drift], synthesis, null);
    const enough = cards.filter((c) => c.action === 'Enough');

    // Previously two: the terse measurement AND its padded restatement.
    expect(enough).toHaveLength(1);
    expect(enough[0].explanation).toBe('Position sizing on the last trade was 2.4x your session average');
    expect(cards.find((c) => c.id === 'synthesis')).toBeUndefined();
  });

  it('keeps the synthesis when it is the only source for that pattern', () => {
    const cards = extractSafetyFeed([], synthesis, null);
    expect(cards.find((c) => c.id === 'synthesis')).toBeDefined();
  });
});
