import { describe, expect, it } from 'vitest';
import type { Candle } from '@tradew/types';
import {
  INDEX_FLAT_BAND_PCT,
  PREMIUM_FLAT_BAND_PCT,
  alignContracts,
  alignmentNotes,
  classifyAlignment,
  readLeg,
  readSeries,
  unreadableLeg,
} from './contract-alignment';
import { hasDirectiveLanguage } from '../vocabulary/vocabulary';

/**
 * The arithmetic behind the workspace's CE and PE panels.
 *
 * Two properties matter more than the rest and each has its own block below:
 *
 *  1. **A leg that could not be read never looks like a leg that did not
 *     move.** That collapse is how a dead bridge renders as a calm market.
 *  2. **Nothing this module emits is directive.** It is the only part of the
 *     observation pipeline that talks about specific contracts by strike and
 *     side, which is exactly where Rule 2 is easiest to breach by accident.
 */

/** A flat-then-move series: `closes` are the bar closes, opens follow them. */
function series(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    timestamp: new Date(Date.UTC(2026, 7, 25, 4, 15 + i * 15)),
    open: i === 0 ? closes[0] : closes[i - 1],
    high: Math.max(close, i === 0 ? closes[0] : closes[i - 1]),
    low: Math.min(close, i === 0 ? closes[0] : closes[i - 1]),
    close,
    volume: 1000,
  }));
}

describe('readSeries', () => {
  it('measures the move from the first open to the last close', () => {
    const read = readSeries(series([100, 105, 110]), PREMIUM_FLAT_BAND_PCT);
    expect(read).not.toBeNull();
    expect(read!.open).toBe(100);
    expect(read!.last).toBe(110);
    expect(read!.changePct).toBeCloseTo(10, 5);
    expect(read!.bars).toBe(3);
    expect(read!.direction).toBe('rising');
  });

  it('returns null for an empty series rather than a zeroed reading', () => {
    // A zeroed SeriesRead would render as "flat", i.e. a successful read of a
    // market that did not move — which is the opposite of no data.
    expect(readSeries([], PREMIUM_FLAT_BAND_PCT)).toBeNull();
    expect(readSeries(null, PREMIUM_FLAT_BAND_PCT)).toBeNull();
  });

  it('returns null when the opening price is unusable', () => {
    const broken = series([100, 105]);
    broken[0].open = 0;
    expect(readSeries(broken, PREMIUM_FLAT_BAND_PCT)).toBeNull();
  });

  it('uses a much wider flat band for premiums than for the index', () => {
    // The whole point of two bands: a 0.6% move is real drift on an index and
    // noise on an at-the-money weekly premium. One shared band would report
    // every leg as directional all day.
    expect(PREMIUM_FLAT_BAND_PCT).toBeGreaterThan(INDEX_FLAT_BAND_PCT);

    const smallMove = series([100, 100.6]);
    expect(readSeries(smallMove, INDEX_FLAT_BAND_PCT)!.direction).toBe('rising');
    expect(readSeries(smallMove, PREMIUM_FLAT_BAND_PCT)!.direction).toBe('flat');
  });
});

describe('a leg that could not be read is never a leg that did not move', () => {
  it('marks a failed read as unreadable, with the reason', () => {
    const leg = unreadableLeg('CE', 24_350, 'Dhan returned no candles.');
    expect(leg.series).toBeNull();
    expect(leg.unavailableReason).toBe('Dhan returned no candles.');
  });

  it('marks an empty candle set as unreadable rather than flat', () => {
    const leg = readLeg('PE', 24_350, []);
    expect(leg.series).toBeNull();
    expect(leg.unavailableReason).not.toBeNull();
  });

  it('marks a genuinely unmoved contract as read, and flat', () => {
    const leg = readLeg('PE', 24_350, series([80, 80.1, 80.05]));
    expect(leg.series?.direction).toBe('flat');
    expect(leg.unavailableReason).toBeNull();
  });
});

describe('classifyAlignment', () => {
  const rising = readSeries(series([100, 120]), PREMIUM_FLAT_BAND_PCT);
  const falling = readSeries(series([100, 80]), PREMIUM_FLAT_BAND_PCT);
  const flat = readSeries(series([100, 100.2]), PREMIUM_FLAT_BAND_PCT);
  const indexUp = readSeries(series([24_000, 24_200]), INDEX_FLAT_BAND_PCT);
  const indexDown = readSeries(series([24_200, 24_000]), INDEX_FLAT_BAND_PCT);
  const indexFlat = readSeries(series([24_000, 24_002]), INDEX_FLAT_BAND_PCT);

  it('is null when either leg is missing — one leg is not an alignment', () => {
    expect(classifyAlignment(indexUp, rising, null)).toBeNull();
    expect(classifyAlignment(indexUp, null, falling)).toBeNull();
    expect(classifyAlignment(null, rising, falling)).toBeNull();
  });

  it('names the call side when it rises with the index and the put does not', () => {
    expect(classifyAlignment(indexUp, rising, falling)).toBe('call-side-tracking');
    expect(classifyAlignment(indexUp, rising, flat)).toBe('call-side-tracking');
  });

  it('names the put side when it rises as the index falls and the call does not', () => {
    expect(classifyAlignment(indexDown, falling, rising)).toBe('put-side-tracking');
  });

  it('reports both legs gaining as a volatility reading, not a directional one', () => {
    // The trap this branch exists for: on a rising index with both legs bid,
    // the call is "rising with the index" and calling that confirmation would
    // read an IV expansion as directional agreement.
    expect(classifyAlignment(indexUp, rising, rising)).toBe('both-sides-bid');
  });

  it('reports both legs decaying together', () => {
    expect(classifyAlignment(indexUp, falling, falling)).toBe('both-sides-decaying');
  });

  it('declines to name a tracking leg when the index has no direction', () => {
    expect(classifyAlignment(indexFlat, rising, falling)).toBe('index-flat');
  });

  it('falls through to mixed rather than forcing a story', () => {
    // Index up, call flat, put falling: nothing is tracking, and the honest
    // answer is that nothing is tracking.
    expect(classifyAlignment(indexUp, flat, falling)).toBe('mixed');
  });
});

