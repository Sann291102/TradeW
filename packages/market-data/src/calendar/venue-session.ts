/**
 * Venue sessions — when each venue actually trades.
 *
 * ## Why this now lives beside the calendar
 *
 * `nse-calendar.ts` deliberately disclaims session hours:
 *
 *   > A trading day is a property of the exchange calendar; the 09:15-15:30
 *   > window is a property of a segment (MCX runs to ~23:30) and stays with
 *   > each runtime's own clock.
 *
 * That held while every segment this platform traded shared one window. It
 * stops holding the moment a second venue exists, and it fails in exactly the
 * way the calendar itself failed before it was extracted: three runtimes each
 * carrying their own copy, drifting silently. The evidence is already in the
 * tree —
 *
 *   · `services/market-data/scripts/live-feed-server.ts#isMarketOpen` computes
 *     an NSE window and `toLiveQuote` stamps it onto EVERY quote, MCX
 *     commodities included. Its own comment says MCX runs a separate, longer
 *     session; the code applies the NSE one anyway. Gold therefore reports
 *     `closed` from 15:30 while MCX is still trading, and
 *     `execution-fill.ts` refuses a fill on `!marketOpen` — so a gold
 *     experiment silently loses two thirds of its session.
 *   · That same function has no holiday calendar at all, the gap
 *     `market-clock.ts` closed for Sentinel by reading this package.
 *
 * So this module owns the window, the calendar binding and the day boundary
 * for every venue, and the runtimes read it rather than re-deriving it.
 *
 * ## The three properties that actually differ between venues
 *
 * Not "market hours" as one fact, but three separable ones, because crypto
 * differs from NSE on all three independently:
 *
 *  1. **The window** — does trading have a start and an end at all.
 *     `continuous` venues have none, and every consumer must express that as
 *     "always open" rather than as a 00:00-23:59 window, which would still
 *     produce a boundary at midnight.
 *  2. **The calendar** — which days are trading days. NSE publishes holidays;
 *     Binance does not close.
 *  3. **The day boundary** — where "today's P&L", the daily order counter and
 *     the idempotency bucket roll over. This is the one most easily missed: a
 *     24/7 venue still needs a day boundary for risk resets, it just cannot
 *     borrow the IST session close, because there is no close.
 *
 * ## What this module does NOT do
 *
 * It does not decide whether a strategy should trade, only whether the venue
 * is open. Square-off, entry cut-offs and risk resets are execution policy and
 * stay in `ExecutionProfile` — but they now have a venue-correct clock to be
 * expressed against, which is the whole point.
 */

import { isHoliday, istDateKey, istWeekday } from './nse-calendar';

/**
 * The venues this platform prices or trades.
 *
 * Matches `UNIVERSE_EXCHANGES` in `../universe/universe.contracts.ts` with two
 * additions — `MCX`, which that list is missing (`dhan.catalogue.ts` currently
 * maps `MCX_COMM` to `'NSE'`, which is wrong and is corrected separately) — and
 * is deliberately NOT re-exported as the same type: a venue we can price is not
 * the same set as a venue whose catalogue we sync.
 */
export const MARKET_VENUES = ['NSE', 'BSE', 'MCX', 'BINANCE', 'FX'] as const;
export type MarketVenue = (typeof MARKET_VENUES)[number];

/**
 * How a venue's trading time is shaped.
 *
 * `continuous` is not "open 24 hours" — it is "has no session concept". The
 * distinction matters to every caller that asks for a close time: a session
 * venue can answer, a continuous one must return null rather than midnight,
 * or an EOD square-off appears at 00:00 UTC for an instrument that never
 * closes.
 */
export type SessionKind = 'session' | 'continuous';

export interface VenueSessionSpec {
  venue: MarketVenue;
  kind: SessionKind;
  /** IANA zone the window and the day boundary are expressed in. */
  timeZone: string;
  /** Minute-of-day the session opens, in `timeZone`. Null when continuous. */
  openMinute: number | null;
  /** Minute-of-day the session closes, in `timeZone`. Null when continuous. */
  closeMinute: number | null;
  /**
   * Which holiday list gates trading days.
   *
   * `'nse'` — the published NSE equity list in `nse-calendar.ts`.
   * `'none'` — the venue never closes for a holiday.
   */
  calendar: 'nse' | 'none';
  /** Whether Saturday and Sunday are trading days. */
  tradesWeekends: boolean;
  /** Human-readable, for the UI and for refusal messages. */
  label: string;
}

