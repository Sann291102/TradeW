/**
 * IST market clock — one place that knows NSE session boundaries.
 *
 * Sentinel runs on servers that are frequently UTC, so every module that
 * reasons about "late in the session" or renders a timeline stamp must agree
 * on the same India-time conversion. `Intl` does the zone maths, so DST-free
 * IST needs no table and no dependency.
 *
 * ── CLOCK UNIFICATION (2026-08-16) ─────────────────────────────────────────
 *
 * This module used to be day-of-week and holiday BLIND: `isMarketOpen` looked
 * only at the time of day, so Sentinel believed the market was open at 10:30
 * on a Saturday and on Republic Day. `market-clock.spec.ts` pinned that as a
 * KNOWN GAP with assertions written to flip when it was fixed, and
 * `services/api/src/discipline/market-calendar.ts` carried the
 * `TODO(clock-unification)` naming this exact module.
 *
 * It is fixed here. The calendar itself moved to `@tradew/market-data` so this
 * service and `services/api` read ONE list — see that module's docstring for
 * why it is not copied. What stays local is the SESSION WINDOW: which days the
 * exchange trades is an exchange-wide fact, 09:15–15:30 is a segment fact.
 *
 * Two things deliberately stay time-of-day only, because they are arithmetic
 * rather than gates: `istMinutesOfDay`/`minutesToClose` (used to size a watch's
 * expiry, which must answer "how long until 15:30" whatever day it is) and
 * `sessionProgress`. Callers that need "is the market actually trading" use
 * `isMarketOpen` or `sessionPhaseAt`, both of which now honour the calendar.
 */

import { isTradingDay as isNseTradingDay, nonTradingReason } from '@tradew/market-data';
import { SessionPhase } from './domain';

export { nonTradingReason };

export const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15 IST
export const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST
/** Brokers begin intraday square-off around here; risk rises into it. */
export const SQUARE_OFF_MIN = 14 * 60 + 45; // 14:45 IST

const IST_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const IST_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 'HH:mm' in IST. */
export function istTimeLabel(at: Date = new Date()): string {
  return IST_TIME.format(at);
}

/** 'YYYY-MM-DD' in IST — the session key. */
export function istDateKey(at: Date = new Date()): string {
  return IST_DATE.format(at);
}

/** Minutes since IST midnight. */
export function istMinutesOfDay(at: Date = new Date()): number {
  const [h, m] = istTimeLabel(at).split(':').map(Number);
  return h * 60 + m;
}

/**
 * True when `at` is an NSE trading day (weekday, not a published holiday).
 *
 * Re-exported from `@tradew/market-data` under this module's name so Sentinel
 * code has a single clock import rather than two, and so a future segment with
 * its own calendar has one place to diverge.
 */
export function isTradingDay(at: Date = new Date()): boolean {
  return isNseTradingDay(at);
}

/**
 * True when `at` falls inside NSE regular trading hours ON A TRADING DAY.
 *
 * The calendar check is first and non-negotiable: a weekend or holiday is
 * closed at every hour, so no caller can reach the time-of-day comparison and
 * conclude the market is open on a day the exchange never opened.
 */
export function isMarketOpen(at: Date = new Date()): boolean {
  if (!isNseTradingDay(at)) return false;
  const mins = istMinutesOfDay(at);
  return mins >= MARKET_OPEN_MIN && mins <= MARKET_CLOSE_MIN;
}

/** Minutes remaining until the close; negative once the session has ended. */
export function minutesToClose(at: Date = new Date()): number {
  return MARKET_CLOSE_MIN - istMinutesOfDay(at);
}

/** How far through the session we are, clamped to 0..1. */
export function sessionProgress(at: Date = new Date()): number {
  const mins = istMinutesOfDay(at);
  const span = MARKET_CLOSE_MIN - MARKET_OPEN_MIN;
  return Math.max(0, Math.min(1, (mins - MARKET_OPEN_MIN) / span));
}

/**
 * The session phase.
 *
 * A non-trading day is 'closed' at every hour — never 'pre-market'. Both would
 * keep `isMarketOpen` false, but they mean different things downstream:
 * `MarketStateMachineService.session()` seeds a fresh session as `PRE_MARKET`
 * on the former and `MARKET_CLOSE` on the latter, and a Saturday that opens in
 * PRE_MARKET is a session that spends all day waiting for a bell that will not
 * ring.
 */
export function sessionPhaseAt(at: Date = new Date()): SessionPhase {
  if (!isNseTradingDay(at)) return 'closed';
  const mins = istMinutesOfDay(at);
  if (mins < MARKET_OPEN_MIN) return 'pre-market';
  if (mins > MARKET_CLOSE_MIN) return 'closed';
  if (mins >= SQUARE_OFF_MIN) return 'closing';
  return 'active';
}

/**
 * Parse an 'HH:mm-HH:mm' IST window and test membership.
 * An unparsable window is treated as "always", so a malformed user strategy
 * config never silently disables the strategy without explanation.
 */
export function isWithinSession(window: string | undefined, at: Date = new Date()): boolean {
  if (!window) return true;
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(window.trim());
  if (!match) return true;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  const now = istMinutesOfDay(at);
  return now >= start && now <= end;
}
