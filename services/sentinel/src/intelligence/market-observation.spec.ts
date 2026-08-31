import type { Candle, OptionChainEntry } from '@tradew/types';
import { describe, expect, it } from 'vitest';
import { composeSnapshot, readOptionChain } from './market-intelligence.service';
import {
  FORBIDDEN_OBSERVATION_FIELDS,
  projectObservation,
  resolveInterval,
} from './market-observation';

/**
 * The observation projection — the surface Tara reads.
 *
 * Two properties are load-bearing and everything below is in service of them:
 *
 *  1. **Every number comes from the canonical `MarketSnapshot`.** Not from a
 *     second indicator implementation, and not from a language model. The tests
 *     assert equality against `composeSnapshot`'s own output rather than
 *     against literals, so a future divergence between what the engine computes
 *     and what the assistant is told fails here.
 *
 *  2. **A verdict cannot travel on this route.** `FORBIDDEN_OBSERVATION_FIELDS`
 *     names what the premium product owns; the projection must never carry any
 *     of it, however the snapshot upstream grows.
 */

const NOW = new Date(Date.UTC(2026, 7, 31, 6, 0));

/** A rising 15m series with real swings, so structure has something to read. */
function candles(count = 80, start = 24_000): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const wobble = i % 4 === 3 ? -12 : 10;
    const open = price;
    price += wobble;
    out.push({
      timestamp: new Date(Date.UTC(2026, 7, 31, 3, 45 + i * 15)),
      open,
      high: Math.max(open, price) + 5,
      low: Math.min(open, price) - 5,
      close: price,
      volume: 100_000 + i * 100,
    });
  }
  return out;
}

function chain(spot = 24_400): OptionChainEntry[] {
  const expiry = new Date(Date.UTC(2026, 8, 3));
  const out: OptionChainEntry[] = [];
  for (let strike = spot - 300; strike <= spot + 300; strike += 100) {
    out.push({
      strike,
      expiry,
      callOI: 100_000 + Math.max(0, strike - spot) * 12,
      putOI: 100_000 + Math.max(0, spot - strike) * 15,
      callVolume: 5_000,
      putVolume: 6_000,
      callIV: 13.5,
      putIV: 14.25,
      callLtp: Math.max(1, spot - strike + 120),
      putLtp: Math.max(1, strike - spot + 120),
    } as OptionChainEntry);
  }
  return out;
}

function snapshotOf(bars: Candle[], withChain = true) {
  const spot = bars[bars.length - 1]?.close ?? 0;
  return composeSnapshot('NIFTY', bars, null, {
    vix: 11.32,
    breadthRatio: 1.4,
    optionChain: withChain ? readOptionChain(chain(Math.round(spot / 100) * 100), spot) : null,
  });
}

function observe(bars: Candle[], opts: { withChain?: boolean; timeframe?: string } = {}) {
  const snapshot = snapshotOf(bars, opts.withChain ?? true);
  return {
    snapshot,
    observation: projectObservation({
      snapshot,
      timeframe: '15m',
      requestedTimeframe: opts.timeframe ?? '15m',
      now: NOW,
    }),
  };
}

describe('resolveInterval', () => {
  it('accepts every interval the engine can read, in the chart pill\'s casing', () => {
    for (const [input, expected] of [
      ['1m', '1m'],
      ['5m', '5m'],
      ['15m', '15m'],
      ['1H', '1h'],
      ['1h', '1h'],
      ['1D', '1d'],
      ['daily', '1d'],
      ['15 min', '15m'],
    ] as const) {
      const r = resolveInterval(input);
      expect(r.ok, input).toBe(true);
      if (r.ok) expect(r.interval).toBe(expected);
    }
  });

  it('maps the weekly pill onto daily bars AND says so, rather than silently substituting', () => {
    const r = resolveInterval('1W');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.interval).toBe('1d');
    // The note is the whole point: analysing different bars from the ones on
    // screen without saying so is the failure SNAPSHOT_INTERVAL exists to stop.
    expect(r.note).toMatch(/no weekly interval/i);
  });

  it('refuses an interval it cannot read, naming the ones it can', () => {
    const r = resolveInterval('4h');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('4h');
    expect(r.reason).toMatch(/1m, 5m, 15m/);
  });
});

