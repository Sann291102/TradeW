import { describe, it, expect } from 'vitest';
import type { DhanOptionChain } from '@/lib/dhanLiveFeed';
import {
  ceRows,
  peRows,
  formatLtp,
  nearestStrikeIndex,
  pickNearestExpiry,
  strikeOptionLabel,
} from './optionChain';

function leg(ltp: number) {
  return {
    ltp,
    previousClose: ltp,
    oi: 0,
    previousOi: 0,
    volume: 0,
    previousVolume: 0,
    iv: 0,
    bid: 0,
    ask: 0,
    delta: null,
    theta: null,
    gamma: null,
    vega: null,
  };
}

const CHAIN: DhanOptionChain = {
  spot: 24337,
  strikes: [
    { strike: 24300, ce: leg(160.5), pe: leg(45.25) },
    { strike: 24250, ce: leg(195.0), pe: leg(32.0) },
    { strike: 24350, ce: leg(128.75), pe: leg(62.5) },
    { strike: 24400, ce: leg(101.0), pe: null },
  ],
};

describe('pickNearestExpiry', () => {
  it('returns the earliest valid ISO date without a today reference', () => {
    expect(pickNearestExpiry(['2026-08-14', '2026-07-31', '2026-08-07'])).toBe('2026-07-31');
  });
  it('drops past dates when today is known', () => {
    expect(pickNearestExpiry(['2026-07-10', '2026-07-31', '2026-08-07'], '2026-07-30')).toBe('2026-07-31');
  });
  it('falls back to the last date when all are past', () => {
    expect(pickNearestExpiry(['2026-07-01', '2026-07-10'], '2026-07-30')).toBe('2026-07-10');
  });
  it('ignores malformed entries and returns null when nothing valid', () => {
    expect(pickNearestExpiry(['not-a-date', ''])).toBeNull();
  });
});

describe('nearestStrikeIndex', () => {
  it('finds the ATM strike after sorting is applied by ceRows', () => {
    const rows = ceRows(CHAIN); // sorted ascending: 24250,24300,24350,24400
    const idx = nearestStrikeIndex(rows, 24337);
    expect(rows[idx].strike).toBe(24350);
  });
  it('returns the middle when spot is unknown', () => {
    expect(nearestStrikeIndex([{ strike: 1 }, { strike: 2 }, { strike: 3 }], null)).toBe(1);
  });
  it('returns -1 for an empty ladder', () => {
    expect(nearestStrikeIndex([], 100)).toBe(-1);
  });
});

describe('ceRows / peRows', () => {
  it('ceRows returns strike + ltp ascending', () => {
    const rows = ceRows(CHAIN);
    expect(rows.map((r) => r.strike)).toEqual([24250, 24300, 24350, 24400]);
    expect(rows[1].ltp).toBe(160.5);
  });
  it('peRows carries null ltp when a leg is missing', () => {
    const rows = peRows(CHAIN);
    const missing = rows.find((r) => r.strike === 24400);
    expect(missing?.ltp).toBeNull();
  });
  it('empty/null chain yields no rows', () => {
    expect(ceRows(null)).toEqual([]);
    expect(peRows({ spot: null, strikes: [] })).toEqual([]);
  });
});

describe('formatLtp / strikeOptionLabel', () => {
  it('formats a price with two decimals', () => {
    expect(formatLtp(128.7)).toBe('128.70');
  });
  it('shows an em-dash for a missing price (never a fake 0.00)', () => {
    expect(formatLtp(null)).toBe('—');
    expect(formatLtp(Number.NaN)).toBe('—');
  });
  it('builds a compact "strike · ltp" label', () => {
    expect(strikeOptionLabel({ strike: 24350, ltp: 128.75 })).toBe('24350 · 128.75');
    expect(strikeOptionLabel({ strike: 24400, ltp: null })).toBe('24400 · —');
  });
});