describe('alignContracts — the whole read', () => {
  it('carries the interval every series was read on', () => {
    const a = alignContracts({
      underlying: 'NIFTY',
      expiry: '2026-08-27',
      strike: 24_350,
      interval: '15m',
      indexCandles: series([24_000, 24_200]),
      ce: readLeg('CE', 24_350, series([100, 130])),
      pe: readLeg('PE', 24_350, series([100, 70])),
      contractsReadable: true,
    });

    expect(a.interval).toBe('15m');
    expect(a.alignment).toBe('call-side-tracking');
    expect(a.index?.bars).toBe(2);
    expect(a.contractsReadable).toBe(true);
  });

  it('separates "cannot read contracts at all" from "this leg failed"', () => {
    const noCapability = alignContracts({
      underlying: 'GOLD',
      expiry: null,
      strike: null,
      interval: '15m',
      indexCandles: series([7_100, 7_120]),
      ce: null,
      pe: null,
      contractsReadable: false,
    });
    expect(noCapability.contractsReadable).toBe(false);
    expect(noCapability.alignment).toBeNull();

    const legFailed = alignContracts({
      underlying: 'NIFTY',
      expiry: '2026-08-27',
      strike: 24_350,
      interval: '15m',
      indexCandles: series([24_000, 24_200]),
      ce: readLeg('CE', 24_350, series([100, 130])),
      pe: unreadableLeg('PE', 24_350, 'Dhan has no traded candles for this contract.'),
      contractsReadable: true,
    });
    expect(legFailed.contractsReadable).toBe(true);
    expect(legFailed.alignment).toBeNull();
    expect(legFailed.notes.join(' ')).toMatch(/could not be read/i);
  });

  it('still reads the underlying when the instrument has no options market', () => {
    const a = alignContracts({
      underlying: 'CRUDEOIL',
      expiry: null,
      strike: null,
      interval: '15m',
      indexCandles: series([6_100, 6_150]),
      ce: null,
      pe: null,
      contractsReadable: true,
    });
    expect(a.index).not.toBeNull();
    expect(a.notes[0]).toMatch(/underlying moved/i);
  });
});

/**
 * Rule 2 — Sentinel never recommends a trade.
 *
 * This module is the closest the observation pipeline gets to naming a
 * tradable instrument, so the guard belongs here rather than only at the
 * synthesis boundary. `hasDirectiveLanguage` is the same probe the synthesis
 * gate fails closed on.
 */
describe('no note is directive', () => {
  const cases: { label: string; ce: ReturnType<typeof readLeg>; pe: ReturnType<typeof readLeg>; index: number[] }[] = [
    { label: 'call tracking', ce: readLeg('CE', 24_350, series([100, 140])), pe: readLeg('PE', 24_350, series([100, 60])), index: [24_000, 24_300] },
    { label: 'put tracking', ce: readLeg('CE', 24_350, series([100, 60])), pe: readLeg('PE', 24_350, series([100, 140])), index: [24_300, 24_000] },
    { label: 'both bid', ce: readLeg('CE', 24_350, series([100, 140])), pe: readLeg('PE', 24_350, series([100, 130])), index: [24_000, 24_300] },
    { label: 'both decaying', ce: readLeg('CE', 24_350, series([100, 60])), pe: readLeg('PE', 24_350, series([100, 70])), index: [24_000, 24_300] },
    { label: 'index flat', ce: readLeg('CE', 24_350, series([100, 140])), pe: readLeg('PE', 24_350, series([100, 60])), index: [24_000, 24_001] },
    { label: 'leg unreadable', ce: readLeg('CE', 24_350, series([100, 140])), pe: unreadableLeg('PE', 24_350, 'no traded candles'), index: [24_000, 24_300] },
  ];

  it.each(cases)('$label produces no directive language', ({ ce, pe, index }) => {
    const a = alignContracts({
      underlying: 'NIFTY',
      expiry: '2026-08-27',
      strike: 24_350,
      interval: '15m',
      indexCandles: series(index),
      ce,
      pe,
      contractsReadable: true,
    });

    expect(a.notes.length).toBeGreaterThan(0);
    for (const note of a.notes) {
      expect(hasDirectiveLanguage(note), note).toBe(false);
    }
  });

  it('never emits a ranking or a superlative about the contracts', () => {
    // "Which strike is best" is a recommendation however it is phrased. The
    // strongest statement available is which leg MOVED with the underlying.
    const notes = alignmentNotes({
      index: readSeries(series([24_000, 24_300]), INDEX_FLAT_BAND_PCT),
      ce: readLeg('CE', 24_350, series([100, 140])),
      pe: readLeg('PE', 24_350, series([100, 60])),
      alignment: 'call-side-tracking',
      strike: 24_350,
      interval: '15m',
    });

    const text = notes.join(' ').toLowerCase();
    for (const banned of ['best', 'strongest', 'recommend', 'prefer', 'ideal', 'should']) {
      expect(text, banned).not.toContain(banned);
    }
  });
});
