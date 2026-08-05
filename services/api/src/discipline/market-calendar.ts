/**
 * NSE trading-day calendar — the repo's first and only holiday list.
 *
 * Until now nothing in TradeW knew what a market holiday was, and two separate
 * utilities said so in their own comments:
 *
 *   - `sim/ist-time.util.ts#todayIstSessionEnd` — "Doesn't account for exchange
 *     holidays (no holiday calendar available — same known gap as
 *     `isMarketOpen` elsewhere in this app)."
 *   - `services/sentinel/src/market-clock.ts#isMarketOpen` — weekday and clock
 *     only, no holiday awareness.
 *
 * TODO(clock-unification): both of those should adopt `isTradingDay` from here
 * rather than keep their own weekday-only notion of a session. Deliberately not
 * done in this change — `todayIstSessionEnd` drives DAY-order expiry and
 * `isMarketOpen` drives Sentinel's session phase, so changing either is an OMS/
 * Sentinel behaviour change that wants its own review, not a side effect of the
 * discipline panel. This module is written to be that single source when they do.
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
 * should get a discipline session like any other day.
 *
 * Weekday closures only. Holidays that fall on a Saturday or Sunday in 2026 —
 * Mahashivratri (15 Feb, Sun), Id-Ul-Fitr (21 Mar, Sat) and Independence Day
 * (15 Aug, Sat) — are deliberately absent: `isWeekend` already closes those
 * days, and listing them would imply this file is the reason the market is
 * shut. `market-calendar.spec.ts` asserts the list stays weekday-only.
 *
 * !! UNVERIFIED AGAINST THE OFFICIAL CIRCULAR !!
 * These dates were derived from the usual Indian holiday calendar, not read
 * off NSE's published 2026 trading-holiday circular. Several are lunar and
 * move year to year (Holi, Ram Navami, Bakri Id, Muharram, Dussehra, Diwali),
 * and Diwali Balipratipada in particular is the kind of date that shifts by a
 * day. Reconcile this list against the circular before launch. A wrong date
 * costs a trader a discipline panel on a closed market, or none on an open
 * one — annoying, not dangerous, but it should be right.
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
 * as "trading day". That is the safe direction for this feature: the worst case
 * is a discipline panel shown on a day the market was shut, which costs the
 * trader a few seconds. The opposite default would silently stop showing the
 * panel for a whole year the moment the calendar went stale.
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
