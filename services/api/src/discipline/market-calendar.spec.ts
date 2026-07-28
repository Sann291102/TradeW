import { describe, expect, it } from 'vitest';
import {
  NSE_HOLIDAYS_2026,
  hasCalendarFor,
  isHoliday,
  isTradingDay,
  isWeekend,
  istDateKey,
  istWeekday,
} from './market-calendar';

/**
 * The calendar is IST-anchored. These tests deliberately use UTC instants
 * around the IST day boundary, because that is where a server in another zone
 * gets the answer wrong — and the CI/production hosts are UTC.
 */

describe('istDateKey', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(istDateKey(new Date('2026-07-27T06:00:00.000Z'))).toBe('2026-07-27');
  });

  it('rolls to the next IST day at 18:30 UTC, not at UTC midnight', () => {
    // IST is UTC+5:30, so 18:29:59Z is still the 27th in Mumbai and 18:30:00Z
    // is already the 28th. A UTC-based key would place both on the 27th.
    expect(istDateKey(new Date('2026-07-27T18:29:59.000Z'))).toBe('2026-07-27');
    expect(istDateKey(new Date('2026-07-27T18:30:00.000Z'))).toBe('2026-07-28');
  });
});

describe('istWeekday / isWeekend', () => {
  it('reads the weekday in IST, not the host zone', () => {
    // 2026-08-01 is a Saturday. 22:00Z on Friday the 31st is already Saturday
    // in IST — a host using Date#getDay would still say Friday and let a
    // discipline session open on a closed market.
    expect(istWeekday(new Date('2026-07-31T22:00:00.000Z'))).toBe(6);
    expect(isWeekend(new Date('2026-07-31T22:00:00.000Z'))).toBe(true);
  });

  it('identifies Sunday and Saturday, and no other day', () => {
    expect(isWeekend(new Date('2026-08-02T06:00:00.000Z'))).toBe(true); // Sunday
    expect(isWeekend(new Date('2026-08-01T06:00:00.000Z'))).toBe(true); // Saturday
    expect(isWeekend(new Date('2026-07-31T06:00:00.000Z'))).toBe(false); // Friday
    expect(isWeekend(new Date('2026-08-03T06:00:00.000Z'))).toBe(false); // Monday
  });
});

describe('isHoliday', () => {
  it('matches published NSE closures', () => {
    expect(isHoliday('2026-01-26')).toBe(true); // Republic Day
    expect(isHoliday('2026-12-25')).toBe(true); // Christmas
  });

  it('does not match ordinary trading days', () => {
    expect(isHoliday('2026-07-27')).toBe(false);
  });

  it('treats an unknown year as trading days rather than silently closing it', () => {
    // The safe direction: a stale calendar shows the panel on a shut market
    // (costs seconds) instead of hiding it for a whole year (costs the feature).
    expect(isHoliday('2031-01-26')).toBe(false);
    expect(hasCalendarFor(new Date('2031-01-26T06:00:00.000Z'))).toBe(false);
    expect(hasCalendarFor(new Date('2026-01-26T06:00:00.000Z'))).toBe(true);
  });
});

describe('isTradingDay', () => {
  it('accepts an ordinary weekday', () => {
    expect(isTradingDay(new Date('2026-07-27T06:00:00.000Z'))).toBe(true); // Monday
  });

  it('rejects weekends', () => {
    expect(isTradingDay(new Date('2026-08-01T06:00:00.000Z'))).toBe(false);
  });

  it('rejects a weekday holiday', () => {
    // 2026-01-26 is a Monday AND Republic Day — the case weekday-only logic misses.
    expect(istWeekday(new Date('2026-01-26T06:00:00.000Z'))).toBe(1);
    expect(isTradingDay(new Date('2026-01-26T06:00:00.000Z'))).toBe(false);
  });

  it('uses the IST day when deciding, at the zone boundary', () => {
    // 18:30Z on Sunday 2026-01-25 is Monday the 26th in IST — Republic Day.
    expect(isTradingDay(new Date('2026-01-25T18:30:00.000Z'))).toBe(false);
  });
});

describe('NSE_HOLIDAYS_2026', () => {
  it('is well-formed, sorted, and free of duplicates', () => {
    const list = [...NSE_HOLIDAYS_2026];
    expect(list.every((d) => /^2026-\d{2}-\d{2}$/.test(d))).toBe(true);
    expect(new Set(list).size).toBe(list.length);
    expect(list).toEqual([...list].sort());
  });

  it('lists no weekend dates — those are already covered by isWeekend', () => {
    const weekendEntries = NSE_HOLIDAYS_2026.filter((d) => isWeekend(new Date(`${d}T06:00:00.000Z`)));
    expect(weekendEntries).toEqual([]);
  });
});
