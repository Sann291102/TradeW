/**
 * Venue sessions — the properties whose absence is SILENT.
 *
 * Every assertion here corresponds to a failure that produces no error, no log
 * line and no visibly wrong screen — only a market that quietly does not trade,
 * or one that trades when its exchange is shut.
 *
 * Lives in `services/api` for the same reason `market-calendar.spec.ts` does:
 * `@tradew/market-data` has no test runner of its own, and this config's
 * `include` is an allowlist, so the suite is registered there deliberately.
 */

import { describe, expect, it } from 'vitest';
import {
  MARKET_VENUES,
  isVenueOpen,
  isVenueTradingDay,
  venueClosedReason,
  venueDayKey,
  venueForExchangeSegment,
  venueMinutesToClose,
  venueRequiresEodFlatten,
  venueSession,
} from '@tradew/market-data';

/** A UTC instant for the given IST wall-clock time. IST is UTC+5:30, no DST. */
function ist(dateKey: string, hh: number, mm: number): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 5, mm - 30, 0));
}

// 2026-09-07 is a Monday and not an NSE holiday.
const MONDAY = '2026-09-07';
// 2026-09-12 is a Saturday.
const SATURDAY = '2026-09-12';
// Republic Day 2026 — a Monday, and a published NSE holiday.
const HOLIDAY = '2026-01-26';

describe('venue sessions', () => {
  describe('MCX is not NSE — the bug this module exists to fix', () => {
    it('is open at 18:00 IST, when NSE has been closed for hours', () => {
      const at = ist(MONDAY, 18, 0);
      // THE REGRESSION GUARD. `live-feed-server.ts` stamped every quote —
      // commodities included — with an NSE-only session, so GOLD reported
      // `closed` from 15:30 and `execution-fill.ts` refused every fill after
      // it. Two thirds of the MCX session, lost silently.
      expect(isVenueOpen('MCX', at)).toBe(true);
      expect(isVenueOpen('NSE', at)).toBe(false);
    });

    it('opens at 09:00, fifteen minutes before NSE', () => {
      const at = ist(MONDAY, 9, 5);
      expect(isVenueOpen('MCX', at)).toBe(true);
      expect(isVenueOpen('NSE', at)).toBe(false);
    });

    it('closes at 23:30 IST', () => {
      expect(isVenueOpen('MCX', ist(MONDAY, 23, 29))).toBe(true);
      expect(isVenueOpen('MCX', ist(MONDAY, 23, 45))).toBe(false);
    });

    it('still observes weekends and the holiday calendar', () => {
      // MCX borrowing the NSE holiday list is an approximation, and the
      // direction of the error matters: it errs toward CLOSED. Pinned so a
      // future change that flips it to `calendar: 'none'` is a deliberate act.
      expect(isVenueOpen('MCX', ist(SATURDAY, 18, 0))).toBe(false);
      expect(isVenueOpen('MCX', ist(HOLIDAY, 18, 0))).toBe(false);
    });
  });

  describe('continuous venues have no session at all', () => {
    it('is open on a Sunday, on a holiday, and at 03:00', () => {
      expect(isVenueOpen('BINANCE', ist(SATURDAY, 3, 0))).toBe(true);
      expect(isVenueOpen('BINANCE', ist(HOLIDAY, 3, 0))).toBe(true);
      expect(isVenueTradingDay('BINANCE', ist(SATURDAY, 3, 0))).toBe(true);
    });

    it('reports no closed reason, ever', () => {
      expect(venueClosedReason('BINANCE', ist(SATURDAY, 3, 0))).toBeNull();
    });

    it('returns null minutes-to-close rather than a number', () => {
      // Null forces the caller to handle "there is no close". Infinity — or
      // worse, a midnight boundary — would sail through arithmetic and
      // schedule a square-off for an instrument that never closes.
      expect(venueMinutesToClose('BINANCE', ist(MONDAY, 12, 0))).toBeNull();
      expect(venueMinutesToClose('NSE', ist(MONDAY, 15, 0))).toBe(30);
    });

    it('does not require an end-of-day flatten', () => {
      expect(venueRequiresEodFlatten('BINANCE')).toBe(false);
      expect(venueRequiresEodFlatten('NSE')).toBe(true);
      expect(venueRequiresEodFlatten('MCX')).toBe(true);
    });
  });

  describe('the day boundary is per venue, not globally IST', () => {
    it('rolls crypto at UTC midnight, not at the IST session close', () => {
      // 2026-09-08 01:00 IST is still 2026-09-07 in UTC. A BTC agent's daily
      // order counter and loss limit must roll with the venue's own day, or
      // they reset in the middle of the most active US hours.
      const at = ist('2026-09-08', 1, 0);
      expect(venueDayKey('NSE', at)).toBe('2026-09-08');
      expect(venueDayKey('BINANCE', at)).toBe('2026-09-07');
    });

    it('keeps Indian venues on the IST day', () => {
      const at = ist(MONDAY, 22, 0);
      expect(venueDayKey('NSE', at)).toBe(MONDAY);
      expect(venueDayKey('MCX', at)).toBe(MONDAY);
    });
  });

  describe('closed reasons are distinguishable', () => {
    it('separates weekend, holiday and outside-hours', () => {
      expect(venueClosedReason('NSE', ist(SATURDAY, 11, 0))).toBe('weekend');
      expect(venueClosedReason('NSE', ist(HOLIDAY, 11, 0))).toBe('holiday');
      expect(venueClosedReason('NSE', ist(MONDAY, 20, 0))).toBe('outside-hours');
      expect(venueClosedReason('NSE', ist(MONDAY, 11, 0))).toBeNull();
    });
  });

  describe('segment mapping', () => {
    it('routes MCX_COMM to MCX and everything else to its own venue', () => {
      // `dhan.catalogue.ts` maps `MCX_COMM: 'NSE'`, which is how a commodity
      // ends up on an equity session in the first place.
      expect(venueForExchangeSegment('MCX_COMM')).toBe('MCX');
      expect(venueForExchangeSegment('NSE_EQ')).toBe('NSE');
      expect(venueForExchangeSegment('IDX_I')).toBe('NSE');
      expect(venueForExchangeSegment('BSE_FNO')).toBe('BSE');
    });
  });

  describe('every declared venue is well-formed', () => {
    it('gives session venues a window and continuous venues none', () => {
      for (const venue of MARKET_VENUES) {
        const spec = venueSession(venue);
        if (spec.kind === 'continuous') {
          expect(spec.openMinute).toBeNull();
          expect(spec.closeMinute).toBeNull();
        } else {
          expect(spec.openMinute).not.toBeNull();
          expect(spec.closeMinute).not.toBeNull();
          expect(spec.closeMinute!).toBeGreaterThan(spec.openMinute!);
        }
        expect(spec.label.length).toBeGreaterThan(0);
      }
    });
  });
});