describe('projectObservation — numbers come from the canonical snapshot', () => {
  it('carries the snapshot\'s own indicator values, unrounded and unrecomputed', () => {
    const { snapshot, observation } = observe(candles());

    // Identity, not approximation. If the projection ever recomputed anything,
    // these would drift and this test is where that shows up.
    expect(observation.indicators.rsi14).toBe(snapshot.rsi14);
    expect(observation.indicators.ema20).toBe(snapshot.ema20);
    expect(observation.indicators.ema50).toBe(snapshot.ema50);
    expect(observation.indicators.vwap).toBe(snapshot.vwap);
    expect(observation.indicators.macdHistogram).toBe(snapshot.macdHistogram);
    expect(observation.indicators.volumeVsAvg).toBe(snapshot.volumeVsAvg);
    expect(observation.indicators.realizedVolPct).toBe(snapshot.realizedVolPct);
    expect(observation.indicators.support).toBe(snapshot.support);
    expect(observation.indicators.resistance).toBe(snapshot.resistance);
    expect(observation.lastPrice).toBe(snapshot.lastPrice);

    // And they are real, not nulls that happen to match.
    expect(typeof observation.indicators.rsi14).toBe('number');
    expect(typeof observation.indicators.ema20).toBe('number');
    expect(typeof observation.indicators.vwap).toBe('number');
  });

  it('passes external measurements through verbatim', () => {
    const { observation } = observe(candles());
    expect(observation.indicators.vix).toBe(11.32);
    expect(observation.indicators.breadthRatio).toBe(1.4);
  });

  it('reports the timeframe it actually measured and the one that was asked for', () => {
    const { observation } = observe(candles(), { timeframe: '1W' });
    expect(observation.timeframe).toBe('15m');
    expect(observation.requestedTimeframe).toBe('1W');
    expect(observation.observedAt).toBe(NOW.toISOString());
  });

  it('stamps the market-event time of the newest bar, not only the server clock', () => {
    const bars = candles();
    const { observation } = observe(bars);
    expect(observation.barAt).toBe(bars[bars.length - 1].timestamp.toISOString());
    expect(observation.latestBar?.close).toBe(bars[bars.length - 1].close);
    expect(observation.latestBar?.volume).toBe(bars[bars.length - 1].volume);
  });
});

describe('projectObservation — freshness', () => {
  it('reports bar count, bar age and whether the read is within limits', () => {
    const { observation } = observe(candles());
    expect(observation.freshness.candles).toBe(80);
    expect(observation.freshness.newestBarAt).toBe(observation.barAt);
    expect(typeof observation.freshness.barAgeMinutes).toBe('number');
    expect(observation.freshness.checks.length).toBeGreaterThan(0);
  });

  it('fails the freshness gate — with a reason — on a thin history', () => {
    const { observation } = observe(candles(6));
    expect(observation.freshness.ok).toBe(false);
    expect(observation.freshness.reason).toBeTruthy();
  });
});

describe('projectObservation — structure and market state', () => {
  it('carries structure, liquidity, profile and regime where the bars support them', () => {
    const { observation } = observe(candles());

    expect(observation.structure).not.toBeNull();
    expect(['uptrend', 'downtrend', 'range', 'undefined']).toContain(observation.structure!.state);
    expect(observation.liquidity).not.toBeNull();
    expect(observation.trend).not.toBeNull();
    expect(observation.marketProfile).not.toBeNull();
    expect(observation.regime).not.toBeNull();
  });

  it('carries the index-direction votes and their measurements', () => {
    const { observation } = observe(candles());
    expect(observation.indexDirection).not.toBeNull();
    expect(observation.indexDirection!.votes.length).toBeGreaterThan(0);
    for (const vote of observation.indexDirection!.votes) {
      expect(vote.detail).toBeTruthy();
      expect(typeof vote.weight).toBe('number');
    }
  });

  it('never carries the aligned option side — that is an instruction, not a measurement', () => {
    const { observation } = observe(candles());
    expect(JSON.stringify(observation)).not.toContain('alignedOptionSide');
    expect(observation.indexDirection).not.toHaveProperty('side');
  });
});

describe('projectObservation — option chain', () => {
  it('carries PCR, max pain, OI walls and the at-the-money CE/PE row', () => {
    const { snapshot, observation } = observe(candles());

    expect(observation.optionChain).not.toBeNull();
    const oc = observation.optionChain!;
    expect(oc.pcr).toBe(snapshot.optionChain!.pcr);
    expect(oc.maxPain).toBe(snapshot.optionChain!.maxPain);
    expect(oc.strikesAnalysed).toBe(snapshot.optionChain!.strikesAnalysed);
    expect(oc.atm).not.toBeNull();
    expect(typeof oc.atm!.callOI).toBe('number');
    expect(typeof oc.atm!.putOI).toBe('number');
  });

  it('does not carry the full strike ladder — the aggregates plus ATM, not a chain dump', () => {
    const { observation } = observe(candles());
    expect(observation.optionChain).not.toHaveProperty('entries');
  });

  it('says explicitly when the instrument published no chain', () => {
    const { observation } = observe(candles(), { withChain: false });
    expect(observation.optionChain).toBeNull();
    expect(observation.unavailable.map((u) => u.field)).toContain('optionChain');
    expect(observation.unavailable.find((u) => u.field === 'optionChain')!.reason).toMatch(
      /no front-expiry option chain/i,
    );
  });
});

