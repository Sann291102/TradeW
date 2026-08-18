import { describe, expect, it } from 'vitest';
import type { StrategyDetection } from '../intelligence/strategy-engine.service';
import {
  MOVE_COMPLETE_PCT,
  canTransition,
  evaluateLifecycle,
  lifecycleLabel,
  type LifecycleInput,
  type StrategyLifecycleState,
} from './strategy-lifecycle';
import { atmStrikeFor, buildOptionContext, positioningNotes, strikeIntervalFor } from './option-context';
import type { MarketSnapshot, OptionChainRead } from '../intelligence/market-intelligence.service';

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

function input(over: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    detection: detection(),
    published: false,
    behaviour: null,
    lastPrice: 100,
    entryReference: null,
    ...over,
  };
}

describe('canTransition', () => {
  it('allows invalidation from every live state', () => {
    const live: StrategyLifecycleState[] = [
      'WATCHING', 'FORMING', 'CONFIRMED', 'SIDE_IN_FOCUS', 'ACTIVE', 'MOMENTUM_WEAKENING',
    ];
    for (const from of live) expect(canTransition(from, 'INVALIDATED')).toBe(true);
  });

  it('treats LEARN as terminal', () => {
    expect(canTransition('LEARN', 'WATCHING')).toBe(false);
    expect(canTransition('LEARN', 'ACTIVE')).toBe(false);
  });

  it('lets momentum re-accelerate — weakening is not a one-way door', () => {
    expect(canTransition('MOMENTUM_WEAKENING', 'ACTIVE')).toBe(true);
  });

  it('does not allow skipping straight from WATCHING to ACTIVE', () => {
    expect(canTransition('WATCHING', 'ACTIVE')).toBe(false);
  });
});

describe('evaluateLifecycle', () => {
  it('reports FORMING when only some rules confirm', () => {
    const e = evaluateLifecycle('WATCHING', input({
      detection: detection({ validated: false, rulesUnmet: ['Retest volume lower'] }),
    }));
    expect(e.state).toBe('FORMING');
    expect(e.reason).toContain('Retest volume lower');
  });

  it('reaches CONFIRMED but NOT Side in Focus on rule match alone', () => {
    // The separation is the whole point of Phase 1's gate — confirmation is
    // not permission to speak.
    const e = evaluateLifecycle('FORMING', input({ published: false }));
    expect(e.state).toBe('CONFIRMED');
    expect(e.reason).toContain('awaiting the publication gate');
  });

  it('reaches SIDE_IN_FOCUS only once the publication gate cleared', () => {
    const e = evaluateLifecycle('FORMING', input({ published: true }));
    expect(e.state).toBe('SIDE_IN_FOCUS');
  });

  it('checks invalidation before any progression', () => {
    // Ordering guard: checking progression first would let a setup record a
    // MOVE_COMPLETE on the same tick its invalidation fired.
    const e = evaluateLifecycle('ACTIVE', input({
      detection: detection({ invalidationsTriggered: ['Bar closed back inside the ORB range'] }),
      lastPrice: 200,
      entryReference: 100, // a 100% move — would otherwise be MOVE_COMPLETE
    }));
    expect(e.state).toBe('INVALIDATED');
  });

  it('lets a forming setup fall back to WATCHING without recording a failure', () => {
    // A setup that never went live did not fail; recording it as failed would
    // pollute the outcome sample the Brain learns from.
    const e = evaluateLifecycle('FORMING', input({ detection: null }));
    expect(e.state).toBe('WATCHING');
  });

  it('treats a CONFIRMED setup vanishing from the scan as invalidation', () => {
    const e = evaluateLifecycle('CONFIRMED', input({ detection: null }));
    expect(e.state).toBe('INVALIDATED');
    expect(e.reason).toContain('no longer detected');
  });

  it('completes the move once price has travelled far enough', () => {
    const e = evaluateLifecycle('ACTIVE', input({
      lastPrice: 100 * (1 + (MOVE_COMPLETE_PCT + 0.1) / 100),
      entryReference: 100,
    }));
    expect(e.state).toBe('MOVE_COMPLETE');
  });

  it('measures the move in the direction of the setup, not absolute', () => {
    // A bearish setup completes when price FALLS. Measuring absolute movement
    // would complete a bearish setup on a rally that proved it wrong.
    const bearishWrongWay = evaluateLifecycle('ACTIVE', input({
      detection: detection({ bias: 'bearish' }),
      lastPrice: 101,
      entryReference: 100,
    }));
    expect(bearishWrongWay.state).not.toBe('MOVE_COMPLETE');

    const bearishRightWay = evaluateLifecycle('ACTIVE', input({
      detection: detection({ bias: 'bearish' }),
      lastPrice: 99,
      entryReference: 100,
    }));
    expect(bearishRightWay.state).toBe('MOVE_COMPLETE');
  });

  it('reports momentum weakening on a well-supported reversal read', () => {
    const e = evaluateLifecycle('ACTIVE', input({
      behaviour: { read: 'reversal-risk', direction: 'bearish', strength: 0.6 },
    }));
    expect(e.state).toBe('MOMENTUM_WEAKENING');
  });

  it('ignores a weakly-supported behaviour read', () => {
    const e = evaluateLifecycle('ACTIVE', input({
      behaviour: { read: 'reversal-risk', direction: 'bearish', strength: 0.1 },
    }));
    expect(e.state).toBe('ACTIVE');
  });

  it('re-enters ACTIVE when momentum returns', () => {
    const e = evaluateLifecycle('MOMENTUM_WEAKENING', input({
      behaviour: { read: 'continuation', direction: 'bullish', strength: 0.7 },
    }));
    expect(e.state).toBe('ACTIVE');
  });

  it('advances a terminal state to LEARN exactly once, then parks', () => {
    const toLearn = evaluateLifecycle('MOVE_COMPLETE', input());
    expect(toLearn.state).toBe('LEARN');
    const parked = evaluateLifecycle('LEARN', input());
    expect(parked.state).toBe('LEARN');
    expect(parked.changed).toBe(false);
  });

  it('holds state rather than corrupting the sequence on an illegal transition', () => {
    // WATCHING → MOVE_COMPLETE is not legal; the machine must refuse it.
    const e = evaluateLifecycle('WATCHING', input({ lastPrice: 200, entryReference: 100 }));
    expect(e.state).toBe('WATCHING');
    expect(e.reason).toContain('not a legal transition');
  });

  it('always explains why it is in the state it is in', () => {
    for (const state of ['WATCHING', 'FORMING', 'CONFIRMED', 'ACTIVE'] as StrategyLifecycleState[]) {
      expect(evaluateLifecycle(state, input()).reason.length).toBeGreaterThan(0);
    }
  });

  it('labels every state in non-directive language', () => {
    const states: StrategyLifecycleState[] = [
      'WATCHING', 'FORMING', 'CONFIRMED', 'SIDE_IN_FOCUS', 'ACTIVE',
      'MOMENTUM_WEAKENING', 'MOVE_COMPLETE', 'INVALIDATED', 'LEARN',
    ];
    for (const s of states) {
      const label = lifecycleLabel(s);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/buy|sell|exit|target|entry/i);
    }
  });
});

