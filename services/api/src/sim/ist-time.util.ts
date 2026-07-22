/**
 * NSE/BSE trading-session timing (IST, UTC+5:30) shared by OrderService
 * (DAY-validity expiry), MatchingEngineService (order expiry checks) and
 * PositionService (daily P&L's session-boundary detection). One place for
 * the `toLocaleString`-based IST conversion trick so it isn't reimplemented
 * three slightly-differently each time.
 */

/** Reinterprets `now` as if its wall-clock time were already IST, returning
 *  the millisecond offset needed to convert an IST-local Date back to a
 *  real UTC instant. */
function istOffsetMs(now: Date): { istAsLocal: Date; offsetMs: number } {
  const istAsLocal = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return { istAsLocal, offsetMs: now.getTime() - istAsLocal.getTime() };
}

/** IST calendar-day key ("2026-07-22") — used to detect a new trading session. */
export function istDayKey(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // en-CA gives YYYY-MM-DD
}

/** The next 15:30 IST session close — DAY-validity orders expire here.
 *  Placing an order after today's close (or on a weekend) rolls forward to
 *  the next weekday's close instead of returning an already-past instant,
 *  which would expire the order within one matching-engine tick of being
 *  created. Doesn't account for exchange holidays (no holiday calendar
 *  available — same known gap as `isMarketOpen` elsewhere in this app). */
export function todayIstSessionEnd(): Date {
  const now = new Date();
  const { istAsLocal, offsetMs } = istOffsetMs(now);
  const cutoff = new Date(istAsLocal);
  cutoff.setHours(15, 30, 0, 0);
  if (istAsLocal.getTime() > cutoff.getTime()) cutoff.setDate(cutoff.getDate() + 1);
  while (cutoff.getDay() === 0 || cutoff.getDay() === 6) cutoff.setDate(cutoff.getDate() + 1);
  return new Date(cutoff.getTime() + offsetMs);
}

/** Start of today (00:00) in IST, as a real UTC instant — the boundary for
 *  "today's" realized P&L / trades. */
export function startOfIstDay(): Date {
  const now = new Date();
  const { istAsLocal, offsetMs } = istOffsetMs(now);
  istAsLocal.setHours(0, 0, 0, 0);
  return new Date(istAsLocal.getTime() + offsetMs);
}
