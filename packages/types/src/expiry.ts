/**
 * THE canonical option-expiry resolver.
 *
 * ── THE BUG THIS EXISTS TO MAKE IMPOSSIBLE ─────────────────────────────────
 *
 * On 2026-08-19 the `/sentinel` watch creator showed an expiry dropdown reading
 * "25 Aug" while the Option Pair panel below it reported
 *
 *   "No live chain for NIFTY 18 Aug right now."
 *
 * Both were rendered from the same component tree in the same frame. They
 * disagreed because there was no single answer to "which expiry are we on":
 * the canonical `WatchSelection.expiry` had been restored from localStorage as
 * `2026-08-18` and was only ever written when it was `null`, so it survived the
 * rollover; the `<select>` had no `<option>` matching it and therefore fell
 * back to painting its FIRST option ("25 Aug"). The dropdown was not correct
 * and the panel stale — the dropdown was lying, and the panel was the only
 * thing on screen telling the truth about what had actually been requested.
 *
 * Every rule for choosing an expiry now lives here, and both runtimes import
 * it: `apps/web` (the workspace) and `services/market-data`'s bridge (the
 * `/optionchain` routes), via `@tradew/types`, which both already depend on.
 * A second opinion about "nearest", "expired" or "valid" cannot be added
 * without adding a second module, which is the point.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * It never COMPUTES an expiry. There is no "next Tuesday", no "+7 days", no
 * calendar arithmetic and no hardcoded date anywhere in this file. NSE moves
 * expiry weekdays by circular (NIFTY has been Thursday, then Monday, then
 * Tuesday within two years) and shifts them again around holidays, so any
 * derived date is a guess that is wrong a few times a year and silently
 * requests contracts that do not exist. The only source of truth is the list
 * the exchange feed returns; this module filters and orders it and nothing
 * more.
 */

/**
 * Indian derivatives expire on an IST calendar date, so "has this expired?"
 * must be asked in IST — never in UTC and never in the browser's local zone.
 *
 * `new Date().toISOString().slice(0, 10)` — what the Sentinel hooks used before
 * this module — is the UTC date. Between 00:00 and 05:30 IST that is YESTERDAY,
 * so a trader opening the workspace early on expiry-day+1 would have been
 * offered a contract that had already stopped trading, and a pre-open session
 * (09:00 IST is 03:30 UTC) sits inside that window every single day.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The current trading calendar date in IST, as `YYYY-MM-DD`.
 *
 * Takes `now` rather than reading the clock so every caller — and every test —
 * can be explicit about which instant it is asking about. Callers that genuinely
 * mean "right now" pass nothing.
 */
export function tradingDateIso(now: Date | number = Date.now()): string {
  const ms = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('tradingDateIso: `now` is not a valid instant');
  // Shift into IST, then read the UTC fields — the standard trick for "the
  // calendar date in zone X" without pulling in a timezone library. India has
  // a fixed +05:30 offset and no daylight saving, so this is exact.
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * One expiry, normalised to canonical ISO `YYYY-MM-DD`, or null if it is not a
 * real date.
 *
 * Accepts the shapes a market-data provider actually emits — bare ISO dates,
 * ISO datetimes (Dhan returns `2026-08-25 14:30:00` on some routes), and
 * day-first `DD-MM-YYYY` / `DD/MM/YYYY` — and rejects everything else rather
 * than guessing. Rejection is a first-class outcome: a malformed entry that
 * survived into the list would sort somewhere arbitrary and could be picked as
 * "nearest".
 *
 * ⚠️ Round-trip validated, so impossible dates do not pass. `2026-02-30`
 * matches the ISO shape and `new Date` happily rolls it to 2 March; comparing
 * the parsed date back to the input is what rejects it.
 */
export function normaliseExpiry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // An ISO datetime is an ISO date plus noise we do not need. Split on either
  // separator so `2026-08-25T00:00:00Z` and `2026-08-25 14:30:00` both reduce.
  const datePart = trimmed.split(/[T ]/)[0];

  let iso: string | null = null;
  if (ISO_DATE_RE.test(datePart)) {
    iso = datePart;
  } else {
    // Day-first, with either separator. Anchored so `1-2-2026-garbage` fails.
    const dayFirst = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(datePart);
    if (dayFirst) {
      const [, d, m, y] = dayFirst;
      iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }
  if (iso === null) return null;

  const m = ISO_DATE_RE.exec(iso);
  if (!m) return null;
  const [, year, month, day] = m;
  // UTC midnight, so the round-trip comparison is not perturbed by any local
  // offset. The value being validated is a calendar date, not an instant.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // The round-trip: a rolled-over date (30 Feb -> 2 Mar) no longer matches.
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return iso;
}

/**
 * A provider's raw expiry list, normalised: malformed entries dropped,
 * duplicates collapsed, chronological.
 *
 * Non-array input yields `[]` — a provider that answered with an object or
 * `null` has told us nothing, and nothing is the honest normalisation of that.
 * Whether that means "no options market" or "the read failed" is a question
 * about the RESPONSE, decided by the caller (see `ExpiryListUnreadableError`
 * in apps/web and `describeFault` in the bridge); it is not decidable here.
 */
export function normaliseExpiryList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const iso = normaliseExpiry(entry);
    if (iso) seen.add(iso);
  }
  // ISO dates are lexicographically ordered, so a plain sort IS chronological.
  return [...seen].sort();
}

