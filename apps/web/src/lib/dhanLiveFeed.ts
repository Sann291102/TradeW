const DHAN_LIVE_URL = process.env.NEXT_PUBLIC_DHAN_LIVE_URL || '/feed';

/**
 * Client for the standalone Dhan live-feed bridge
 * (services/market-data/scripts/live-feed-server.ts) — a read-only, no-DB,
 * no-auth server that wraps the real `DhanMarketFeed` client so the dashboard
 * can show genuine broker ticks without Postgres or a login. Separate from
 * `marketData.ts`, which talks to services/api's DB-backed, auth-gated,
 * simulated-engine routes.
 */

export interface DhanLiveQuote {
  instrumentId: string;
  symbol: string;
  displayName: string;
  ltp: number;
  change: number;
  changePct: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  bid: number;
  ask: number;
  volume: number;
  marketStatus: 'open' | 'closed';
  updatedAt: string;
  source: 'dhan';
}

export interface DhanLiveSnapshot {
  marketOpen: boolean;
  indices: DhanLiveQuote[];
  stocks: DhanLiveQuote[];
  etfs: DhanLiveQuote[];
  commodities: DhanLiveQuote[];
}

export async function fetchDhanQuotes(): Promise<DhanLiveSnapshot> {
  const res = await fetch(`${DHAN_LIVE_URL}/quotes`);
  if (!res.ok) throw new Error(`dhan live-feed bridge returned ${res.status}`);
  return res.json();
}

/**
 * Does this quote carry a real price?
 *
 * ── THE ZERO GUARD (client half). READ BEFORE REMOVING. ───────────────────
 *
 * Nothing on this feed — index, stock, ETF, or commodity future — trades at 0.
 * An LTP of 0, NaN, or a missing number means the bridge does not know the
 * price, not that the price is zero.
 *
 * Every widget on the dashboard decides "is the feed real?" by asking whether
 * the snapshot has any rows, then renders whatever rows it finds. So a single
 * priceless row is not a harmless blank: it is a confident `0.00` under the
 * word NIFTY, next to a green MARKET CLOSED badge, on a screen people trade
 * from. That shipped on 2026-08-31, when the bridge began seeding a `ltp: 0`
 * placeholder for every tracked instrument at boot.
 *
 * The bridge no longer sends those (see `isPriced` in live-feed-server.ts).
 * This is the second lock: the browser does not trust the bridge to have got
 * it right, because the failure is silent, plausible, and expensive.
 */
export function isPricedQuote(q: DhanLiveQuote): boolean {
  return typeof q.ltp === 'number' && Number.isFinite(q.ltp) && q.ltp > 0;
}

/**
 * The same snapshot with every priceless row dropped.
 *
 * Dropping rather than zeroing is the point: an absent symbol makes each
 * widget take its own honest path (preview data, an empty state, a dash),
 * whereas a present-but-zero row makes all of them draw a price.
 */
export function withPricedQuotes(snapshot: DhanLiveSnapshot): DhanLiveSnapshot {
  return {
    marketOpen: snapshot.marketOpen,
    indices: (snapshot.indices ?? []).filter(isPricedQuote),
    stocks: (snapshot.stocks ?? []).filter(isPricedQuote),
    etfs: (snapshot.etfs ?? []).filter(isPricedQuote),
    commodities: (snapshot.commodities ?? []).filter(isPricedQuote),
  };
}

/**
 * True when a snapshot carries no usable price at all — whether it arrived
 * empty (bridge booting, nothing subscribed) or full of priceless rows (a
 * refused Dhan credential, a closed market the pre-fetch could not cover).
 * Both mean the same thing to the UI, so they are one predicate: show the
 * labelled preview and say the feed is unreachable.
 */
export function hasNoPricedQuotes(snapshot: DhanLiveSnapshot): boolean {
  const priced = withPricedQuotes(snapshot);
  return (
    priced.indices.length === 0 &&
    priced.stocks.length === 0 &&
    priced.etfs.length === 0 &&
    priced.commodities.length === 0
  );
}