describe('option context — Phase 3', () => {
  const chain: OptionChainRead = {
    pcr: 1.35,
    maxPain: 24500,
    callOIWall: 24600,
    putOIWall: 24400,
    strikesAnalysed: 21,
    frontExpiry: new Date('2026-08-20T00:00:00Z'),
    // These tests exercise `buildOptionContext`, which reads only the
    // aggregates above; the per-strike rows are what strike-candidate
    // evaluation consumes and are covered by its own spec.
    entries: [],
  };

  function snapshot(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
    return { symbol: 'NIFTY', lastPrice: 24512, optionChain: chain, ...over } as MarketSnapshot;
  }

  it('rounds to the instrument’s real strike interval', () => {
    // A strike that does not trade reads as authoritative and is simply false.
    expect(strikeIntervalFor('NIFTY')).toBe(50);
    expect(strikeIntervalFor('BANKNIFTY')).toBe(100);
    expect(atmStrikeFor('NIFTY', 24512)).toBe(24500);
    expect(atmStrikeFor('BANKNIFTY', 52480)).toBe(52500);
  });

  it('defaults unknown symbols to the index convention rather than failing', () => {
    expect(strikeIntervalFor('SOMETHINGNEW')).toBe(50);
  });

  it('maps a bullish read to CE and a bearish read to PE', () => {
    expect(buildOptionContext(snapshot(), 'bullish').side).toBe('CE');
    expect(buildOptionContext(snapshot(), 'bearish').side).toBe('PE');
  });

  it('reports honestly when no chain is published instead of inventing one', () => {
    // getOptionChain() returns [] for every symbol today. A fabricated PCR
    // would flow into the confidence engine and a trader's read of positioning.
    const ctx = buildOptionContext(snapshot({ optionChain: null }), 'bullish');
    expect(ctx.unavailable).toBe(true);
    expect(ctx.pcr).toBeNull();
    expect(ctx.maxPain).toBeNull();
    expect(ctx.unavailableReason).toContain('No option chain is published');
    // The ATM strike is still derivable from spot, and is labelled as such.
    expect(ctx.atmStrike).toBe(24500);
  });

  it('surfaces positioning that disagrees with the structural read', () => {
    const notes = positioningNotes({ ...chain, pcr: 0.6 }, 24512, 'bullish');
    expect(notes.join(' ')).toContain('against the bullish structural read');
  });

  it('flags a pinned spot', () => {
    const notes = positioningNotes(chain, 24501, 'bullish');
    expect(notes.join(' ')).toContain('pinned');
  });

  it('carries no entry, target, stop or size — the boundary is structural', () => {
    const ctx = buildOptionContext(snapshot(), 'bullish');
    const keys = Object.keys(ctx);
    expect(keys).not.toContain('entry');
    expect(keys).not.toContain('target');
    expect(keys).not.toContain('stopLoss');
    expect(keys).not.toContain('quantity');
    expect(JSON.stringify(ctx)).not.toMatch(/\bbuy\b|\bsell\b|\bexit\b/i);
  });
});
