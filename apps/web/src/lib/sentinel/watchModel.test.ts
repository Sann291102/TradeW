import { describe, expect, it } from 'vitest';
import {
  byUrgency,
  formatExpiry,
  formatRMultiple,
  groupWatches,
  instrumentLabel,
  isDormant,
  isWatchable,
  nextMilestone,
  plannedRatio,
  positionSnapshot,
  rMultiple,
  rMultipleTone,
  ruleCounts,
  selectableStrategies,
  suggestStrategyName,
  validatePosition,
} from './watchModel';
import type { ParsedStrategy, UserStrategy, WatchSession, WatchState } from './strategyApi';

function watch(overrides: Partial<WatchSession> = {}): WatchSession {
  return {
    id: 'w1',
    userId: 'u1',
    strategyId: 's1',
    symbol: 'NIFTY',
    strike: '24300',
    optionType: 'CE',
    expiry: '2026-08-28',
    ce: null,
    pe: null,
    focusedSide: null,
    watchMode: 'option',
    timeframe: null,
    state: 'IDLE',
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    direction: null,
    reachedMilestones: [],
    lastNotifiedAt: null,
    cooldownUntil: null,
    createdAt: '2026-08-13T04:00:00Z',
    updatedAt: '2026-08-13T04:00:00Z',
    ...overrides,
  };
}

function strategy(overrides: Partial<UserStrategy> = {}): UserStrategy {
  return {
    id: 's1',
    userId: 'u1',
    name: 'ORB',
    rules: emptyParsed(),
    rawInput: 'first 15 min high low breakout',
    inputType: 'text',
    status: 'active',
    createdAt: '2026-08-13T04:00:00Z',
    updatedAt: '2026-08-13T04:00:00Z',
    ...overrides,
  };
}

function emptyParsed(): ParsedStrategy {
  return { timeframe: null, levels: [], rules: [], entry: {}, riskManagement: { targets: [] } };
}

describe('instrumentLabel', () => {
  it('names an option watch the way the notification does', () => {
    // Includes the expiry: "NIFTY 24300 CE" names two different contracts
    // across two series. `instrument_label()` in app/notify/dispatcher.py was
    // widened with it at the same time, so the two still agree.
    expect(instrumentLabel(watch())).toBe('NIFTY 28 AUG 24300 CE');
  });

  it('drops the option parts for a plain index watch', () => {
    expect(instrumentLabel(watch({ strike: null, optionType: null }))).toBe('NIFTY');
  });
});

describe('formatExpiry', () => {
  it('shortens an ISO date', () => {
    expect(formatExpiry('2026-08-28')).toBe('28 Aug');
    expect(formatExpiry('2026-01-05')).toBe('5 Jan');
  });

  it('passes through anything that is not an ISO date', () => {
    expect(formatExpiry(null)).toBe('');
    expect(formatExpiry('weekly')).toBe('weekly');
  });
});

describe('suggestStrategyName', () => {
  it('capitalizes a short description as-is', () => {
    expect(suggestStrategyName('opening range breakout')).toBe('Opening range breakout');
  });

  it('cuts long text on a word boundary', () => {
    const source = 'first 15 min high low breakout with retest and volume confirmation';
    const name = suggestStrategyName(source, 30);
    expect(name).toBe('First 15 min high low…');
    expect(name.length).toBeLessThanOrEqual(31);
    // The kept text is a whole-word prefix of the original: the next character
    // in the source is a space, never the middle of a word.
    const kept = name.slice(0, -1);
    expect(source.slice(0, kept.length).toLowerCase()).toBe(kept.toLowerCase());
    expect(source[kept.length]).toBe(' ');
  });

  it('returns empty for empty input', () => {
    expect(suggestStrategyName('   ')).toBe('');
  });
});

