import type { Instrument } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resolveConfig, type BacktestConfig } from './backtest-config';
import { computeStop, mayEnter, simulate, sizePosition, type SimBar, type SimSignal } from './execution-simulator';

/**
 * The money suite.
 *
 * These assert the arithmetic a reader of a backtest cannot check for
 * themselves. The one they exist for above all is the P&L identity: a result
 * that computes `(exit - entry) x qty` and gestures at costs afterwards is how
 * a losing strategy comes to look profitable, and nothing in the output would
 * say so.
 */

const INSTRUMENT = {
  id: 'inst-1',
  symbol: 'NIFTY',
  displayName: 'NIFTY 50',
  type: 'INDEX',
  exchange: 'NSE',
  underlying: null,
  expiryDate: null,
  strikePrice: null,
  optionType: null,
  lotSize: 1,
  tickSize: 0.05,
} as unknown as Instrument;

function cfg(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return resolveConfig({
    symbol: 'NIFTY',
    exchange: 'NSE',
    timeframe: '15m',
    startAt: '2026-05-04T00:00:00.000Z',
    endAt: '2026-05-08T00:00:00.000Z',
    ...DEFAULT_CONFIG,
    sizingMode: 'FIXED_QUANTITY',
    sizingValue: 10,
    stopMode: 'PERCENT',
    stopPct: 0.01,
    rewardRisk: 2,
    slippageRate: 0,
    feeRate: 0,
    intradayOnly: false,
    timeoutBars: 0,
    ...overrides,
  });
}

/** Bars at 15m from 09:15 IST (03:45Z) on 2026-05-04. */
function bars(spec: Partial<SimBar>[], startZ = Date.UTC(2026, 4, 4, 3, 45)): SimBar[] {
  return spec.map((s, i) => ({
    t: startZ + i * 15 * 60_000,
    o: s.o ?? 100,
    h: s.h ?? Math.max(s.o ?? 100, s.c ?? 100) + 1,
    l: s.l ?? Math.min(s.o ?? 100, s.c ?? 100) - 1,
    c: s.c ?? 100,
    v: s.v ?? 1000,
  }));
}

function signal(barIndex: number, bias: 'bullish' | 'bearish' = 'bullish'): SimSignal {
  return {
    barIndex,
    nextBarIndex: barIndex + 1,
    strategyId: 's',
    strategyName: 'S',
    confidence: 90,
    bias,
    rulesMatched: ['r1'],
    context: { trend: 'bullish', volatilityRegime: 'normal' },
  };
}

describe('simulate — the P&L identity', () => {
  it('gross - fees - slippage = net, exactly, on every trade', () => {
    const b = bars([
      { o: 100, c: 100 },
      { o: 100, c: 100 }, // entry at 100
      { o: 100, h: 130, l: 99, c: 120 }, // target at 102 hit
      { o: 120, c: 120 },
    ]);
    const c = cfg({ feeRate: 0.0003, slippageRate: 0.0005 });
    const r = simulate(b, [signal(0)], c, INSTRUMENT);

    expect(r.trades).toHaveLength(1);
    for (const t of r.trades) {
      expect(t.netPnl).toBeCloseTo(t.grossPnl - t.fees - t.slippageCost, 2);
      expect(t.fees).toBeGreaterThan(0);
      expect(t.slippageCost).toBeGreaterThan(0);
    }
  });

  it('final cash equals initial capital plus the sum of net P&L', () => {
    const b = bars([
      { o: 100, c: 100 },
      { o: 100, c: 100 },
      { o: 100, h: 130, l: 99, c: 120 },
      { o: 120, c: 120 },
      { o: 120, c: 120 },
      { o: 120, h: 125, l: 100, c: 105 },
    ]);
    const c = cfg({ feeRate: 0.0003, slippageRate: 0.0005, cooldownBars: 0 });
    const r = simulate(b, [signal(0), signal(3)], c, INSTRUMENT);

    const netSum = r.trades.reduce((s, t) => s + t.netPnl, 0);
    // Every position is closed by the run's end, so free cash must be the whole
    // account. This is the check that catches a margin that was blocked and
    // never released.
    expect(r.finalCash).toBeCloseTo(c.initialCapital + netSum, 1);
    expect(r.finalPortfolioValue).toBeCloseTo(c.initialCapital + netSum, 1);
  });

  it('cashAfter on each trade reconciles with the running account', () => {
    const b = bars([
      { o: 100, c: 100 },
      { o: 100, c: 100 },
      { o: 100, h: 130, l: 99, c: 120 },
      { o: 120, c: 120 },
      { o: 120, c: 120 },
      { o: 120, h: 160, l: 119, c: 150 },
    ]);
    const c = cfg({ feeRate: 0.0003 });
    const r = simulate(b, [signal(0), signal(3)], c, INSTRUMENT);
    let running = c.initialCapital;
    for (const t of r.trades) {
      running += t.netPnl;
      expect(t.cashAfter).toBeCloseTo(running, 1);
    }
  });
});