describe('projectObservation — CE/PE contract measurements', () => {
  it('carries both legs on the same bars when the caller read them', () => {
    const snapshot = snapshotOf(candles());
    const observation = projectObservation({
      snapshot,
      timeframe: '15m',
      requestedTimeframe: '15m',
      now: NOW,
      contracts: {
        underlying: 'NIFTY',
        expiry: '2026-09-03',
        strike: 24_400,
        interval: '15m',
        index: null,
        ce: {
          side: 'CE',
          strike: 24_400,
          series: { open: 120, last: 138, changePct: 15, direction: 'rising' } as never,
          unavailableReason: null,
        },
        pe: {
          side: 'PE',
          strike: 24_400,
          series: null,
          unavailableReason: 'the bridge declined this leg',
        },
        alignment: 'call-side-tracking',
        notes: ['CE is tracking the index'],
        contractsReadable: true,
        unreadableReason: null,
      },
    });

    expect(observation.contracts).not.toBeNull();
    expect(observation.contracts!.ce!.changePct).toBe(15);
    expect(observation.contracts!.ce!.direction).toBe('rising');
    // "Could not read" and "read nothing" are different sentences and never
    // share a field — the leg reports its reason rather than a zeroed move.
    expect(observation.contracts!.pe!.changePct).toBeNull();
    expect(observation.contracts!.pe!.unavailableReason).toBe('the bridge declined this leg');
    expect(observation.contracts!.alignment).toBe('call-side-tracking');
  });

  it('says the legs were not requested rather than implying there are none', () => {
    const { observation } = observe(candles());
    expect(observation.contracts).toBeNull();
    expect(observation.unavailable.find((u) => u.field === 'contracts')!.reason).toMatch(
      /not requested/i,
    );
  });
});

describe('projectObservation — missing measurements are explicit, never fabricated', () => {
  it('nulls what it cannot measure and names a reason for each', () => {
    const { observation } = observe(candles(3), { withChain: false });

    // A three-bar history supports none of these, and each says so.
    expect(observation.indicators.rsi14).toBeNull();
    expect(observation.indicators.macdHistogram).toBeNull();
    expect(observation.indicators.realizedVolPct).toBeNull();
    expect(observation.indicators.support).toBeNull();
    expect(observation.indicators.resistance).toBeNull();
    expect(observation.structure).toBeNull();
    expect(observation.liquidity).toBeNull();

    const fields = observation.unavailable.map((u) => u.field);
    for (const field of [
      'indicators.rsi14',
      'indicators.macdHistogram',
      'indicators.realizedVolPct',
      'indicators.support',
      'indicators.resistance',
      'structure',
      'liquidity',
    ]) {
      expect(fields, field).toContain(field);
    }
    for (const entry of observation.unavailable) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  /**
   * A pinned known behaviour, not an aspiration.
   *
   * `ema()` returns a series from whatever it is given rather than refusing, so
   * a 50-period EMA over three bars is arithmetically real and economically
   * meaningless — the exact case `DEFAULT_MIN_CANDLES`'s docblock describes.
   * The engine's answer to that is the FRESHNESS GATE, not a second threshold
   * inside the indicator, and the projection must therefore make the gate's
   * verdict impossible to miss. Inventing a bar-count rule here would put a
   * fourth opinion about "enough history" in the repository.
   */
  it('reports an EMA off a thin history, and fails freshness so the reader knows why to distrust it', () => {
    const { observation } = observe(candles(3), { withChain: false });
    expect(observation.indicators.ema50).not.toBeNull();
    expect(observation.freshness.ok).toBe(false);
    expect(observation.freshness.candles).toBe(3);
    expect(observation.freshness.reason).toBeTruthy();
  });

  it('never substitutes zero for an unmeasured value', () => {
    const { observation } = observe(candles(3), { withChain: false });
    for (const [key, value] of Object.entries(observation.indicators)) {
      if (value === null) continue;
      // The only way a measurement is absent is `null`. A 0 that means
      // "unmeasured" is indistinguishable from a real 0 once it leaves here.
      expect(value, key).not.toBe(0);
    }
  });

  it('reports CPR as unavailable when there is no prior daily bar', () => {
    const { observation } = observe(candles());
    expect(observation.indicators.cpr).toBeNull();
    expect(observation.unavailable.find((u) => u.field === 'indicators.cpr')!.reason).toMatch(
      /prior completed daily bar/i,
    );
  });
});

describe('projectObservation — the premium boundary', () => {
  it('carries none of Sentinel\'s verdict fields', () => {
    const { observation } = observe(candles());
    for (const field of FORBIDDEN_OBSERVATION_FIELDS) {
      expect(observation, field).not.toHaveProperty(field);
    }
  });

  it('carries no verdict field ANYWHERE in the serialized payload', () => {
    const { observation } = observe(candles());
    const wire = JSON.stringify(observation);
    // Nested too: a verdict smuggled inside `marketProfile` or a vote's detail
    // would be just as much of a leak as one at the top level.
    for (const field of ['sideInFocus', 'strategyAdvice', 'publication', 'synthesis']) {
      expect(wire, field).not.toContain(field);
    }
  });

  it('carries no strike selection, entry, target or stop', () => {
    const { observation } = observe(candles());
    const wire = JSON.stringify(observation).toLowerCase();
    for (const word of ['"selectedstrike"', '"entryprice"', '"target"', '"stoploss"', '"recommendation"']) {
      expect(wire, word).not.toContain(word);
    }
  });
});
