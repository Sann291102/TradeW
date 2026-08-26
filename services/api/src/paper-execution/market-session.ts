import { nonTradingReason } from '../discipline/market-calendar';
import { istParts } from './execution-identity';
import { SESSION_OPEN_MINUTE } from './execution-policy';

/**
 * The one authoritative reading of "what is the NSE doing right now?" for the
 * paper-execution loop.
 *
 * ## Why this exists as a single module
 *
 * The session was being answered in pieces: `isTradingDay` (weekend/holiday)
 * from `@tradew/market-data`, and an inline `minute >= open && minute < close`
 * in `paper-execution.service`. Two half-answers in two places is exactly how a
 * loop ends up trading pre-market on one path and refusing it on another. This
 * folds both — which DAY the exchange trades (calendar) and which WINDOW of that
 * day is the session — into one classifier the scheduler and the loop both read.
 *
 * ## It is pure, and calendar-aware
 *
 * No Nest, no clock of its own beyond the injectable `now`, so every phase is
 * asserted directly. The trading-DAY judgement is delegated to the shared NSE
 * calendar (`@tradew/market-data` via `discipline/market-calendar`), so a
 * holiday added there is honoured here with no second list — the exact
 * clock-unification this codebase already applied to Sentinel's own clock.
 *
 * Deliberately NOT the same as the OMS/bridge `marketOpen` flag: that is the
 * FEED's opinion ("am I receiving ticks"), this is the CALENDAR's ("is the
 * exchange in session today"). Both gate an entry, from different failure
 * modes — a feed can be down mid-session, and a feed can report open on a day
 * the exchange is shut — so the loop checks this first and the bridge flag later.
 */

/** IST minute-of-day the Indian equity session closes (15:30). */
export const SESSION_CLOSE_MINUTE = 15 * 60 + 30;
export { SESSION_OPEN_MINUTE };

export type MarketSessionPhase =
  // Non-trading days, kept distinct because "the exchange is shut for a holiday"
  // and "it's the weekend" are different answers an operator may need to see.
  | 'weekend'
  | 'holiday'
  // Trading-day windows.
  | 'pre-market'
  | 'active'
  | 'post-market';

export interface MarketSession {
  phase: MarketSessionPhase;
  /** True ONLY in the `active` window — the one phase a new entry may open in. */
  isOpen: boolean;
  isTradingDay: boolean;
  /** IST minute-of-day, so callers need not re-derive it from the clock. */
  minuteOfDay: number;
  /** IST calendar day (YYYY-MM-DD). */
  dayKey: string;
  /** Plain-language why — used verbatim as the loop's skip reason. */
  reason: string;
}

/**
 * Classify the session at `now`.
 *
 * A new entry is permitted only when `isOpen` (phase `active`). Every other
 * phase carries a `reason` the loop records as its skip explanation, so
 * "nothing traded" is always attributable to a named phase rather than a bare
 * "market closed".
 */
export function classifyMarketSession(now: Date = new Date()): MarketSession {
  const { minuteOfDay, dayKey } = istParts(now);
  const base = { minuteOfDay, dayKey };

  const nonTrading = nonTradingReason(now);
  if (nonTrading === 'weekend') {
    return { ...base, phase: 'weekend', isOpen: false, isTradingDay: false, reason: 'Not an NSE trading day — weekend.' };
  }
  if (nonTrading === 'holiday') {
    return { ...base, phase: 'holiday', isOpen: false, isTradingDay: false, reason: 'Not an NSE trading day — exchange holiday.' };
  }

  if (minuteOfDay < SESSION_OPEN_MINUTE) {
    return { ...base, phase: 'pre-market', isOpen: false, isTradingDay: true, reason: 'Pre-market — the session opens at 09:15 IST.' };
  }
  if (minuteOfDay >= SESSION_CLOSE_MINUTE) {
    return { ...base, phase: 'post-market', isOpen: false, isTradingDay: true, reason: 'Post-market — the session closed at 15:30 IST.' };
  }
  return { ...base, phase: 'active', isOpen: true, isTradingDay: true, reason: 'The session is open (09:15–15:30 IST).' };
}