/**
 * The expiries that have not expired yet, soonest first.
 *
 * `>= todayIso` — an expiry is live THROUGH its own expiry day. NSE contracts
 * trade until 15:30 IST on the expiry date itself, so the 25 Aug series is a
 * perfectly valid thing to watch on the morning of 25 Aug, and dropping it at
 * midnight would roll the workspace off a contract that is still trading and
 * still has a live chain.
 */
export function liveExpiries(expiries: readonly string[], todayIso: string): string[] {
  return normaliseExpiryList(expiries as unknown[]).filter((e) => e >= todayIso);
}

/**
 * Is this expiry one the market is actually offering right now?
 *
 * Both halves matter and neither implies the other: an expiry can be in the
 * future and absent from the list (delisted, or a different symbol's series),
 * or present in a stale list and already past. The guard before every
 * option-chain request asks THIS question, so a known-dead contract is never
 * sent upstream.
 */
export function isValidFutureExpiry(
  expiry: string | null | undefined,
  availableExpiries: readonly string[],
  todayIso: string,
): boolean {
  const iso = normaliseExpiry(expiry);
  if (iso === null) return false;
  return liveExpiries(availableExpiries, todayIso).includes(iso);
}

/**
 * `2026-08-25` -> `25 Aug`. THE display form, so the label beside a contract
 * and the label in an error message cannot be produced by two different rules.
 *
 * Presentation only. Never store this, never send it, never compare with it —
 * it has no year, so two `25 Aug`s a year apart are indistinguishable.
 */
export function displayExpiry(expiry: string | null | undefined): string {
  const iso = normaliseExpiry(expiry);
  if (iso === null) return '';
  const [, month, day] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const name = months[Number(month) - 1];
  return name ? `${Number(day)} ${name}` : iso;
}

/** Where the resolved expiry came from. Reported on the wire so a client can
 *  never be left guessing whether its request was honoured. */
export type ExpirySource =
  /** The caller asked for a valid, listed expiry and got exactly it. */
  | 'requested'
  /** Resolved from the provider's list — either no request, or the request was rejected. */
  | 'market_api'
  /** Nothing could be resolved; the list had no live expiry. */
  | 'none';

/** Why a requested expiry was not honoured. Null when it was, or when none was asked for. */
export type ExpiryRollReason = 'expired' | 'not-listed' | 'malformed' | null;

export interface ExpiryResolution {
  symbol: string;
  status: 'resolved' | 'unavailable';
  /** Canonical ISO `YYYY-MM-DD`. THE value every downstream stage must use. */
  value: string | null;
  /** Human label for `value`. Presentation only — see `displayExpiry`. */
  display: string;
  /** The normalised request, or null if the caller did not name one. */
  requested: string | null;
  /** True when a request WAS named and something else was resolved instead. */
  autoRolled: boolean;
  rollReason: ExpiryRollReason;
  source: ExpirySource;
  /** The live, normalised, chronological list the decision was made from. */
  available: string[];
  /** The IST trading date the decision was made against. */
  tradingDate: string;
}