/** One real OHLC candle from Dhan's Historical Data API (timestamp in ms). */
export interface DhanCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Real historical candles for the TradingView (lightweight-charts) charts,
 * from the bridge's `/candles` route (which proxies Dhan's charged, cached
 * Historical Data REST API).
 *
 * Two failure shapes, deliberately kept apart so the chart can name the right
 * one (see `CandlesUnavailableReason`):
 *  - THROWS when the bridge or Dhan itself faulted ('api-unreachable').
 *  - Returns [] when the answer was good but empty — a symbol the bridge does
 *    not cover, or one Dhan holds no bars for ('no-history').
 * Neither path ever yields a fabricated series.
 */
export async function fetchDhanCandles(symbol: string, interval: string, days: number): Promise<DhanCandle[]> {
  const url = `${DHAN_LIVE_URL}/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&days=${days}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`market-data bridge returned ${res.status}`);
  const data = (await res.json()) as { candles?: DhanCandle[]; source?: string; error?: string };
  if (data.source === 'dhan') return Array.isArray(data.candles) ? data.candles : [];
  if (data.source === 'none') return [];
  throw new Error(data.error ?? `market-data bridge reported source '${data.source ?? 'unknown'}'`);
}

/**
 * REAL OHLC for one option contract, from the bridge's `/candles/option` route
 * (Dhan's historical API addressed by the contract's own securityId, resolved
 * out of the scrip master).
 *
 * This replaces the Black-Scholes-derived stand-in the contract chart used to
 * draw. That series could only approximate the shape, and once its scale anchor
 * drifted from the live premium it rendered a visible cliff at the final bar.
 *
 * Same two-shape contract as `fetchDhanCandles`: THROWS when the bridge or Dhan
 * faulted, returns [] when the contract simply has no bars. The caller needs
 * the difference to say "no traded history" versus "the data API declined" —
 * they are not the same message to a trader watching an illiquid strike.
 */
export async function fetchDhanOptionCandles(
  symbol: string,
  expiryIso: string,
  strike: number,
  optionType: 'CE' | 'PE',
  interval: string,
  days: number,
  /**
   * The securityId the caller believes this contract has, VERIFIED by the
   * bridge rather than trusted. Supplying it turns "the chart and the engine
   * are on the same contract" from an assumption into a checked fact: on a
   * mismatch the bridge fails the request instead of serving another
   * contract's bars under this label. Omitted, resolution is unchanged.
   */
  securityId?: string | null,
): Promise<DhanCandle[]> {
  const url =
    `${DHAN_LIVE_URL}/candles/option?symbol=${encodeURIComponent(symbol)}` +
    `&expiry=${encodeURIComponent(expiryIso)}&strike=${strike}&type=${optionType}` +
    `&interval=${encodeURIComponent(interval)}&days=${days}` +
    (securityId ? `&securityId=${encodeURIComponent(securityId)}` : '');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`market-data bridge returned ${res.status}`);
  const data = (await res.json()) as { candles?: DhanCandle[]; source?: string; error?: string };
  if (data.source === 'dhan') return Array.isArray(data.candles) ? data.candles : [];
  // 'none' — unresolvable contract or a malformed request. Nothing to draw,
  // but nothing faulted upstream either.
  if (data.source === 'none') return [];
  throw new Error(data.error ?? `market-data bridge reported source '${data.source ?? 'unknown'}'`);
}

/** One option leg (CE or PE) from Dhan's real Option Chain API. */
export interface DhanOptionLeg {
  ltp: number;
  previousClose: number;
  oi: number;
  previousOi: number;
  volume: number;
  previousVolume: number;
  iv: number;
  bid: number;
  ask: number;
  delta: number | null;
  theta: number | null;
  gamma: number | null;
  vega: number | null;
}

export interface DhanOptionStrike {
  strike: number;
  ce: DhanOptionLeg | null;
  pe: DhanOptionLeg | null;
}

export interface DhanOptionChain {
  spot: number | null;
  strikes: DhanOptionStrike[];
}

/**
 * Raised when the expiry list could not be READ, as distinct from an instrument
 * that genuinely has no options market.
 *
 * ── WHY A THROW AND NOT AN EMPTY ARRAY ────────────────────────────────────
 *
 * `fetchDhanExpiryList` used to `return []` for every failure — a non-2xx, a
 * network error, a named upstream fault in the body. `[]` is also the correct
 * answer for an ETF or a commodity, so the two became one value, and every
 * consumer that had to describe the situation to a user described the wrong one.
 *
 * The user-visible result, captured on 2026-08-17 while the bridge's Dhan
 * credential was being refused:
 *
 *   "NIFTY has no live option chain, so this watch will follow the underlying
 *    itself. Indices like NIFTY, BANKNIFTY, FINNIFTY and SENSEX have one."
 *
 * The message contradicts itself in consecutive clauses, which is what this
 * class of bug looks like from the outside: the UI had no way to say "I could
 * not find out", so it said the only other thing it knew how to say.
 */
export class ExpiryListUnreadableError extends Error {
  constructor(
    readonly reason: string,
    /** True when only an operator can fix it — e.g. a renewed Dhan credential. */
    readonly needsOperator: boolean,
  ) {
    super(reason);
    this.name = 'ExpiryListUnreadableError';
  }
}

/**
 * Real expiry dates (ISO `YYYY-MM-DD`) for an underlying's option chain, from
 * the bridge's `/optionchain/expirylist` route (proxying Dhan's Option Chain
 * API, server-side rate-limited — see live-feed-server.ts).
 *
 * Returns [] ONLY for symbols with genuinely no options market (ETFs,
 * commodities). Throws `ExpiryListUnreadableError` when the list could not be
 * read, so a caller can tell the two apart. See that class for why.
 */
export async function fetchDhanExpiryList(symbol: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${DHAN_LIVE_URL}/optionchain/expirylist?symbol=${encodeURIComponent(symbol)}`);
  } catch (err) {
    throw new ExpiryListUnreadableError(
      `The market-data bridge could not be reached (${err instanceof Error ? err.message : String(err)}).`,
      false,
    );
  }
  if (!res.ok) {
    throw new ExpiryListUnreadableError(`The market-data bridge answered HTTP ${res.status}.`, false);
  }
  const data = (await res.json().catch(() => null)) as
    | { expiries?: string[]; error?: string; fault?: string; needsOperator?: boolean }
    | null;
  if (!data) throw new ExpiryListUnreadableError('The market-data bridge returned an unreadable response.', false);
  // The bridge names its upstream faults now (see `describeFault` in
  // live-feed-server.ts). A named fault is never "this symbol has no options".
  if (data.fault || data.error) {
    throw new ExpiryListUnreadableError(
      data.fault === 'auth'
        ? 'The market-data feed’s broker credential was refused, so the option chain could not be read.'
        : data.fault === 'rate-limit'
          ? 'The option-chain feed is rate limited right now, so the chain could not be read.'
          : `The option chain could not be read (${data.error ?? data.fault}).`,
      data.needsOperator === true,
    );
  }
  if (!Array.isArray(data.expiries)) {
    throw new ExpiryListUnreadableError('The market-data bridge returned no expiry list.', false);
  }
  return data.expiries;
}

