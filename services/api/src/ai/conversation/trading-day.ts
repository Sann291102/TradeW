/**
 * The trading-day boundary (`AI-CONVERSATION-LIFECYCLE.md` §2–§3).
 *
 * A conversation thread belongs to one trading day and rolls at **02:30 IST** —
 * after every Indian market close (MCX runs to ~23:55 during US DST) and about
 * six and a half hours before the 09:00 pre-open.
 *
 * ## Why the arithmetic is done by hand
 *
 * IST is UTC+05:30 and **has no daylight saving, ever**. That single fact makes
 * a fixed-offset calculation exactly correct in perpetuity, with no tz database
 * and no dependency. The same code for a DST-observing zone would be a bug; for
 * Asia/Kolkata it is the simplest correct thing.
 *
 * ## The shift trick
 *
 * Working out "which day does 01:00 IST belong to?" with conditionals invites
 * off-by-one errors around midnight, month ends and year ends. Instead the
 * instant is moved into a frame whose midnight IS the boundary: add the IST
 * offset, subtract 2h30m, then read the calendar date. Everything before
 * 02:30 IST lands on the previous date automatically, including 01:00 on the
 * 1st of January.
 */

/** IST is UTC+05:30, fixed. No DST — see the file header. */
const IST_OFFSET_MINUTES = 330;

/** The roll happens at 02:30 IST. */
export const ROLL_HOUR_IST = 2;
export const ROLL_MINUTE_IST = 30;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const ROLL_OFFSET_MS = (ROLL_HOUR_IST * 60 + ROLL_MINUTE_IST) * MS_PER_MINUTE;

/**
 * The trading day an instant belongs to, as `YYYY-MM-DD`.
 *
 * 01:00 IST on the 11th belongs to the 10th; 02:30 IST on the 11th belongs to
 * the 11th. The boundary is inclusive of its own minute.
 */
export function tradingDayFor(instant: Date = new Date()): string {
  const shifted = instant.getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE - ROLL_OFFSET_MS;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * The same value as a `Date` pinned to UTC midnight, for the `@db.Date` column.
 *
 * UTC midnight specifically: a `Date` carrying a local-midnight time would be
 * stored as the previous day by any driver that converts to UTC first, which is
 * the classic way date-only columns go wrong.
 */
export function tradingDayDate(instant: Date = new Date()): Date {
  return new Date(`${tradingDayFor(instant)}T00:00:00.000Z`);
}

/** Whether two instants fall in the same trading day. */
export function isSameTradingDay(a: Date, b: Date): boolean {
  return tradingDayFor(a) === tradingDayFor(b);
}

/**
 * The instant at which the thread active at `instant` will roll — i.e. the next
 * 02:30 IST strictly after it. Used to schedule or explain the roll, and to
 * render "this conversation resets at…" in the UI.
 */
export function nextRollAt(instant: Date = new Date()): Date {
  const shifted = instant.getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE - ROLL_OFFSET_MS;
  const nextShiftedMidnight = Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY + MS_PER_DAY;
  return new Date(nextShiftedMidnight - IST_OFFSET_MINUTES * MS_PER_MINUTE + ROLL_OFFSET_MS);
}

/** Human-facing IST wall clock, for logs and copy. `2026-08-10 14:35 IST`. */
export function formatIst(instant: Date = new Date()): string {
  const ist = new Date(instant.getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE);
  return `${ist.toISOString().slice(0, 10)} ${ist.toISOString().slice(11, 16)} IST`;
}
