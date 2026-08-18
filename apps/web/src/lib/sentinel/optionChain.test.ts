import { describe, it, expect } from 'vitest';
import type { DhanOptionChain } from '@/lib/dhanLiveFeed';
import {
  ceRows,
  peRows,
  filterStrikes,
  formatLtp,
  isListedStrike,
  nearestStrikeIndex,
  pickNearestExpiry,
  resolveTypedStrike,
  strikeOptionLabel,
  strikeWindow,
  STRIKE_WINDOW_SIZE,
  type StrikeRow,
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

  describe('hysteresis around a strike boundary', () => {
    // 50-point ladder; the raw midpoint between 24300 and 24350 is 24325, and
    // the hysteresis band is a quarter step (12.5 points) past it.
    const ladder = [{ strike: 24250 }, { strike: 24300 }, { strike: 24350 }, { strike: 24400 }];

    it('holds the incumbent while spot dithers just past the midpoint', () => {
      // 24326 is nearer 24350, but not by enough to move off 24300.
      expect(ladder[nearestStrikeIndex(ladder, 24326, 24300)].strike).toBe(24300);
      expect(ladder[nearestStrikeIndex(ladder, 24324, 24350)].strike).toBe(24350);
    });

    it('moves once spot clears the band', () => {
      // 24340 is 15 points nearer 24350 than 24300 — past the 12.5 threshold.
      expect(ladder[nearestStrikeIndex(ladder, 24340, 24300)].strike).toBe(24350);
    });

    it('picks the plain nearest strike with no incumbent', () => {
      expect(ladder[nearestStrikeIndex(ladder, 24326)].strike).toBe(24350);
    });

    it('falls back to nearest when the incumbent has left the ladder', () => {
      expect(ladder[nearestStrikeIndex(ladder, 24326, 23000)].strike).toBe(24350);
    });

    it('falls back to nearest when there is no measurable step', () => {
      expect(nearestStrikeIndex([{ strike: 24300 }], 24326, 24300)).toBe(0);
    });
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

// ─────────────────────────────────────────────────────────────────────────────
// The default six-strike window, pinned to the example in the brief.
// ─────────────────────────────────────────────────────────────────────────────

/** A NIFTY-shaped ladder in 50-point steps, ascending, as the bridge returns. */
function ladder(from: number, to: number, step = 50): StrikeRow[] {
  const rows: StrikeRow[] = [];
  for (let s = from; s <= to; s += step) rows.push({ strike: s, ltp: 100 });
  return rows;
}

describe('strikeWindow', () => {
  it('offers exactly the six strikes the brief names at spot 24500', () => {
    // "If market is at 24500 I need these strikes dropdowns can be selected
    //  24350,24400,24450,24500,24550,24600" — three below the ATM, the ATM,
    // two above.
    const rows = ladder(24000, 25000);
    const atm = rows.findIndex((r) => r.strike === 24500);
    expect(strikeWindow(rows, atm).map((r) => r.strike)).toEqual([24350, 24400, 24450, 24500, 24550, 24600]);
  });

  it('gives BOTH sides the same window — the brief specified one list for CE and PE', () => {
    const ce = ladder(24000, 25000);
    const pe = ladder(24000, 25000);
    const atm = ce.findIndex((r) => r.strike === 24500);
    expect(strikeWindow(ce, atm).map((r) => r.strike)).toEqual(strikeWindow(pe, atm).map((r) => r.strike));
  });

  it('slides at the ladder edges rather than returning a short list', () => {
    const rows = ladder(24000, 25000);
    expect(strikeWindow(rows, 0)).toHaveLength(STRIKE_WINDOW_SIZE);
    expect(strikeWindow(rows, 0).map((r) => r.strike)).toEqual([24000, 24050, 24100, 24150, 24200, 24250]);
    expect(strikeWindow(rows, rows.length - 1)).toHaveLength(STRIKE_WINDOW_SIZE);
    expect(strikeWindow(rows, rows.length - 1).map((r) => r.strike)).toEqual([
      24750, 24800, 24850, 24900, 24950, 25000,
    ]);
  });

  it('never pads a short ladder with strikes that do not trade', () => {
    const rows = ladder(24000, 24150);
    expect(strikeWindow(rows, 1)).toEqual(rows);
  });

  it('falls back to the middle of the ladder for an unresolved ATM index', () => {
    const rows = ladder(24000, 25000);
    expect(strikeWindow(rows, -1)).toHaveLength(STRIKE_WINDOW_SIZE);
    expect(strikeWindow([], -1)).toEqual([]);
  });
});

describe('filterStrikes', () => {
  const rows = ladder(24000, 25000);

  it('matches on any run of digits, not just a prefix', () => {
    expect(filterStrikes(rows, '445').map((r) => r.strike)).toEqual([24450]);
    expect(filterStrikes(rows, '244').map((r) => r.strike)).toContain(24400);
  });

  it('ignores separators and stray characters a trader might type', () => {
    expect(filterStrikes(rows, '24,450').map((r) => r.strike)).toEqual([24450]);
    expect(filterStrikes(rows, '24450 CE').map((r) => r.strike)).toEqual([24450]);
  });

  it('returns nothing for an empty query — the caller shows the default window', () => {
    expect(filterStrikes(rows, '')).toEqual([]);
    expect(filterStrikes(rows, '  ')).toEqual([]);
  });
});

describe('resolveTypedStrike', () => {
  const rows = ladder(24000, 25000);

  it('accepts a strike that is genuinely listed', () => {
    const r = resolveTypedStrike(rows, '24450');
    expect(r.ok).toBe(true);
    expect(r.ok && r.row.strike).toBe(24450);
  });

  it('REJECTS an unlisted strike rather than snapping to the nearest', () => {
    // 24337 sits between 24300 and 24350. Silently choosing either would put
    // the watch on a contract the operator never picked.
    const r = resolveTypedStrike(rows, '24337');
    expect(r).toEqual({ ok: false, reason: 'not-listed' });
  });

  it('separates "not a number", "nothing typed" and "no ladder loaded"', () => {
    expect(resolveTypedStrike(rows, 'abc')).toEqual({ ok: false, reason: 'not-a-number' });
    expect(resolveTypedStrike(rows, '')).toEqual({ ok: false, reason: 'empty' });
    expect(resolveTypedStrike([], '24450')).toEqual({ ok: false, reason: 'no-ladder' });
  });

  it('resolves against the side it was given — a CE ladder cannot yield a PE-only strike', () => {
    const ce = ladder(24000, 24500);
    const pe = ladder(24000, 25000);
    expect(resolveTypedStrike(ce, '24900')).toEqual({ ok: false, reason: 'not-listed' });
    expect(resolveTypedStrike(pe, '24900').ok).toBe(true);
  });
});

describe('isListedStrike', () => {
  it('is false for null and for a strike absent from the ladder', () => {
    const rows = ladder(24000, 24200);
    expect(isListedStrike(rows, null)).toBe(false);
    expect(isListedStrike(rows, 24337)).toBe(false);
    expect(isListedStrike(rows, 24100)).toBe(true);
  });
});