/**
 * MCX close, as a minute-of-day IST.
 *
 * MCX runs its evening session to 23:30 IST in the Nov-Mar window and 23:55
 * IST when US daylight saving is in force, because the metals and energy
 * contracts track COMEX/NYMEX hours. 23:30 is used year-round here: it is the
 * conservative end of the pair, and being 25 minutes early on a paper
 * experiment costs a handful of bars, whereas being late means the engine
 * believes a closed venue is open and `execution-fill.ts` fills against a
 * stale tick. Agricultural contracts close at 17:00 and are NOT modelled —
 * this platform's commodity set (GOLD/SILVER/CRUDEOIL/NATURALGAS/COPPER) is
 * entirely non-agri.
 *
 * !! NOT READ FROM AN MCX CIRCULAR !! Same standing caveat as
 * `NSE_HOLIDAYS_2026`: reconcile against the exchange's published timings
 * before this drives anything but paper.
 */
const MCX_OPEN_MINUTE = 9 * 60; // 09:00 IST
const MCX_CLOSE_MINUTE = 23 * 60 + 30; // 23:30 IST

const SPECS: Record<MarketVenue, VenueSessionSpec> = {
  NSE: {
    venue: 'NSE',
    kind: 'session',
    timeZone: 'Asia/Kolkata',
    openMinute: 9 * 60 + 15,
    closeMinute: 15 * 60 + 30,
    calendar: 'nse',
    tradesWeekends: false,
    label: 'NSE 09:15-15:30 IST',
  },
  BSE: {
    venue: 'BSE',
    kind: 'session',
    timeZone: 'Asia/Kolkata',
    openMinute: 9 * 60 + 15,
    closeMinute: 15 * 60 + 30,
    calendar: 'nse',
    tradesWeekends: false,
    label: 'BSE 09:15-15:30 IST',
  },
  MCX: {
    venue: 'MCX',
    kind: 'session',
    timeZone: 'Asia/Kolkata',
    openMinute: MCX_OPEN_MINUTE,
    closeMinute: MCX_CLOSE_MINUTE,
    // MCX publishes its own holiday list, which overlaps the NSE equity list
    // heavily but not exactly — MCX commonly runs an evening session on days
    // NSE is shut for a morning-only festival. Borrowing the NSE list is an
    // APPROXIMATION, and it errs toward "closed", which is the safe direction:
    // the cost is bars not observed, never a fill against an exchange that was
    // shut. Recorded here rather than silently assumed.
    calendar: 'nse',
    tradesWeekends: false,
    label: 'MCX 09:00-23:30 IST',
  },
  BINANCE: {
    venue: 'BINANCE',
    kind: 'continuous',
    // UTC, not IST. The day boundary for a 24/7 venue is arbitrary but must be
    // STABLE and must not be a session edge borrowed from another market:
    // rolling crypto's daily counters at 15:30 IST would cut the day in the
    // middle of the most active US hours. UTC midnight is what Binance's own
    // daily klines and 24h statistics use, so our "day" agrees with the
    // exchange's.
    timeZone: 'UTC',
    openMinute: null,
    closeMinute: null,
    calendar: 'none',
    tradesWeekends: true,
    label: 'Binance 24/7',
  },
  FX: {
    venue: 'FX',
    kind: 'session',
    // Spot FX runs continuously from Sunday 17:00 New York to Friday 17:00 New
    // York. That is a WEEKLY window, not a daily one, and this shape cannot
    // express it — so FX is modelled as a wide daily window on weekdays, which
    // is correct Monday to Thursday and wrong at the weekend edges. FX is
    // display-only today (`chartSurface: 'embed'`, `tradeable: false`), so
    // nothing executes against this; it is here so the venue is nameable
    // rather than absent. Do not trade FX off this without fixing it first.
    timeZone: 'UTC',
    openMinute: 0,
    closeMinute: 24 * 60 - 1,
    calendar: 'none',
    tradesWeekends: false,
    label: 'FX spot (weekday approximation)',
  },
};

export function venueSession(venue: MarketVenue): VenueSessionSpec {
  return SPECS[venue];
}

/** Minute-of-day for `at` in an arbitrary IANA zone. */
function minuteOfDayIn(at: Date, timeZone: string): number {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(at)
    .split(':')
    .map(Number);
  return h * 60 + m;
}