describe('simulate — direction', () => {
  it('a long makes money when price rises and loses when it falls', () => {
    const up = simulate(
      bars([{ o: 100, c: 100 }, { o: 100, c: 100 }, { o: 100, h: 130, l: 99.5, c: 120 }]),
      [signal(0)],
      cfg(),
      INSTRUMENT,
    );
    expect(up.trades[0].netPnl).toBeGreaterThan(0);

    const down = simulate(
      bars([{ o: 100, c: 100 }, { o: 100, c: 100 }, { o: 100, h: 100.5, l: 90, c: 91 }]),
      [signal(0)],
      cfg(),
      INSTRUMENT,
    );
    expect(down.trades[0].netPnl).toBeLessThan(0);
  });

  it('a short makes money when price FALLS — the sign is not inverted', () => {
    const r = simulate(
      bars([{ o: 100, c: 100 }, { o: 100, c: 100 }, { o: 100, h: 100.5, l: 90, c: 91 }]),
      [signal(0, 'bearish')],
      cfg({ allowShort: true }),
      INSTRUMENT,
    );
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].side).toBe('SELL');
    expect(r.trades[0].exitReason).toBe('TARGET'); // short target is BELOW entry
    expect(r.trades[0].netPnl).toBeGreaterThan(0);
  });

  it('refuses a bearish signal when shorting is disabled', () => {
    const r = simulate(
      bars([{ o: 100, c: 100 }, { o: 100, c: 100 }, { o: 100, c: 90 }]),
      [signal(0, 'bearish')],
      cfg({ allowShort: false }),
      INSTRUMENT,
    );
    expect(r.trades).toHaveLength(0);
    expect(r.skips[0].reason).toMatch(/short entries are disabled/);
  });
});

describe('simulate — no look-ahead and pessimistic fills', () => {
  it('fills at the NEXT bar\'s open, never on the signal bar', () => {
    const b = bars([
      { o: 100, c: 100 },
      { o: 107, c: 108 }, // the fill bar — its OPEN is the entry
      { o: 108, h: 130, l: 107, c: 120 },
    ]);
    const r = simulate(b, [signal(0)], cfg(), INSTRUMENT);
    expect(r.trades[0].entryPrice).toBe(107);
    expect(r.trades[0].entryTime.getTime()).toBe(b[1].t);
  });

  it('takes the STOP when one bar spans both the stop and the target', () => {
    // Entry 100, stop 99 (1%), target 102. The bar's range covers both.
    const b = bars([
      { o: 100, c: 100 },
      { o: 100, c: 100 },
      { o: 100.5, h: 105, l: 98, c: 104 },
    ]);
    const r = simulate(b, [signal(0)], cfg(), INSTRUMENT);
    expect(r.trades[0].exitReason).toBe('STOP');
    expect(r.trades[0].exitPrice).toBe(99);
  });

  it('fills at the OPEN when a bar gaps through the stop, not at the stop', () => {
    // Entry 100, stop 99. Next bar opens at 95 — the stop was never available.
    const b = bars([
      { o: 100, c: 100 },
      { o: 100, c: 100 },
      { o: 95, h: 96, l: 94, c: 95 },
    ]);
    const r = simulate(b, [signal(0)], cfg(), INSTRUMENT);
    expect(r.trades[0].exitReason).toBe('STOP');
    expect(r.trades[0].exitPrice).toBe(95);
    expect(r.trades[0].netPnl).toBeLessThan(-40); // 10 units x -5
  });
});