/**
 * Whether `symbol` has a live options market at all — the same
 * `/optionchain/expirylist` call as `fetchDhanExpiryList`, but distinguishing
 * "confirmed no options" (`false`) from "couldn't determine right now"
 * (`null`, e.g. bridge unreachable). That distinction matters to callers
 * that cache the result: a confirmed no is safe to cache indefinitely for
 * the session, an unknown is not (retry later instead of caching a false
 * negative). See useHasOptionChain, which is the actual consumer.
 */
export async function fetchDhanHasOptionChain(symbol: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${DHAN_LIVE_URL}/optionchain/expirylist?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) {
      console.error(`fetchDhanHasOptionChain(${symbol}): bridge returned ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { expiries?: string[]; error?: string };
    if (data.error) {
      console.error(`fetchDhanHasOptionChain(${symbol}): ${data.error}`);
      return null;
    }
    return Array.isArray(data.expiries) && data.expiries.length > 0;
  } catch (err) {
    console.error(`fetchDhanHasOptionChain(${symbol}): unreachable`, err);
    return null;
  }
}

/**
 * Real option chain (spot + every strike's CE/PE — OI, volume, LTP, IV, real
 * Greeks) for an underlying + expiry, from the bridge's `/optionchain`
 * route. Returns null on any failure/empty result; the caller reports that as
 * 'unavailable' rather than falling back to a fabricated chain.
 */
export async function fetchDhanOptionChain(symbol: string, expiryIso: string): Promise<DhanOptionChain | null> {
  try {
    const res = await fetch(`${DHAN_LIVE_URL}/optionchain?symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiryIso)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as DhanOptionChain & { error?: string };
    if (data.error || !Array.isArray(data.strikes) || data.strikes.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * One listed option contract's identity, from the bridge's `/instrument/option`
 * route — the same `optionContractIndex` (built from Dhan's scrip master) that
 * the bridge itself uses to subscribe a leg on the websocket and to address it
 * on the historical API.
 *
 * Mirrors `OptionInstrument` in `lib/sentinel/watchState.ts`.
 */
export interface DhanOptionInstrument {
  securityId: string;
  exchangeSegment: string;
  dhanInstrument: string;
  tradingSymbol: string;
  displayName: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE';
  lotSize: number | null;
  tickSize: number | null;
}

/**
 * Resolve (underlying, expiry, strike, side) to the contract that actually
 * trades — securityId, exchange segment, instrument class, lot and tick.
 *
 * ── WHY THIS IS THE EXISTING PATH AND NOT A NEW ONE ────────────────────────
 *
 * `/instrument/option` has existed on the bridge since the paper-execution work
 * and is already on the web origin's proxy allowlist (`feed-proxy-routes.mjs`).
 * `services/api`'s `resolveOptionInstrument` resolves contracts for the OMS
 * through the very same route. The Sentinel workspace was the only surface
 * addressing option contracts WITHOUT it, re-deriving each one from a strike
 * number at four separate call sites. This closes that gap by reusing the
 * resolver rather than adding a fifth derivation.
 *
 * Returns null for a contract the scrip master does not list, and null on any
 * transport fault. The caller must treat null as "cannot address this leg" and
 * refuse to start a watch on it — never as "use the strike number instead",
 * which is the state this replaced.
 */
export async function fetchDhanOptionInstrument(
  symbol: string,
  expiryIso: string,
  strike: number,
  optionType: 'CE' | 'PE',
): Promise<DhanOptionInstrument | null> {
  const url =
    `${DHAN_LIVE_URL}/instrument/option?symbol=${encodeURIComponent(symbol)}` +
    `&expiry=${encodeURIComponent(expiryIso)}&strike=${strike}&type=${optionType}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { instrument?: DhanOptionInstrument | null; error?: string };
    const instrument = data.instrument;
    if (!instrument || !instrument.securityId) return null;
    /**
     * Trust the request, verify the response.
     *
     * The bridge resolves an expiry with a ±1 day tolerance (a scrip-master
     * Date vs. a plain ISO day can differ by a timezone), so its echo of
     * `expiry` may legitimately differ from what was asked. `strike` and
     * `optionType` may not: a response naming a different side or a different
     * strike is a resolution fault, and accepting it would put a PE token in a
     * CE slot — the one outcome the pair selector exists to prevent.
     */
    if (instrument.strike !== strike || instrument.optionType !== optionType) return null;
    return { ...instrument, expiry: expiryIso, underlying: symbol };
  } catch {
    return null;
  }
}
