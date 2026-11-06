/**
 * The last-valid-price invariant.
 *
 * ── THE DEFECT THIS EXISTS TO END ─────────────────────────────────────────
 *
 * With the market closed, every index card on the dashboard read 0.00. Not a
 * blank, not "market closed" — a *price* of zero, which is a statement about
 * the market and a false one. It had two independent origins, both of which
 * this module removes at the source rather than at the point of display:
 *
 *  1. The live-feed bridge seeded every tracked instrument with `ltp: 0` at
 *     boot "so snapshot() is never empty", and published those rows as real
 *     quotes. Nothing distinguished a seeded zero from an observed price.
 *  2. Dhan's wire protocol sends 0 for "this packet carries no value". Outside
 *     the session a Quote packet arrives with LTP/open/high/low all zero. The
 *     bridge replaced its whole stored quote on every tick, so one such packet
 *     destroyed a perfectly good previous close that had arrived seconds
 *     earlier on the subscribe-time PREV_CLOSE packet.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────
 *
 * A missing market update is not a price of zero. There are exactly three
 * states a price can be in, and the type system is made to carry all three:
 *
 *    a live observation   →  the number the exchange just sent
 *    no newer observation →  the last valid price we ever observed
 *    never observed       →  null, which the UI must render as "—"
 *
 * Zero is never any of them. `mergeObservation` is the single place that
 * decides, and it is pure: no clock, no network, no I/O. Everything
 * downstream — the bridge's in-memory map, its SSE snapshot, the persisted
 * recovery file, the database write path — is a consumer of this decision
 * rather than a second opinion about it.
 */

/**
 * A price observation counts only when it is a finite, strictly positive
 * number.
 *
 * Every instrument this platform quotes — NSE/BSE equities, the indices,
 * option premiums, MCX contracts, India VIX — trades strictly above zero, so
 * there is no legitimate observation this rejects. A zero on the wire always
 * means "no value in this packet", which is what Dhan's own documentation says
 * and what `nonZero()` in the binary parser already assumed for the day-close
 * field alone. Also rejects NaN and ±Infinity: a corrupt float decode must not
 * be able to become a displayed price.
 */