describe('ruleCounts / isWatchable', () => {
  const parsed: ParsedStrategy = {
    ...emptyParsed(),
    rules: [
      { id: 'a', name: 'breakout_high', condition: 'c', mandatory: true, description: 'd' },
      { id: 'b', name: 'retest', condition: 'c', mandatory: true, description: 'd' },
      { id: 'c', name: 'volume_confirm', condition: 'c', mandatory: false, description: 'd' },
    ],
  };

  it('splits mandatory from optional', () => {
    expect(ruleCounts(parsed)).toEqual({ mandatory: 2, optional: 1, total: 3 });
  });

  it('treats a rule-less parse as unwatchable', () => {
    expect(isWatchable(emptyParsed())).toBe(false);
    expect(isWatchable(null)).toBe(false);
    expect(isWatchable(parsed)).toBe(true);
  });

  it('treats an optional-only parse as unwatchable, matching the state machine', () => {
    const optionalOnly: ParsedStrategy = { ...emptyParsed(), rules: [parsed.rules[2]] };
    expect(isWatchable(optionalOnly)).toBe(false);
  });
});

describe('rMultiple', () => {
  // The oracle is app/intrade/monitor.py — same arithmetic, both directions.
  it('measures a long in units of declared risk', () => {
    expect(rMultiple(100, 120, 90, 'LONG')).toBeCloseTo(2);
  });

  it('measures a short in units of declared risk', () => {
    expect(rMultiple(100, 80, 110, 'SHORT')).toBeCloseTo(2);
  });

  it('goes negative when price moves against the position', () => {
    expect(rMultiple(100, 95, 90, 'LONG')).toBeCloseTo(-0.5);
    expect(rMultiple(100, 105, 110, 'SHORT')).toBeCloseTo(-0.5);
  });

  it('refuses to divide by a zero risk', () => {
    expect(rMultiple(100, 120, 100, 'LONG')).toBeNull();
  });
});

describe('formatRMultiple', () => {
  it('signs the value and keeps two decimals', () => {
    expect(formatRMultiple(1.834)).toBe('+1.83R');
    expect(formatRMultiple(-0.4)).toBe('−0.40R');
    expect(formatRMultiple(0)).toBe('0.00R');
  });

  it('shows a dash rather than a fabricated number', () => {
    expect(formatRMultiple(null)).toBe('—');
    expect(formatRMultiple(Infinity)).toBe('—');
  });

  it('tones only by gain or loss', () => {
    expect(rMultipleTone(1)).toBe('positive');
    expect(rMultipleTone(-1)).toBe('negative');
    expect(rMultipleTone(0)).toBe('neutral');
    expect(rMultipleTone(null)).toBe('neutral');
  });
});

describe('nextMilestone', () => {
  it('walks 1R → 2R → 3R', () => {
    expect(nextMilestone([])).toBe('1R');
    expect(nextMilestone(['1R'])).toBe('2R');
    expect(nextMilestone(['1R', '2R'])).toBe('3R');
  });

  it('has nothing left past 3R', () => {
    expect(nextMilestone(['1R', '2R', '3R'])).toBeNull();
  });
});

describe('positionSnapshot', () => {
  const inTrade = watch({
    state: 'IN_TRADE',
    entryPrice: 245.5,
    stopPrice: 225.5,
    targetPrice: 305.5,
    direction: 'LONG',
    reachedMilestones: ['1R'],
  });

  it('derives move, R and the next milestone from a live price', () => {
    const snap = positionSnapshot(inTrade, 285.5);
    expect(snap.move).toBeCloseTo(40);
    expect(snap.r).toBeCloseTo(2);
    expect(snap.next).toBe('2R');
  });

  it('reports nulls rather than guessing when no price has arrived', () => {
    const snap = positionSnapshot(inTrade, null);
    expect(snap.r).toBeNull();
    expect(snap.move).toBeNull();
    expect(snap.currentPrice).toBeNull();
  });

  it('reports nulls for a watch with no declared position', () => {
    const snap = positionSnapshot(watch(), 100);
    expect(snap.r).toBeNull();
    expect(snap.move).toBeNull();
  });
});

