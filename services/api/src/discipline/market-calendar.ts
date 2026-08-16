/**
 * NSE trading-day calendar — now a re-export of `@tradew/market-data`.
 *
 * ## What moved, and why
 *
 * This file used to OWN the holiday list. It carried a `TODO(clock-unification)`
 * naming the two modules that should adopt it rather than keep their own
 * weekday-only notion of a session:
 *
 *   - `sim/ist-time.util.ts#todayIstSessionEnd`
 *   - `services/sentinel/src/market-clock.ts#isMarketOpen`
 *
 * Sentinel's side of that landed on 2026-08-16 (its watch and its observation
 * gate on trading days now), and a service in a different runtime cannot import
 * a file from this one. Copying the list would have made two — soon three —
 * copies of a table that changes once a year, so the list moved to
 * `packages/market-data/src/calendar/nse-calendar.ts`, which `services/api`,
 * `services/market-data` and `services/sentinel` all already depend on.
 *
 * The module stays here, with the same name and the same exported surface, so
 * every importer inside `services/api` is untouched:
 *
 *   discipline.service · sim/eod-summary.service · sim/order.service ·
 *   sim/performance.service · sentinel/sentinel-event-dispatcher.service ·
 *   sentinel/sentinel-py.controller
 *
 * Add new holidays in the package, not here. `market-calendar.spec.ts` still
 * runs against these re-exports, so the assertions about the list (weekday-only,
 * sorted, no duplicates) keep guarding the real data through this seam.
 *
 * Still outstanding from the original TODO: `sim/ist-time.util.ts` drives
 * DAY-order expiry and has not been converted — that is an OMS behaviour change
 * wanting its own review, exactly as originally written.
 */

export {
  NSE_HOLIDAYS_2026,
  hasCalendarFor,
  isHoliday,
  isTradingDay,
  isWeekend,
  istDateKey,
  istMidnightUtc,
  istWeekday,
  nextTradingDay,
  nonTradingReason,
} from '@tradew/market-data';