export interface ResolveActiveExpiryInput {
  symbol: string;
  /** Exactly what the provider returned. Normalisation happens here, not at the call site. */
  availableExpiries: readonly string[];
  /** The instant to judge against. Defaults to now; tests and replays pass their own. */
  currentTime?: Date | number;
  /**
   * The expiry the caller currently believes it is on — restored state, a query
   * parameter, a manual selection. Honoured when it is still valid, replaced
   * when it is not. `null`/absent means "just give me the active one".
   */
  requestedExpiry?: string | null;
}

/**
 * Resolve the expiry every downstream stage must use.
 *
 * ── THE TWO RULES, AND WHY THEY ARE THESE TWO ──────────────────────────────
 *
 * 1. A valid request is ALWAYS honoured. An operator who deliberately chose a
 *    later series must not have it dragged back to the front month on the next
 *    poll — that is a control that undoes itself while you watch, and it is why
 *    this cannot simply be "always pick the earliest".
 *
 * 2. An INVALID request is always replaced, never sent on. Expired, delisted or
 *    malformed, the answer is the earliest live expiry the provider is
 *    currently offering. Passing it through is what produced the 2026-08-19
 *    screenshot: a request for a contract that had stopped trading, an empty
 *    chain in reply, and a panel reporting that as though the market were down.
 *
 * The replacement is reported (`autoRolled`, `rollReason`), never silent. A
 * roll the operator cannot see is the same failure in a nicer costume: the
 * screen would agree with itself while describing a series nobody chose.
 */
export function resolveActiveExpiry(input: ResolveActiveExpiryInput): ExpiryResolution {
  const { symbol, availableExpiries, currentTime = Date.now(), requestedExpiry = null } = input;

  const tradingDate = tradingDateIso(currentTime);
  const available = liveExpiries(availableExpiries, tradingDate);

  // Held separately from the normalised form: the caller asked for SOMETHING,
  // and "you sent us nonsense" is a different answer from "you sent us nothing".
  const askedFor = typeof requestedExpiry === 'string' ? requestedExpiry.trim() : '';
  const requested = normaliseExpiry(requestedExpiry);
  const requestWasMade = askedFor.length > 0;

  const base = { symbol, requested, available, tradingDate };

  if (available.length === 0) {
    // No live expiry to offer. Deliberately NOT "fall back to the last known"
    // — that is precisely the stale contract this module exists to stop, and a
    // caller that cannot name a contract must say so rather than name a dead
    // one. Whether this means "no options market" or "the feed is down" is not
    // answerable from a list, so it is not answered here.
    return {
      ...base,
      status: 'unavailable',
      value: null,
      display: '',
      autoRolled: false,
      rollReason: null,
      source: 'none',
    };
  }

  if (requested !== null && available.includes(requested)) {
    return {
      ...base,
      status: 'resolved',
      value: requested,
      display: displayExpiry(requested),
      autoRolled: false,
      rollReason: null,
      source: 'requested',
    };
  }

  // `available` is sorted ascending by `liveExpiries`, so [0] is the earliest
  // live expiry — the active series.
  const resolved = available[0];
  return {
    ...base,
    status: 'resolved',
    value: resolved,
    display: displayExpiry(resolved),
    autoRolled: requestWasMade,
    rollReason: !requestWasMade
      ? null
      : requested === null
        ? 'malformed'
        : // Past the trading date vs. simply not offered. Both are replaced, but
          // an operator reading a log needs to know whether the contract died or
          // was never listed for this symbol.
          requested < tradingDate
          ? 'expired'
          : 'not-listed',
    source: 'market_api',
  };
}

/**
 * One structured line describing a resolution, for the log.
 *
 * Exists so the bridge and the workspace print the SAME line: when the two
 * disagree about an expiry again, the two logs can be read side by side without
 * first working out whose format is whose. Field order matches the order the
 * decision is made in — what was asked, what was on offer, what came back.
 */
export function describeExpiryResolution(r: ExpiryResolution): string {
  return [
    'ExpiryResolver',
    `symbol=${r.symbol}`,
    `requested=${r.requested ?? '-'}`,
    `available=[${r.available.join(',')}]`,
    `resolved=${r.value ?? '-'}`,
    `tradingDate=${r.tradingDate}`,
    `autoRolled=${r.autoRolled}`,
    r.rollReason ? `rollReason=${r.rollReason}` : null,
    `source=${r.source}`,
  ]
    .filter(Boolean)
    .join(' ');
}
