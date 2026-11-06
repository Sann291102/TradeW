/**
 * When an open position must be closed by the platform rather than by its
 * owner. Pure and clock-free so every rule can be asserted without a database.
 *
 * ## The three situations this exists for
 *
 * 1. **Session end (MIS).** An intraday position is, by definition, not carried
 *    overnight. Before this, nothing enforced that for a person's own trades, so
 *    a MIS position survived the close at intraday margin (defect D-21).
 *
 * 2. **Expiry day.** An option expiring today stops trading at 15:30 and then
 *    has no market at all. It has to be closed while it still can be, which
 *    means before the close — whatever its product type. A NRML option is
 *    "carry overnight" by intent, but an expiring one has no overnight.
 *
 * 3. **Already expired.** Past the expiry the contract cannot be priced, so it
 *    can never be exited by an order (`MarketPriceService.getOptionPrice`
 *    throws), and the position and its margin would be stranded forever
 *    (defect D-22). It is cash-settled at intrinsic value instead.
 *
 * Square-off uses a MARKET exit through the ordinary order path. Settlement is
 * not an order against a market; it is the exchange's own cash settlement, and
 * takes a price supplied from real data (see `intrinsicValue`).
 */

/** 15:15 IST — the broker-standard MIS auto square-off, and 15 minutes of
 *  margin of safety before the 15:30 close for the exit to fill. */
export const SESSION_SQUARE_OFF_MINUTE = 15 * 60 + 15;
/** 15:30 IST — the exchange close, and the moment an expiring option stops existing. */
export const SESSION_CLOSE_MINUTE = 15 * 60 + 30;
/** How long after the close an expiring contract is left alone before it is
 *  settled — the venue's own final prints and any exit already in flight land
 *  inside this window. */
export const SETTLEMENT_DELAY_MINUTES = 5;
/** A paper agent that manages its own position is given until here to flatten
 *  it on its own terms (its profile's `squareOffMinute`, usually 15:10) before
 *  the platform steps in as a backstop. */
export const AGENT_GRACE_MINUTE = 15 * 60 + 25;
/** A position carried over from a previous session is exited this soon after
 *  the open, once there is a live price to exit against. */
export const OPEN_CATCH_UP_MINUTE = 9 * 60 + 20;

export interface SweepClock {
  /** IST calendar day, `YYYY-MM-DD`. */
  dayKey: string;
  /** IST minute of the day, 0–1439. */
  minuteOfDay: number;
  /** Whether the exchange is open for business today (not a weekend or holiday). */
  tradingDay: boolean;
}

export interface SweepPosition {
  productType: 'MIS' | 'CNC' | 'NRML';
  quantity: number;
  instrumentType: string;
  /** Contract expiry as an IST calendar day `YYYY-MM-DD`, for derivatives. */
  expiryDayKey: string | null;
  /** IST calendar day of the position's last fill, `YYYY-MM-DD`. */
  lastActivityDayKey: string;
  /** True when a Sentinel agent currently manages this position itself. */
  managedByAgent: boolean;
}

export type SweepAction =
  | { kind: 'none'; reason: string }
  | { kind: 'square-off'; reason: 'session-end' | 'expiry-day' | 'carried-overnight' }
  | { kind: 'settle'; reason: 'expired' };

export function decideSweep(p: SweepPosition, clock: SweepClock): SweepAction {
  if (p.quantity === 0) return { kind: 'none', reason: 'flat' };

  const isOption = p.instrumentType === 'OPTION' && p.expiryDayKey != null;

  // ---- Expired or expiring ------------------------------------------------
  if (isOption) {
    if (p.expiryDayKey! < clock.dayKey) return { kind: 'settle', reason: 'expired' };
    if (p.expiryDayKey === clock.dayKey) {
      if (clock.minuteOfDay >= SESSION_CLOSE_MINUTE + SETTLEMENT_DELAY_MINUTES) {
        return { kind: 'settle', reason: 'expired' };
      }
      if (clock.minuteOfDay >= SESSION_SQUARE_OFF_MINUTE) {
        return defer({ kind: 'square-off', reason: 'expiry-day' }, p, clock);
      }
      return { kind: 'none', reason: 'expires today, not yet 15:15 IST' };
    }
  }

  // ---- Intraday ------------------------------------------------------------
  if (p.productType === 'MIS') {
    if (!clock.tradingDay) return { kind: 'none', reason: 'exchange closed today' };
    if (p.lastActivityDayKey < clock.dayKey && clock.minuteOfDay >= OPEN_CATCH_UP_MINUTE) {
      // Missed the previous session's square-off (process down, feed dead).
      // Closing at today's price is the honest correction; leaving it open
      // keeps intraday margin blocked on a position that should not exist.
      return { kind: 'square-off', reason: 'carried-overnight' };
    }
    if (clock.minuteOfDay >= SESSION_SQUARE_OFF_MINUTE) {
      return defer({ kind: 'square-off', reason: 'session-end' }, p, clock);
    }
  }

  return { kind: 'none', reason: 'nothing due' };
}

/** An agent-managed position is left to its agent until the grace minute. */
function defer(action: Extract<SweepAction, { kind: 'square-off' }>, p: SweepPosition, clock: SweepClock): SweepAction {
  if (p.managedByAgent && clock.minuteOfDay < AGENT_GRACE_MINUTE) {
    return { kind: 'none', reason: 'managed by an agent; platform backstop starts at 15:25 IST' };
  }
  return action;
}

/**
 * Cash-settlement value of an option at expiry: what it is worth if exercised
 * against the underlying's settlement price. Never negative — the holder of an
 * option cannot owe more than the premium. Returns null when the contract's
 * details are incomplete, so the caller refuses rather than settling at zero.
 */
export function intrinsicValue(
  optionType: string | null,
  strike: number | null,
  underlyingPrice: number,
): number | null {
  if (strike == null || !Number.isFinite(strike) || !(underlyingPrice > 0)) return null;
  if (optionType === 'CE') return Math.max(0, underlyingPrice - strike);
  if (optionType === 'PE') return Math.max(0, strike - underlyingPrice);
  return null;
}
