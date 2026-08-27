import { describe, expect, it } from 'vitest';
import {
  formatIst,
  isSameTradingDay,
  nextRollAt,
  tradingDayDate,
  tradingDayFor,
} from './trading-day';

/**
 * IST is UTC+05:30 with no DST, so every case here is expressible exactly.
 * `ist()` builds an instant from an IST wall-clock reading by subtracting the
 * offset, which is how a trader would describe the time in the first place.
 */
const ist = (isoLocal: string) => new Date(`${isoLocal}+05:30`);

describe('tradingDayFor — within a session', () => {
  it('pre-open belongs to that day', () => {
    expect(tradingDayFor(ist('2026-08-10T09:00:00'))).toBe('2026-08-10');
  });

  it('equity hours belong to that day', () => {
    expect(tradingDayFor(ist('2026-08-10T09:15:00'))).toBe('2026-08-10');
    expect(tradingDayFor(ist('2026-08-10T15:30:00'))).toBe('2026-08-10');
  });

  it('the thread stays open after equity close', () => {
    expect(tradingDayFor(ist('2026-08-10T17:00:00'))).toBe('2026-08-10');
  });

  it('commodities hours still belong to that day', () => {
    expect(tradingDayFor(ist('2026-08-10T23:30:00'))).toBe('2026-08-10');
    expect(tradingDayFor(ist('2026-08-10T23:55:00'))).toBe('2026-08-10');
  });
});

describe('tradingDayFor — across the 02:30 boundary', () => {
  it('just after midnight still belongs to the previous trading day', () => {
    expect(tradingDayFor(ist('2026-08-11T00:01:00'))).toBe('2026-08-10');
    expect(tradingDayFor(ist('2026-08-11T01:00:00'))).toBe('2026-08-10');
  });

  it('one minute before the roll still belongs to the previous day', () => {
    expect(tradingDayFor(ist('2026-08-11T02:29:59'))).toBe('2026-08-10');
  });

  it('the boundary minute itself starts the new day', () => {
    expect(tradingDayFor(ist('2026-08-11T02:30:00'))).toBe('2026-08-11');
  });

  it('after the roll belongs to the new day', () => {
    expect(tradingDayFor(ist('2026-08-11T02:31:00'))).toBe('2026-08-11');
    expect(tradingDayFor(ist('2026-08-11T09:15:00'))).toBe('2026-08-11');
  });
});

describe('tradingDayFor — calendar edges', () => {
  it('handles month rollover', () => {
    expect(tradingDayFor(ist('2026-09-01T01:00:00'))).toBe('2026-08-31');
    expect(tradingDayFor(ist('2026-09-01T03:00:00'))).toBe('2026-09-01');
  });

  it('handles year rollover', () => {
    expect(tradingDayFor(ist('2027-01-01T01:00:00'))).toBe('2026-12-31');
    expect(tradingDayFor(ist('2027-01-01T03:00:00'))).toBe('2027-01-01');
  });

  it('handles a leap day', () => {
    expect(tradingDayFor(ist('2028-03-01T01:00:00'))).toBe('2028-02-29');
  });
});

describe('tradingDayFor — input timezone independence', () => {
  it('agrees regardless of how the same instant is expressed', () => {
    // 2026-08-10 21:00 UTC === 2026-08-11 02:30 IST === the roll.
    const asUtc = new Date('2026-08-10T21:00:00.000Z');
    expect(tradingDayFor(asUtc)).toBe('2026-08-11');
    expect(tradingDayFor(ist('2026-08-11T02:30:00'))).toBe('2026-08-11');
    expect(asUtc.getTime()).toBe(ist('2026-08-11T02:30:00').getTime());
  });

  it('one millisecond before the roll is still the previous day', () => {
    expect(tradingDayFor(new Date('2026-08-10T20:59:59.999Z'))).toBe('2026-08-10');
  });
});

describe('tradingDayDate', () => {
  it('returns UTC midnight so a date-only column cannot drift a day', () => {
    const d = tradingDayDate(ist('2026-08-10T15:30:00'));
    expect(d.toISOString()).toBe('2026-08-10T00:00:00.000Z');
    expect(d.getUTCHours()).toBe(0);
  });
});

describe('isSameTradingDay', () => {
  it('spans midnight within one trading day', () => {
    expect(isSameTradingDay(ist('2026-08-10T23:50:00'), ist('2026-08-11T01:15:00'))).toBe(true);
  });

  it('separates across the roll', () => {
    expect(isSameTradingDay(ist('2026-08-11T02:29:00'), ist('2026-08-11T02:31:00'))).toBe(false);
  });
});

describe('nextRollAt', () => {
  it('is the next 02:30 IST after a daytime instant', () => {
    expect(nextRollAt(ist('2026-08-10T15:30:00')).toISOString()).toBe('2026-08-10T21:00:00.000Z');
  });

  it('is later the same morning when called just before the roll', () => {
    expect(nextRollAt(ist('2026-08-11T02:00:00')).toISOString()).toBe('2026-08-10T21:00:00.000Z');
  });

  it('is strictly in the future when called exactly at the roll', () => {
    const at = ist('2026-08-11T02:30:00');
    expect(nextRollAt(at).getTime()).toBeGreaterThan(at.getTime());
  });

  it('always produces an instant whose trading day is the day after the input’s', () => {
    for (const t of ['2026-08-10T09:15:00', '2026-08-10T23:59:00', '2026-08-11T01:00:00']) {
      const from = ist(t);
      const roll = nextRollAt(from);
      expect(roll.getTime()).toBeGreaterThan(from.getTime());
      expect(tradingDayFor(roll)).not.toBe(tradingDayFor(from));
    }
  });
});

describe('formatIst', () => {
  it('renders the IST wall clock', () => {
    expect(formatIst(new Date('2026-08-10T09:05:00.000Z'))).toBe('2026-08-10 14:35 IST');
  });
});