export function isValidPrice(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** A volume/open-interest count. Unlike a price, zero IS meaningful here (an
 *  instrument that has not traded today really has traded nothing), so this
 *  only rejects absent, negative and non-finite values. */
export function isValidCount(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Where a surviving price came from. Carried all the way to the browser so a
 * surface can say "at previous close" instead of implying a live tick — the
 * distinction the screenshot's "MARKET CLOSED" pill was making while the
 * numbers beside it claimed otherwise.
 */
export type PriceSource =
  /** A trade printed in the session this quote's `session` names. */
  | 'live'
  /** The previous session's settlement — the exchange's own closing value. */
  | 'previous-close'
  /** The close of the last daily/intraday bar, used to recover a price the
   *  websocket has not re-sent (cold start outside market hours). */
  | 'last-session-bar';

/** One reading of one instrument, as a provider reported it. Every field is
 *  optional because feed modes differ in what they carry (see MarketTick). */
export interface PriceObservation {
  ltp?: number | null;
  previousClose?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  bid?: number | null;
  ask?: number | null;
  volume?: number | null;
  /** When the exchange reported this. Decides session rollover. */
  at: Date;
}

/**
 * Everything worth remembering about one instrument, as last observed.
 *
 * Prices are `number | null` throughout, never `0`-as-absent. `null` here means
 * exactly one thing: nothing valid has ever been observed for this field.
 */
export interface LastKnownQuote {
  /** The last valid traded price, of any age. Null only before the first one. */
  ltp: number | null;
  /** The previous session's close, as the exchange reported it. */
  previousClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /** The session close, sent by Dhan only after the market shuts. */
  close: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  /** IST trading day (YYYY-MM-DD) that `ltp` belongs to. Null with no `ltp`. */
  session: string | null;
  /** ISO instant of the observation that produced the surviving `ltp`. */
  at: string | null;
  /** Provenance of the surviving `ltp`. Null with no `ltp`. */
  source: PriceSource | null;
}

export const UNKNOWN_QUOTE: Readonly<LastKnownQuote> = Object.freeze({
  ltp: null,
  previousClose: null,
  open: null,
  high: null,
  low: null,
  close: null,
  bid: null,
  ask: null,
  volume: null,
  session: null,
  at: null,
  source: null,
});

/**
 * The IST trading day an instant belongs to, `YYYY-MM-DD`.
 *
 * India observes no daylight saving, so the fixed +05:30 offset is genuinely
 * correct rather than an approximation (the same reasoning as IST_OFFSET_MS in
 * the Dhan binary parser). The trading day is the calendar day: NSE, BSE and
 * MCX sessions all open and close inside one IST date, so no session ever
 * straddles midnight and no roll-over rule beyond the date is needed.
 */
export function istTradingDay(at: Date): string {
  return new Date(at.getTime() + (5 * 60 + 30) * 60_000).toISOString().slice(0, 10);
}

export interface MergeOptions {
  /** Provenance to record if this observation supplies the surviving `ltp`. */
  source?: PriceSource;
  /**
   * A backfill rather than a live reading: it may only FILL a gap, never
   * replace a price already observed in the same or a later session.
   *
   * This is what stops a boot-time historical-bar fetch, which resolves
   * asynchronously and can land after the websocket has already delivered a
   * real tick, from dragging a live price back to yesterday's close.
   */
  backfillOnly?: boolean;
}

/**
 * Fold one observation into what is already known, and never regress.
 *
 * The whole rule set, in one place:
 *
 *  · An invalid price (0, null, undefined, NaN) is ABSENT. It is skipped, and
 *    whatever was known before survives untouched. This is the line that
 *    turns "the market is closed so the exchange sent zeros" from a data-loss
 *    event into a no-op.
 *  · A valid price replaces the stored one — a newer real observation is
 *    always better than an older real observation.
 *  · Crossing into a later trading day rolls the session: yesterday's surviving
 *    `ltp` becomes `previousClose` (unless the exchange sent its own, which
 *    wins, being authoritative), and the intraday fields — open/high/low/close/
 *    volume — are cleared rather than carried forward, because a stale high
 *    from a previous session presented against today's price is its own defect.
 *  · A `backfillOnly` observation may only fill a gap, never overwrite.
 *
 * Pure and total: same inputs, same output, no clock read, no I/O.
 */
export function mergeObservation(
  previous: LastKnownQuote | null | undefined,
  observation: PriceObservation,
  options: MergeOptions = {},
): LastKnownQuote {
  const prev = previous ?? UNKNOWN_QUOTE;
  const source = options.source ?? 'live';
  const day = istTradingDay(observation.at);

  const hasLtp = isValidPrice(observation.ltp);

  // A backfill that would overwrite an equally-recent-or-newer observed price
  // is dropped whole. It has nothing to add and everything to lose.
  if (options.backfillOnly && hasLtp && prev.ltp !== null && prev.session !== null && prev.session >= day) {
    return { ...prev };
  }

  // Session rollover. Triggered only by a VALID price in a later session — an
  // empty out-of-hours packet stamped with tomorrow's date must not be able to
  // retire a good close into `previousClose` and leave nothing in its place.
  const rolled = hasLtp && prev.session !== null && day > prev.session;

  const next: LastKnownQuote = rolled
    ? {
        ...prev,
        // Yesterday's last price IS yesterday's close. Promoting it here is
        // what makes a change/percent still computable on the first tick of a
        // new session, before the exchange has sent its own previous-close.
        previousClose: prev.ltp,
        open: null,
        high: null,
        low: null,
        close: null,
        volume: null,
      }
    : { ...prev };

  // The exchange's own previous-close is authoritative and overrides the
  // promoted value above whenever the packet actually carries one.
  if (isValidPrice(observation.previousClose)) next.previousClose = observation.previousClose;
  if (isValidPrice(observation.open)) next.open = observation.open;
  if (isValidPrice(observation.high)) next.high = observation.high;
  if (isValidPrice(observation.low)) next.low = observation.low;
  if (isValidPrice(observation.close)) next.close = observation.close;
  if (isValidPrice(observation.bid)) next.bid = observation.bid;
  if (isValidPrice(observation.ask)) next.ask = observation.ask;
  // Volume only moves forward within a session; a zero after a real count is
  // the same "no value in this packet" zero the prices carry.
  if (isValidCount(observation.volume) && observation.volume > 0) next.volume = observation.volume;

  if (hasLtp) {
    next.ltp = observation.ltp as number;
    next.session = day;
    next.at = observation.at.toISOString();
    next.source = source;
  } else if (next.ltp === null && isValidPrice(next.previousClose)) {
    // No price has ever been observed, but the exchange has told us where the
    // instrument settled. That IS the last valid market price, and showing it
    // is the entire point of this module — this is the branch that fills the
    // dashboard on a cold start with the market shut.
    next.ltp = next.previousClose;
    next.session = prev.session;
    next.at = observation.at.toISOString();
    next.source = 'previous-close';
  }

  return next;
}

/** What a client needs to render one instrument: the price, and how far it has
 *  moved from the previous close. */
export interface QuoteView {
  /** Last valid price, or null when none has ever been observed. NEVER 0. */
  ltp: number | null;
  previousClose: number | null;
  /** Null — not 0 — when either side of the subtraction is unknown. A change
   *  of exactly zero and an uncomputable change are different facts. */
  change: number | null;
  changePct: number | null;
  source: PriceSource | null;
  session: string | null;
  at: string | null;
}

/**
 * Project stored state into what goes on the wire.
 *
 * `change` is derived here rather than stored so it can never drift out of step
 * with the two numbers it is the difference of — the previous code stored a
 * change computed against whatever the same single packet happened to contain,
 * which is why a previous-close-only packet reported a real price with a 0.00%
 * move beside it.
 */
export function toQuoteView(quote: LastKnownQuote | null | undefined): QuoteView {
  const q = quote ?? UNKNOWN_QUOTE;
  const computable = isValidPrice(q.ltp) && isValidPrice(q.previousClose);
  const change = computable ? round2((q.ltp as number) - (q.previousClose as number)) : null;
  return {
    ltp: isValidPrice(q.ltp) ? q.ltp : null,
    previousClose: isValidPrice(q.previousClose) ? q.previousClose : null,
    change,
    changePct: computable ? round2((change as number / (q.previousClose as number)) * 100) : null,
    source: q.ltp === null ? null : q.source,
    session: q.session,
    at: q.at,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
