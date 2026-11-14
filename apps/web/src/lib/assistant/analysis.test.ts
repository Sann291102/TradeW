import { describe, expect, it } from 'vitest';
import { formatObservation, observationSteps, type MarketObservation, type SymbolCoverage } from './analysis';
import { planUtterance } from './planner';
import { resolveUtterance } from './router';
import { validateAction } from './brain';

/**
 * Tara's market-analysis capability, end to end through the deterministic half.
 *
 * The property under test everywhere below: **numbers come from the structured
 * response and nowhere else.** No indicator is computed here, no model is in
 * the path, and a measurement the payload reports as null is rendered as an
 * explicit absence rather than omitted or filled in.
 */

const NOW_ISO = '2026-08-31T06:00:00.000Z';

function observation(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return {
    symbol: 'NIFTY',
    timeframe: '15m',
    requestedTimeframe: '15m',
    timeframeNote: null,
    observedAt: NOW_ISO,
    barAt: '2026-08-31T05:45:00.000Z',
    lastPrice: 23996.9,
    latestBar: {
      timestamp: '2026-08-31T05:45:00.000Z',
      open: 24011.5,
      high: 24018.2,
      low: 23990.05,
      close: 23996.9,
      volume: 412_500,
    },
    session: { open: 24117.55, high: 24128.7, low: 23996.05, close: 23996.9, volume: 9_120_000, bars: 25 },
    priorDay: null,
    openingRange: { high: 24128.7, low: 24090.1, establishedAt: '2026-08-31T04:15:00.000Z' },
    indicators: {
      rsi14: 63.4,
      ema20: 24040.12,
      ema50: 24102.77,
      vwap: 24055.4,
      macdHistogram: -12.34,
      cpr: { pivot: 24080.1, bc: 24050.5, tc: 24109.7 },
      volumeVsAvg: 1.42,
      realizedVolPct: 0.83,
      vix: 11.32,
      breadthRatio: 0.74,
      support: 23950.4,
      resistance: 24128.7,
    },
    trend: { sessionChangePct: -0.5, momentumScore: 0.62, volumeStrength: 1.42, direction: 'bearish' },
    marketProfile: {
      type: 'Descent Continuation',
      description: 'Constructive drift lower without the conviction of a full trend day',
      trend: 'bearish',
      volatility: 'normal',
      structure: 'trending',
      evidence: ['Session range 23996.1–24128.7'],
    },
    regime: 'trending',
    structure: {
      state: 'downtrend',
      event: 'break-of-structure',
      eventDirection: 'bearish',
      lastSwingHigh: 24128.7,
      lastSwingLow: 23996.05,
      evidence: ['Lower high at 24128.7'],
    },
    liquidity: {
      pools: [{ price: 23990, side: 'below', touches: 3, swept: false }],
      recentSweep: { side: 'above', price: 24128.7, reclaimed: true },
    },
    optionChain: {
      frontExpiry: '2026-09-03T00:00:00.000Z',
      pcr: 0.86,
      maxPain: 24000,
      callOIWall: 24100,
      putOIWall: 23900,
      strikesAnalysed: 21,
      atmStrike: 24000,
      atm: { strike: 24000, callOI: 1_240_000, putOI: 1_066_400, callLtp: 118.35, putLtp: 121.7, callIV: 13.5, putIV: 14.25 },
    },
    contracts: null,
    indexDirection: {
      direction: 'bearish',
      strength: 0.72,
      votes: [{ id: 'ema', label: 'EMA structure', direction: 'bearish', weight: 1, detail: 'price below both EMAs' }],
      conflicts: ['VWAP side'],
      summary: 'four of five reads point lower',
    },
    freshness: {
      ok: true,
      candles: 80,
      newestBarAt: '2026-08-31T05:45:00.000Z',
      barAgeMinutes: 15,
      reason: null,
      checks: [{ id: 'bar-age', label: 'Bar age', passed: true, detail: '15 min' }],
    },
    unavailable: [],
    ...overrides,
  };
}