/** 'YYYY-MM-DD' for `at` in an arbitrary IANA zone. */
function dateKeyIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Weekday index (0 = Sunday) for `at` in an arbitrary IANA zone. */
function weekdayIn(at: Date, timeZone: string): number {
  const [y, m, d] = dateKeyIn(at, timeZone).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The venue's own day key — where its daily counters roll over.
 *
 * NOT always the IST date. This is the function that stops a BTC agent's
 * "orders today" counter resetting at 15:30 IST because that is when the
 * Indian one does.
 */
export function venueDayKey(venue: MarketVenue, at: Date = new Date()): string {
  const spec = SPECS[venue];
  return spec.timeZone === 'Asia/Kolkata' ? istDateKey(at) : dateKeyIn(at, spec.timeZone);
}

/** Minute-of-day in the venue's own zone. */
export function venueMinuteOfDay(venue: MarketVenue, at: Date = new Date()): number {
  const spec = SPECS[venue];
  return minuteOfDayIn(at, spec.timeZone);
}

/**
 * True when the venue trades on `at`'s calendar day.
 *
 * A continuous venue trades every day, including weekends and every holiday —
 * which is the whole point, and why this cannot be `isTradingDay` with a
 * parameter bolted on.
 */
export function isVenueTradingDay(venue: MarketVenue, at: Date = new Date()): boolean {
  const spec = SPECS[venue];
  if (spec.kind === 'continuous') return true;

  if (!spec.tradesWeekends) {
    const day = spec.timeZone === 'Asia/Kolkata' ? istWeekday(at) : weekdayIn(at, spec.timeZone);
    if (day === 0 || day === 6) return false;
  }

  if (spec.calendar === 'nse') return !isHoliday(istDateKey(at));
  return true;
}

/**
 * True when the venue is actually trading at `at`.
 *
 * The calendar check is first and non-negotiable, matching `market-clock.ts`'s
 * reasoning: a holiday is closed at every hour, so no caller can reach the
 * time-of-day comparison and conclude a shut exchange is open.
 */
export function isVenueOpen(venue: MarketVenue, at: Date = new Date()): boolean {
  const spec = SPECS[venue];
  if (!isVenueTradingDay(venue, at)) return false;
  if (spec.kind === 'continuous') return true;

  const mins = minuteOfDayIn(at, spec.timeZone);
  return mins >= (spec.openMinute ?? 0) && mins <= (spec.closeMinute ?? 24 * 60);
}

/**
 * Why the venue is not trading, or null when it is.
 *
 * Three distinguishable reasons, because they need three different sentences
 * on screen: a weekend the trader can see out of the window, a holiday they may
 * have forgotten, and an hour-of-day that is simply outside the window.
 */
export type VenueClosedReason = 'weekend' | 'holiday' | 'outside-hours';

export function venueClosedReason(venue: MarketVenue, at: Date = new Date()): VenueClosedReason | null {
  const spec = SPECS[venue];
  if (spec.kind === 'continuous') return null;

  if (!spec.tradesWeekends) {
    const day = spec.timeZone === 'Asia/Kolkata' ? istWeekday(at) : weekdayIn(at, spec.timeZone);
    if (day === 0 || day === 6) return 'weekend';
  }
  if (spec.calendar === 'nse' && isHoliday(istDateKey(at))) return 'holiday';
  if (!isVenueOpen(venue, at)) return 'outside-hours';
  return null;
}

/**
 * Minutes until the venue's close; null when it never closes.
 *
 * Null rather than Infinity deliberately: a caller sizing a square-off or an
 * order expiry must handle "there is no close" explicitly, and `Infinity`
 * would sail through arithmetic and produce a date far in the future instead
 * of forcing the decision.
 */
export function venueMinutesToClose(venue: MarketVenue, at: Date = new Date()): number | null {
  const spec = SPECS[venue];
  if (spec.kind === 'continuous' || spec.closeMinute === null) return null;
  return spec.closeMinute - minuteOfDayIn(at, spec.timeZone);
}

/**
 * Whether a position on this venue must be flat by the session close.
 *
 * True for session venues, false for continuous ones. This is the property
 * `position-decision.ts`'s end-of-day square-off should branch on rather than
 * assuming 15:10 IST applies everywhere — a BTC position squared off nightly
 * would book two sets of charges to learn nothing, which is the exact argument
 * `ExecutionProfile.squareOffMinute`'s own comment makes for why the NSE one
 * exists.
 */
export function venueRequiresEodFlatten(venue: MarketVenue): boolean {
  return SPECS[venue].kind === 'session';
}

/**
 * Map a Dhan exchange segment to its venue.
 *
 * The bridge speaks in segments (`IDX_I`, `NSE_EQ`, `MCX_COMM`) and everything
 * downstream speaks in venues. One conversion, here, so the bridge does not
 * grow a second opinion about which session a commodity belongs to — the
 * defect this whole module was written to fix.
 */
export function venueForExchangeSegment(segment: string): MarketVenue {
  if (segment.startsWith('MCX')) return 'MCX';
  if (segment.startsWith('BSE')) return 'BSE';
  return 'NSE';
}
