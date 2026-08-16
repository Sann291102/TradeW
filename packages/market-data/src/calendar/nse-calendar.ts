/**
 * NSE trading-day calendar — the one list of days the exchange is open.
 *
 * ## Why this lives in a package
 *
 * It started in `services/api/src/discipline/market-calendar.ts`, written for
 * the discipline panel, carrying a `TODO(clock-unification)` naming the two
 * other places that needed it:
 *
 *   - `services/api/src/sim/ist-time.util.ts#todayIstSessionEnd`
 *   - `services/sentinel/src/market-clock.ts#isMarketOpen`
 *
 * Sentinel's clock in particular was weekday AND holiday blind, so it believed
 * the market was open at 10:30 on a Saturday and on Republic Day — a gap
 * `market-clock.spec.ts` pinned deliberately rather than fixed. Copying the
 * list into Sentinel would have made three copies of a table that changes once
 * a year, which is how two runtimes start disagreeing about whether today is a
 * trading day at all. `@tradew/market-data` is already a dependency of
 * `services/api`, `services/market-data` and `services/sentinel`, so it is the
 * only place all three can read one list from.
 *
 * `services/api/src/discipline/market-calendar.ts` now re-exports this module
 * and keeps its own name; every existing importer there is unchanged.
 *
 * ## What this module does NOT own
 *
 * Session *hours*. A trading day is a property of the exchange calendar; the
 * 09:15–15:30 window is a property of a segment (MCX runs to ~23:30) and stays
 * with each runtime's own clock. This module answers "does the exchange trade
 * on this date", nothing about the time of day.
 *
 * A checked-in constant rather than a table: the list changes once a year when
 * NSE publishes its circular, and a table would need a seed step the deploy
 * pipeline does not currently run (`.github/workflows/deploy.yml` runs
 * `prisma migrate deploy` only).
 */

/**
 * NSE trading holidays, IST calendar days as 'YYYY-MM-DD'.
 *
 * Full-day equity-segment closures only. Muhurat / special live sessions are
 * NOT listed — they are trading days, and a trader who opens the app for one
 * should get a session like any other day.
 *
 * Weekday closures only. Holidays that fall on a Saturday or Sunday in 2026 —
 * Mahashivratri (15 Feb, Sun), Id-Ul-Fitr (21 Mar, Sat) and Independence Day
 * (15 Aug, Sat) — are deliberately absent: `isWeekend` already closes those
 * days, and listing them would imply this file is the reason the market is
 * shut.
 *
 * Asserted by `services/api/src/discipline/market-calendar.spec.ts` (which now
 * runs against the re-exports of this module) and, for the Python port, by
 * `services/sentinel-py/tests/test_calendar.py`. This package has no test
 * runner of its own — `npm test -w @tradew/market-data` runs the binary-parser
 * verifier — so those two are where the list is actually guarded.
 *
 * !! UNVERIFIED AGAINST THE OFFICIAL CIRCULAR !!
 * These dates were derived from the usual Indian holiday calendar, not read
 * off NSE's published 2026 trading-holiday circular. Several are lunar and
 * move year to year (Holi, Ram Navami, Bakri Id, Muharram, Dussehra, Diwali),
 * and Diwali Balipratipada in particular is the kind of date that shifts by a
 * day. Reconcile this list against the circular before launch.
 *
 * The cost of a wrong date is now higher than it was when this list only fed
 * the discipline panel: Sentinel's watch and observation gate on it, so a
 * missing holiday spends metered Dhan calls on a closed market and a spurious
 * one makes Sentinel silent on a day it should be watching.
 */
export const NSE_HOLIDAYS_2026: readonly string[] = [
  '2026-01-26', // Republic Day (Mon)
  '2026-03-03', // Holi (Tue)
  '2026-03-26', // Shri Ram Navami (Thu)
  '2026-03-31', // Mahavir Jayanti (Tue)
  '2026-04-03', // Good Friday (Fri)
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti (Tue)
  '2026-05-01', // Maharashtra Day (Fri)
  '2026-05-27', // Bakri Id (Wed)
  '2026-06-26', // Muharram (Fri)
  '2026-08-26', // Ganesh Chaturthi (Wed)
  '2026-10-02', // Mahatma Gandhi Jayanti (Fri)
  '2026-10-20', // Dussehra (Tue)
  '2026-11-09', // Diwali Laxmi Pujan (Mon)
  '2026-11-10', // Diwali Balipratipada (Tue)
  '2026-11-24', // Guru Nanak Jayanti (Tue)
  '2026-12-25', // Christmas (Fri)
] as const;