describe('simulate — forced exits', () => {
  /** A bar that goes nowhere: too tight to reach the 1% stop or the 2% target,
   *  so only a forced exit can close the position. The default `bars()` low of
   *  `min(o,c) - 1` WOULD hit a 1% stop on a 100-point instrument, which is
   *  exactly the trap these tests are here to avoid tripping over. */
  const flat = { o: 100, c: 100, h: 100.2, l: 99.8 };

  it('squares off at the configured IST minute', () => {
    // 15:15 IST = 09:45Z. Bars every 15m from 09:15 IST, so bar 24 is 15:15.
    const b = bars(Array.from({ length: 26 }, () => ({ ...flat })));
    const c = cfg({ intradayOnly: true, squareOffMinute: 15 * 60 + 15, timeoutBars: 0 });
    const r = simulate(b, [signal(0)], c, INSTRUMENT);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitReason).toBe('SQUARE_OFF');
  });

  it('closes at the last bar of the session when intraday', () => {
    const b = bars([{ ...flat }, { ...flat }, { ...flat }]);
    const c = cfg({ intradayOnly: true, squareOffMinute: 23 * 60, timeoutBars: 0 });
    const r = simulate(b, [signal(0)], c, INSTRUMENT);
    expect(r.trades[0].exitReason).toBe('SESSION_END');
  });

  it('closes at the run end rather than silently dropping an open position', () => {
    const b = bars([{ ...flat }, { ...flat }, { ...flat }]);
    const c = cfg({ intradayOnly: false, timeoutBars: 0 });
    const r = simulate(b, [signal(0)], c, INSTRUMENT);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitReason).toBe('RUN_END');
  });

  it('times out after the configured number of bars', () => {
    const b = bars(Array.from({ length: 12 }, () => ({ ...flat })));
    const c = cfg({ timeoutBars: 3, intradayOnly: false });
    const r = simulate(b, [signal(0)], c, INSTRUMENT);
    expect(r.trades[0].exitReason).toBe('TIMEOUT');
    expect(r.trades[0].barsHeld).toBe(3);
  });
});

describe('mayEnter — the risk gates', () => {
  const base = {
    i: 10,
    armedFrom: 0,
    openCount: 0,
    ordersToday: 0,
    realizedToday: 0,
    minuteOfDay: 10 * 60,
    isSessionLastBar: false,
    cfg: cfg({ maxOpenPositions: 1, maxOrdersPerDay: 2, maxLossPerDay: 5_000, intradayOnly: true }),
  };

  it('allows a clean entry', () => {
    expect(mayEnter(signal(1), base)).toBeNull();
  });

  it('refuses when already at the position limit', () => {
    expect(mayEnter(signal(1), { ...base, openCount: 1 })?.kind).toBe('REJECTED');
  });

  it('refuses when the daily order cap is reached', () => {
    expect(mayEnter(signal(1), { ...base, ordersToday: 2 })?.reason).toMatch(/Daily order cap/);
  });

  it('refuses when the daily loss limit is reached, and treats it as a limit not a target', () => {
    expect(mayEnter(signal(1), { ...base, realizedToday: -5_000 })?.reason).toMatch(/Daily loss limit/);
    expect(mayEnter(signal(1), { ...base, realizedToday: -4_999 })).toBeNull();
  });

  it('refuses at or past the square-off minute', () => {
    const c = { ...base, minuteOfDay: base.cfg.squareOffMinute };
    expect(mayEnter(signal(1), c)?.kind).toBe('SKIPPED');
  });

  it('refuses on the last bar of a session', () => {
    expect(mayEnter(signal(1), { ...base, isSessionLastBar: true })?.reason).toMatch(/Last bar/);
  });

  it('respects the cooldown', () => {
    expect(mayEnter(signal(1), { ...base, armedFrom: 20 })?.reason).toMatch(/cooldown/);
  });

  it('skips a neutral signal', () => {
    expect(mayEnter({ ...signal(1), bias: 'neutral' }, base)?.reason).toMatch(/No directional bias/);
  });
});

describe('the daily loss limit actually stops trading mid-run', () => {
  it('takes no further entry after the day\'s realized loss crosses the limit', () => {
    // Two signals; the first loses more than the limit.
    const b = bars([
      { o: 1000, c: 1000 },
      { o: 1000, c: 1000 }, // entry 1000, stop 990
      { o: 900, h: 905, l: 895, c: 900 }, // gaps through the stop: -100 x 100 units
      { o: 900, c: 900 },
      { o: 900, c: 900 },
      { o: 900, h: 1200, l: 899, c: 1100 },
    ]);
    const c = cfg({
      sizingMode: 'FIXED_QUANTITY',
      sizingValue: 100,
      maxLossPerDay: 5_000,
      maxOrdersPerDay: 10,
      intradayOnly: false,
      timeoutBars: 0,
    });
    const r = simulate(b, [signal(0), signal(3)], c, INSTRUMENT);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].netPnl).toBeLessThan(-5_000);
    expect(r.skips.some((s) => /Daily loss limit/.test(s.reason))).toBe(true);
  });
});