const COVERAGE: SymbolCoverage = {
  symbol: 'NIFTY',
  kind: 'nse-canonical',
  analysable: true,
  reason: null,
  dataSource: 'Sentinel canonical MarketSnapshot (Dhan real OHLC)',
};

// ---------------------------------------------------------------------------
// The grammar
// ---------------------------------------------------------------------------

describe('the analyze grammar', () => {
  it('"Analyze NIFTY" produces an analyzeMarket action for NIFTY', () => {
    const plan = resolveUtterance('Analyze NIFTY');
    expect(plan.intent).toBe('command');
    expect(plan.actions).toEqual([{ type: 'analyzeMarket', symbol: 'NIFTY', timeframe: null }]);
  });

  it('"Analyze NIFTY 15m" carries the timeframe explicitly', () => {
    const plan = resolveUtterance('Analyze NIFTY 15m');
    expect(plan.actions).toEqual([{ type: 'analyzeMarket', symbol: 'NIFTY', timeframe: '15m' }]);
  });

  it('normalises spoken timeframes onto the chart pill labels', () => {
    for (const [utterance, expected] of [
      ['analyse NIFTY on 5 min', '5m'],
      ['analyse BANKNIFTY 1 hour', '1H'],
      ['analyse NIFTY daily', '1D'],
      ['analyse SENSEX weekly', '1W'],
    ] as const) {
      const plan = resolveUtterance(utterance);
      const action = plan.actions[0];
      expect(action, utterance).toMatchObject({ type: 'analyzeMarket', timeframe: expected });
    }
  });

  it('"Analyze the current chart" resolves nothing itself — the executor does', () => {
    // Nulls, not defaults. Guessing NIFTY/15m here would answer about a chart
    // the user is not looking at and present it as theirs.
    const plan = resolveUtterance('Analyze the current chart');
    expect(plan.actions).toEqual([{ type: 'analyzeMarket', symbol: null, timeframe: null }]);
  });

  it('answers "what is NIFTY doing" with measurements rather than a parked reply', () => {
    const plan = resolveUtterance('what is NIFTY doing');
    expect(plan.actions[0]).toMatchObject({ type: 'analyzeMarket', symbol: 'NIFTY' });
  });

  it('does not fire on a bare symbol — "NIFTY" alone is not a request to measure it', () => {
    // Pre-existing behaviour, pinned here because `matchAnalyze` sits above
    // `matchSymbol` and could plausibly have swallowed it: a bare ticker names
    // a subject, not an action, and turning it into a full market read would
    // make every mistyped symbol an expensive request.
    const plan = resolveUtterance('NIFTY');
    expect(plan.actions.some((a) => a.type === 'analyzeMarket')).toBe(false);
  });

  it('does not hijack a price question', () => {
    const plan = resolveUtterance('what is NIFTY trading at');
    expect(plan.actions[0]?.type).toBe('quote');
  });

  it('does not hijack a concept question', () => {
    const plan = resolveUtterance('what is a fair value gap');
    expect(plan.intent).toBe('analysis');
    expect(plan.actions).toEqual([]);
  });

  it('is read-only — never confirmed, never navigating', () => {
    const plan = planUtterance('analyse NIFTY on 15m');
    expect(plan.risk).toBe('free');
    expect(plan.steps.every((s) => s.action.type === 'analyzeMarket')).toBe(true);
  });

  it('still refuses advice and order phrasing that happens to contain "analyse"', () => {
    // The hard boundaries run ABOVE command resolution, so adding a command
    // that matches more phrasings cannot open a hole in them. Both classes are
    // checked, because a new grammar that makes a previously unmatched phrasing
    // executable is exactly how a dormant boundary gap goes live — the lesson
    // recorded in the Tara chart-drawing note §6.
    const advice = resolveUtterance('analyse NIFTY — should I buy');
    expect(advice.intent).toBe('refusal');
    expect(advice.refusalReason).toBe('advice-boundary');

    const order = resolveUtterance('analyse NIFTY and buy 50 lots');
    expect(order.intent).toBe('refusal');
    expect(order.refusalReason).toBe('order-boundary');
    expect(order.actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The client validator
// ---------------------------------------------------------------------------

describe('validateAction — analyzeMarket', () => {
  it('accepts a well-formed action', () => {
    expect(validateAction({ type: 'analyzeMarket', symbol: 'nifty', timeframe: '15m' })).toEqual({
      type: 'analyzeMarket',
      symbol: 'NIFTY',
      timeframe: '15m',
    });
  });

  it('nulls a junk timeframe rather than passing it to the API', () => {
    expect(validateAction({ type: 'analyzeMarket', symbol: 'NIFTY', timeframe: '3 fortnights' })).toEqual({
      type: 'analyzeMarket',
      symbol: 'NIFTY',
      timeframe: null,
    });
  });

  it('nulls a junk symbol rather than passing it to the API', () => {
    expect(validateAction({ type: 'analyzeMarket', symbol: 'NIFTY; DROP TABLE', timeframe: null })).toEqual({
      type: 'analyzeMarket',
      symbol: null,
      timeframe: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Rendering: the JSON is authoritative
// ---------------------------------------------------------------------------

describe('formatObservation — every number is the payload\'s number', () => {
  it('renders indicator values exactly as received', () => {
    const text = formatObservation(observation());
    expect(text).toContain('RSI(14) 63.4');
    expect(text).toContain('VWAP 24,055.40');
    expect(text).toContain('MACD hist -12.34');
    expect(text).toContain('EMA20 24,040.12');
    expect(text).toContain('EMA50 24,102.77');
  });

  it('renders a changed RSI as the changed value — nothing is memoised or invented', () => {
    const text = formatObservation(
      observation({ indicators: { ...observation().indicators, rsi14: 27.9 } }),
    );
    expect(text).toContain('RSI(14) 27.9');
    expect(text).not.toContain('63.4');
  });

  it('states the symbol and the timeframe that was actually measured', () => {
    const text = formatObservation(observation());
    expect(text).toContain('NIFTY · 15m');
  });

  it('surfaces the timeframe note when the engine measured different bars', () => {
    const text = formatObservation(
      observation({
        timeframe: '1d',
        requestedTimeframe: '1W',
        timeframeNote: 'There is no weekly interval in the analysis engine, so this was measured on daily bars.',
      }),
    );
    expect(text).toContain('NIFTY · 1d');
    expect(text).toContain('no weekly interval');
  });

  it('renders OHLC and volume from the latest bar', () => {
    const text = formatObservation(observation());
    expect(text).toContain('O 24,011.50');
    expect(text).toContain('H 24,018.20');
    expect(text).toContain('L 23,990.05');
    expect(text).toContain('C 23,996.90');
    expect(text).toContain('4,12,500');
  });

  it('renders structure, levels, regime and momentum', () => {
    const text = formatObservation(observation());
    expect(text).toContain('downtrend');
    expect(text).toContain('break-of-structure');
    expect(text).toContain('Support 23,950.40');
    expect(text).toContain('Resistance 24,128.70');
    expect(text).toContain('Descent Continuation');
    expect(text).toContain('regime trending');
  });

  it('renders option-chain measurements including the ATM CE/PE row', () => {
    const text = formatObservation(observation());
    expect(text).toContain('PCR 0.86');
    expect(text).toContain('max pain 24,000');
    expect(text).toContain('call OI wall 24,100');
    expect(text).toContain('CE 118.35');
    expect(text).toContain('PE 121.70');
  });

  it('renders CE/PE leg measurements, and a leg\'s reason when it could not be read', () => {
    const text = formatObservation(
      observation({
        contracts: {
          readable: true,
          unreadableReason: null,
          strike: 24000,
          expiry: '2026-09-03',
          ce: { strike: 24000, changePct: 12.5, direction: 'rising', unavailableReason: null },
          pe: { strike: 24000, changePct: null, direction: null, unavailableReason: 'the bridge declined this leg' },
          alignment: 'call-side-tracking',
          notes: [],
        },
      }),
    );
    expect(text).toContain('CE 24,000 — rising +12.50%');
    expect(text).toContain('the bridge declined this leg');
    expect(text).toContain('call-side-tracking');
  });

  it('renders index direction with its agreement strength', () => {
    const text = formatObservation(observation());
    expect(text).toContain('bearish at 72% agreement');
  });

  it('always states data freshness', () => {
    const text = formatObservation(observation());
    expect(text).toContain('80 bars');
    expect(text).toContain('15 min old');
    expect(text).toContain('within freshness limits');
  });

  it('says the data is stale, with the engine\'s reason, when it is', () => {
    const text = formatObservation(
      observation({
        freshness: {
          ok: false,
          candles: 6,
          newestBarAt: '2026-08-31T05:45:00.000Z',
          barAgeMinutes: 240,
          reason: 'only 6 bars; 40 are needed',
          checks: [],
        },
      }),
    );
    expect(text).toContain('stale');
    expect(text).toContain('only 6 bars');
  });
});

describe('formatObservation — absence is stated, never papered over', () => {
  it('lists unavailable measurements with their reasons', () => {
    const text = formatObservation(
      observation({
        indicators: { ...observation().indicators, vwap: null, rsi14: null },
        unavailable: [
          { field: 'indicators.vwap', reason: 'only 9 bars of 15m history were available' },
          { field: 'indicators.rsi14', reason: 'only 9 bars of 15m history were available' },
        ],
      }),
    );
    expect(text).toContain('Not measured');
    expect(text).toContain('indicators.vwap — only 9 bars');
    // And it does not print a number for the thing it just said it lacks.
    expect(text).not.toContain('VWAP 2');
    expect(text).not.toContain('RSI(14)');
  });

  it('never prints a zero where a measurement was absent', () => {
    const text = formatObservation(
      observation({
        indicators: {
          rsi14: null, ema20: null, ema50: null, vwap: null, macdHistogram: null, cpr: null,
          volumeVsAvg: null, realizedVolPct: null, vix: null, breadthRatio: null,
          support: null, resistance: null,
        },
        openingRange: null,
        unavailable: [{ field: 'indicators.rsi14', reason: 'nine bars only' }],
      }),
    );
    expect(text).not.toMatch(/RSI\(14\) 0/);
    expect(text).not.toMatch(/VWAP 0/);
    // With no support, no resistance and no opening range there is nothing to
    // put under Levels — so the heading is omitted rather than printed empty or
    // filled with zeroes.
    expect(text).not.toContain('**Levels**');
    expect(text).not.toContain('**Indicators**');
  });

  it('says so plainly when there is no price at all', () => {
    const text = formatObservation(observation({ lastPrice: null, latestBar: null, trend: null }));
    expect(text).toContain('not available from the bars read');
  });
});

describe('formatObservation — the premium boundary', () => {
  it('never renders advice, a verdict, or a directive', () => {
    const text = formatObservation(observation()).toLowerCase();
    for (const word of ['buy', 'sell', 'entry', 'target', 'stop loss', 'recommend', 'should']) {
      expect(text, word).not.toContain(word);
    }
  });
});

describe('observationSteps', () => {
  it('traces what was read, from where, and on which bars', () => {
    const steps = observationSteps(observation(), COVERAGE);
    expect(steps.join(' ')).toContain('NIFTY on 15m');
    expect(steps.join(' ')).toContain('Sentinel canonical MarketSnapshot');
    expect(steps.join(' ')).toContain('80 bars');
  });

  it('names the requested timeframe when it differs from the measured one', () => {
    const steps = observationSteps(observation({ timeframe: '1d', requestedTimeframe: '1W' }), COVERAGE);
    expect(steps.join(' ')).toContain('asked for 1W');
  });

  it('reports the count of unavailable measurements', () => {
    const steps = observationSteps(
      observation({ unavailable: [{ field: 'indicators.vwap', reason: 'thin history' }] }),
      COVERAGE,
    );
    expect(steps.join(' ')).toContain('1 measurement(s) unavailable');
  });
});