/**
 * Every year's holidays, keyed by year. Adding 2027 is one entry here, and
 * every caller picks it up — `isTradingDay` reads this map, never the 2026
 * constant directly.
 */
const HOLIDAYS_BY_YEAR: Record<string, readonly string[]> = {
  '2026': NSE_HOLIDAYS_2026,
};

const IST_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 'YYYY-MM-DD' in IST — the trading-day key used everywhere in this module. */
export function istDateKey(at: Date = new Date()): string {
  return IST_DATE.format(at);
}

/**
 * IST weekday index, 0 = Sunday. Derived from the IST date key rather than
 * `Date#getDay`, which would answer for the server's zone — on a UTC host,
 * 22:00 Saturday UTC is already Sunday in IST.
 */
export function istWeekday(at: Date = new Date()): number {
  const [y, m, d] = istDateKey(at).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWeekend(at: Date = new Date()): boolean {
  const day = istWeekday(at);
  return day === 0 || day === 6;
}

/**
 * True when `dateKey` ('YYYY-MM-DD', IST) is a published NSE holiday.
 *
 * A year with no entry in `HOLIDAYS_BY_YEAR` returns false — unknown is treated
 * as "trading day". That is the safe direction: the worst case is a service
 * observing a market that was actually shut, which wastes cached calls. The
 * opposite default would silently stop Sentinel watching for a whole year the
 * moment the calendar went stale, and a system that has gone quiet looks
 * identical to a system with nothing to say.
 */
export function isHoliday(dateKey: string): boolean {
  const year = dateKey.slice(0, 4);
  return (HOLIDAYS_BY_YEAR[year] ?? []).includes(dateKey);
}

/** True when `at` falls on an NSE equity trading day (weekday, not a holiday). */
export function isTradingDay(at: Date = new Date()): boolean {
  return !isWeekend(at) && !isHoliday(istDateKey(at));
}

/** True when the calendar has an entry for this date's year at all. */
export function hasCalendarFor(at: Date = new Date()): boolean {
  return HOLIDAYS_BY_YEAR[istDateKey(at).slice(0, 4)] !== undefined;
}

/**
 * Why a date is not a trading day, or null when it is one.
 *
 * Exists because "Sentinel is not observing" needs a reason a user can read.
 * A weekend and a holiday are different sentences — one is obvious to the
 * trader looking at the screen, the other is the thing they may have forgotten.
 */
export function nonTradingReason(at: Date = new Date()): 'weekend' | 'holiday' | null {
  if (isWeekend(at)) return 'weekend';
  if (isHoliday(istDateKey(at))) return 'holiday';
  return null;
}

/** The UTC instant of 00:00 IST on the given 'YYYY-MM-DD' (IST) day. IST has
 *  no DST, so this offset is exact and constant year-round — `Date.UTC`'s
 *  negative-argument normalization does the rest, no manual carry needed.
 *  Exported: this is the one correct way to turn an IST date key back into a
 *  real instant, and PerformanceService's day-boundary queries need exactly
 *  that (see its `dayBoundsUtc`) — reused rather than re-derived. */
export function istMidnightUtc(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, -5, -30, 0));
}

/**
 * The next NSE trading day strictly after `at` — used for T+1-style
 * settlement dates (see SettlementService). Always at least one full
 * calendar day out, even when `at` itself is a trading day: settlement is
 * never same-day. Walks forward in IST calendar days (via `istMidnightUtc`,
 * not `Date#setDate`, which would step in the host's local zone and could
 * misalign with the IST day boundary on a non-IST server — the same class of
 * bug this module exists to prevent, see the module docstring).
 */
export function nextTradingDay(at: Date = new Date()): Date {
  let cursor = istMidnightUtc(istDateKey(at));
  do {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  } while (!isTradingDay(cursor));
  return cursor;
}