describe('sizePosition', () => {
  const c = cfg();
  it('FIXED_QUANTITY returns the quantity', () => {
    expect(sizePosition({ cfg: { ...c, sizingMode: 'FIXED_QUANTITY', sizingValue: 7 }, equityNow: 1e6, price: 100, stop: 99, lotSize: 1 })).toBe(7);
  });
  it('FIXED_LOTS multiplies by the contract lot size', () => {
    expect(sizePosition({ cfg: { ...c, sizingMode: 'FIXED_LOTS', sizingValue: 2 }, equityNow: 1e6, price: 100, stop: 99, lotSize: 65 })).toBe(130);
  });
  it('CAPITAL_PCT sizes off CURRENT equity, so a drawdown reduces size', () => {
    const cfgPct = { ...c, sizingMode: 'CAPITAL_PCT' as const, sizingValue: 10 };
    expect(sizePosition({ cfg: cfgPct, equityNow: 1_000_000, price: 100, stop: 99, lotSize: 1 })).toBe(1000);
    expect(sizePosition({ cfg: cfgPct, equityNow: 500_000, price: 100, stop: 99, lotSize: 1 })).toBe(500);
  });
  it('RISK_PCT sizes off the distance to the stop, and returns 0 without one', () => {
    const cfgRisk = { ...c, sizingMode: 'RISK_PCT' as const, sizingValue: 1 };
    // 1% of 1,000,000 = 10,000 risked; 2 points of risk => 5,000 units.
    expect(sizePosition({ cfg: cfgRisk, equityNow: 1_000_000, price: 100, stop: 98, lotSize: 1 })).toBe(5000);
    expect(sizePosition({ cfg: cfgRisk, equityNow: 1_000_000, price: 100, stop: null, lotSize: 1 })).toBe(0);
  });
  it('rounds DOWN to whole lots — a fractional lot is not an order', () => {
    expect(sizePosition({ cfg: { ...c, sizingMode: 'FIXED_QUANTITY', sizingValue: 100 }, equityNow: 1e6, price: 100, stop: 99, lotSize: 65 })).toBe(65);
  });
});

describe('computeStop', () => {
  const b = bars([{ o: 100, h: 101, l: 97, c: 100 }, { o: 100, c: 100 }]);
  it('SIGNAL_BAR uses the bar BEFORE the entry bar', () => {
    expect(computeStop(b, 1, 'BUY', 100, cfg({ stopMode: 'SIGNAL_BAR' }))).toBe(97);
    expect(computeStop(b, 1, 'SELL', 100, cfg({ stopMode: 'SIGNAL_BAR' }))).toBe(101);
  });
  it('refuses a stop on the wrong side of the fill rather than inventing one', () => {
    // Entry gapped below the signal bar's low — there is no valid long stop.
    expect(computeStop(b, 1, 'BUY', 96, cfg({ stopMode: 'SIGNAL_BAR' }))).toBeNull();
  });
  it('PERCENT places the stop symmetrically around the fill', () => {
    expect(computeStop(b, 1, 'BUY', 100, cfg({ stopMode: 'PERCENT', stopPct: 0.02 }))).toBeCloseTo(98, 6);
    expect(computeStop(b, 1, 'SELL', 100, cfg({ stopMode: 'PERCENT', stopPct: 0.02 }))).toBeCloseTo(102, 6);
  });
  it('NONE means no stop and no target', () => {
    expect(computeStop(b, 1, 'BUY', 100, cfg({ stopMode: 'NONE' }))).toBeNull();
  });
});

describe('determinism', () => {
  it('the same inputs simulate to byte-identical output', () => {
    const b = bars(Array.from({ length: 30 }, (_, i) => ({ o: 100 + i, c: 100 + i })));
    const sigs = [signal(0), signal(10), signal(20)];
    const a = simulate(b, sigs, cfg(), INSTRUMENT);
    const z = simulate(b, sigs, cfg(), INSTRUMENT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(z));
  });
});

describe('a backtest never touches the OMS', () => {
  it('returns plain data and holds no reference to an order service', () => {
    const r = simulate(bars([{ o: 100, c: 100 }, { o: 100, c: 100 }, { o: 100, c: 101 }]), [signal(0)], cfg(), INSTRUMENT);
    // Structural, not aspirational: the simulator's whole output is a value.
    expect(Object.keys(r).sort()).toEqual(
      ['barsWalked', 'equity', 'exposedBars', 'finalCash', 'finalPortfolioValue', 'skips', 'trades'].sort(),
    );
  });
});