describe('groupWatches', () => {
  it('splits by state and orders each group by recency', () => {
    const older = watch({ id: 'a', state: 'FORMING', updatedAt: '2026-08-13T04:00:00Z' });
    const newer = watch({ id: 'b', state: 'CONFIRMED', updatedAt: '2026-08-13T06:00:00Z' });
    const trading = watch({ id: 'c', state: 'IN_TRADE' });
    const done = watch({ id: 'd', state: 'EXITED' });

    const grouped = groupWatches([older, newer, trading, done]);
    expect(grouped.watching.map((w) => w.id)).toEqual(['b', 'a']);
    expect(grouped.inTrade.map((w) => w.id)).toEqual(['c']);
    expect(grouped.closed.map((w) => w.id)).toEqual(['d']);
  });
});

describe('byUrgency', () => {
  it('puts the states that need attention first', () => {
    const states: WatchState[] = ['IDLE', 'EXITED', 'CONFIRMED', 'IN_TRADE', 'FORMING'];
    const sorted = states
      .map((state, i) => watch({ id: state, state, updatedAt: `2026-08-13T0${i}:00:00Z` }))
      .sort(byUrgency)
      .map((w) => w.state);
    expect(sorted).toEqual(['CONFIRMED', 'FORMING', 'IN_TRADE', 'IDLE', 'EXITED']);
  });
});

describe('validatePosition', () => {
  const base = { entryPrice: 245.5, invalidationPrice: 225.5, projectedPrice: 305.5, direction: 'LONG' as const };

  it('accepts a coherent long', () => {
    const result = validatePosition(base);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('rejects a zero risk, the one thing the API refuses too', () => {
    const result = validatePosition({ ...base, invalidationPrice: 245.5 });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/no risk to measure/i);
  });

  it('rejects missing or non-positive prices', () => {
    expect(validatePosition({ ...base, entryPrice: null }).valid).toBe(false);
    expect(validatePosition({ ...base, invalidationPrice: 0 }).valid).toBe(false);
    expect(validatePosition({ ...base, projectedPrice: -1 }).valid).toBe(false);
  });

  it('allows a blank projected level', () => {
    expect(validatePosition({ ...base, projectedPrice: null }).valid).toBe(true);
  });

  it('warns without blocking when the invalidation sits on the wrong side', () => {
    const long = validatePosition({ ...base, invalidationPrice: 260 });
    expect(long.valid).toBe(true);
    expect(long.warnings.join(' ')).toMatch(/already invalidated/i);

    const short = validatePosition({ ...base, direction: 'SHORT', invalidationPrice: 225.5, projectedPrice: 200 });
    expect(short.warnings.join(' ')).toMatch(/already invalidated/i);
  });

  it('warns when the projected level is behind the entry', () => {
    const result = validatePosition({ ...base, projectedPrice: 200 });
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/reported as reached immediately/i);
  });
});

describe('plannedRatio', () => {
  it('compares the projected move to the declared risk', () => {
    expect(plannedRatio(245.5, 225.5, 305.5)).toBeCloseTo(3);
  });

  it('is null without a projection or without risk', () => {
    expect(plannedRatio(245.5, 225.5, null)).toBeNull();
    expect(plannedRatio(245.5, 245.5, 305.5)).toBeNull();
  });
});

describe('selectableStrategies / isDormant', () => {
  it('hides archived strategies from the picker', () => {
    const list = [strategy({ id: 'a' }), strategy({ id: 'b', status: 'archived' }), strategy({ id: 'c', status: 'paused' })];
    expect(selectableStrategies(list).map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('flags a live watch whose strategy is not being swept', () => {
    const paused = [strategy({ id: 's1', status: 'paused' })];
    expect(isDormant(watch({ state: 'FORMING' }), paused)).toBe(true);
    expect(isDormant(watch({ state: 'FORMING' }), [strategy()])).toBe(false);
    // A finished watch is not "dormant", it is done.
    expect(isDormant(watch({ state: 'EXITED' }), paused)).toBe(false);
  });
});
