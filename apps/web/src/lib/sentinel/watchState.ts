import type { OptionType, WatchLeg, WatchSession } from './strategyApi';

/**
 * ONE canonical description of what the operator has pointed Sentinel at.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * Until 2026-08-18 the `/sentinel` workspace held FOUR independent copies of
 * "which market/strike am I on", none of which agreed with the others:
 *
 *   1. `SentinelWorkspace`      — `useState(DEFAULT_MARKET)`, drove `/observe`
 *                                 and the charts' fallback symbol.
 *   2. `OptionChainPanel`       — its own `ceStrike`/`peStrike`, rendered in the
 *                                 top-right toolbar with `onSelectionChange`
 *                                 NOT passed, so every pick went nowhere.
 *   3. `WatchCreator`           — its own `symbol`/`expiry`/`optionType`/
 *                                 `strike` behind a SECOND `MarketSelector`.
 *   4. `SentinelLiveCharts`     — its own nearest-expiry + ATM chain poll, used
 *                                 because the dashboard passed it a literal
 *                                 `ceStrike={null} peStrike={null}`.
 *
 * The charts therefore drew whatever their own poll resolved to, which is why
 * the market and strike controls "no longer controlled the charts": they never
 * reached them. See the root-cause note in `WatchContext.tsx`.
 *
 * Everything here is PURE. The React wiring lives in `WatchContext.tsx`; this
 * module holds the reconciliation rules so they can be tested without a DOM,
 * and so there is exactly one place that answers "what does changing the market
 * do to the strike?".
 */

/**
 * The identity of ONE listed option contract, exactly as the market-data
 * bridge resolves it out of Dhan's scrip master.
 *
 * ── WHY A NUMBER IS NOT AN INSTRUMENT ──────────────────────────────────────
 *
 * Until 2026-08-18 the selection carried `callStrike: 24200` and nothing else.
 * A strike number is not addressable: every consumer that needed the actual
 * contract — the candle fetch, the premium poll, the watch the engine runs —
 * re-derived it from (symbol, expiry, strike, side) on its own. Four
 * re-derivations of one fact is the same shape as the four copies of the
 * selection this file was written to collapse, and it has a sharper failure
 * mode: a re-derivation that silently finds nothing draws an empty chart, and
 * one that finds the WRONG row draws a confident, wrong chart.
 *
 * These fields are the bridge's `/instrument/option` response verbatim (see
 * `fetchDhanOptionInstrument`), which reads the same `optionContractIndex` the
 * bridge uses to subscribe the leg on the websocket and to fetch its candles.
 * One resolution, reused — not a parallel lookup.
 *
 * `optionType` is part of the identity ON PURPOSE, and is checked against the
 * leg it is being attached to (`attachInstrument`). It is what makes a CE slot
 * holding a PE token a detectable error rather than a silent one.
 */
export interface OptionInstrument {
  /** Dhan securityId — the token the feed, the candle API and the OMS address. */
  securityId: string;
  /** NSE_FNO for NIFTY/BANKNIFTY/stocks, BSE_FNO for SENSEX. Never assumed. */
  exchangeSegment: string;
  /** OPTIDX | OPTSTK — Dhan's historical API needs the exact instrument class. */
  dhanInstrument: string;
  tradingSymbol: string;
  displayName: string;
  underlying: string;
  /** ISO `YYYY-MM-DD`, the form the bridge and the chain both use. */
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE';
  lotSize: number | null;
  tickSize: number | null;
}

/** What the operator chose. The only writable market/strike state in the page. */
export interface WatchSelection {
  /** The market — the single value every consumer reads. */
  symbol: string;
  /** ISO `YYYY-MM-DD`. Null until the expiry list for `symbol` resolves. */
  expiry: string | null;
  /**
   * Which side the UI is currently HIGHLIGHTING. Not which leg exists.
   *
   * ⚠️ Renamed from `optionType` on 2026-08-18. Under the old name it was read
   * as "the option type of the watch", and the form used it to decide which
   * single strike was being edited — so the CE/PE toggle silently determined
   * which one leg reached the engine. Both legs are configured now and both are
   * sent; this only decides which one the panel emphasises and which one the
   * watch's rule evaluation runs on.
   */
  focusedSide: OptionType;
  /** The CALL leg drawn in the CE chart. */
  callStrike: number | null;
  /** The PUT leg drawn in the PE chart. */
  putStrike: number | null;
  /**
   * The resolved CALL contract for `callStrike`, or null while it is still
   * being resolved / could not be resolved. Cleared by every change that makes
   * it a different contract (market, expiry, strike), so a stale token can
   * never outlive the number it belongs to.
   */
  callInstrument: OptionInstrument | null;
  /** The resolved PUT contract for `putStrike`. Same lifecycle as the call. */
  putInstrument: OptionInstrument | null;
  /** True = watch the underlying itself; no option legs are part of the watch. */
  underlyingOnly: boolean;
  /**
   * The sentinel-py watch currently under observation in the Strategy Feed.
   *
   * Held HERE rather than inside the feed because selecting a watch repoints
   * the charts: with two copies, the feed and the charts could disagree about
   * which instrument is current — which is exactly what they used to do.
   */
  selectedWatchId: string | null;
}

/**
 * `watchMode` in the brief's vocabulary. Derived, never stored: a second
 * boolean that has to be kept in step with `underlyingOnly` is a second source
 * of truth for the same fact.
 */
export type WatchMode = 'option' | 'underlying';

export function watchMode(selection: WatchSelection): WatchMode {
  return selection.underlyingOnly ? 'underlying' : 'option';
}

/** One instrument, named the way it is addressed on the wire and on screen. */
export interface ResolvedInstrument {
  symbol: string;
  expiry: string | null;
  strike: number | null;
  optionType: 'CE' | 'PE' | null;
  /** What the chart header prints, so the identity is visible, not implied. */
  label: string;
  /**
   * The listed contract this leg addresses. Null on the underlying (which has
   * no option instrument) and on a leg whose token has not resolved yet.
   *
   * A consumer that needs to ADDRESS the contract reads this; one that only
   * needs to describe it can use `strike`/`optionType`. The distinction matters
   * because a null here means "I cannot address this yet", which is a reason to
   * withhold a chart — not a reason to guess one.
   */
  instrument: OptionInstrument | null;
}

/**
 * The three instruments the workspace draws, resolved from ONE selection.
 *
 * `call`/`put` are null when the selection cannot name a contract (no expiry
 * yet, no strike yet, or an explicit underlying-only watch). Null is drawn as
 * "no strike selected" — never silently swapped for the ATM contract, which
 * would put a chart on screen the operator did not choose.
 */
export interface ResolvedWatchContext {
  underlying: ResolvedInstrument;
  call: ResolvedInstrument | null;
  put: ResolvedInstrument | null;
}

export const DEFAULT_SELECTION: WatchSelection = {
  symbol: 'NIFTY',
  expiry: null,
  focusedSide: 'CE',
  callStrike: null,
  putStrike: null,
  callInstrument: null,
  putInstrument: null,
  underlyingOnly: false,
  selectedWatchId: null,
};

/** `2026-08-18` becomes `18 AUG` — the form the reference design prints. */
export function expiryTag(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' })
    .toUpperCase()
    .replace(',', '');
}

export function instrumentLabel(
  symbol: string,
  expiry: string | null,
  strike: number | null,
  side: 'CE' | 'PE' | null,
): string {
  if (strike == null || side == null) return symbol;
  return [symbol, expiryTag(expiry), strike, side === 'CE' ? 'CALL' : 'PUT'].filter(Boolean).join(' ');
}

/**
 * Selection to the instruments the charts, the engine and the feed all address.
 *
 * The single resolver. `SentinelLiveCharts` used to decide this for itself
 * (`reading?.strike ?? ceStrike ?? chain.ce[chain.atmIndex]?.strike`), which is
 * how a chart ended up on a contract nothing else in the page had chosen.
 */
export function resolveWatchContext(selection: WatchSelection): ResolvedWatchContext {
  const { symbol, expiry, callStrike, putStrike, underlyingOnly } = selection;

  const underlying: ResolvedInstrument = {
    symbol,
    expiry: null,
    strike: null,
    optionType: null,
    label: symbol,
    instrument: null,
  };

  // An underlying-only watch has no legs at all — not "legs we happen not to
  // have resolved yet". The distinction is what stops the CE/PE panels from
  // claiming to be part of a watch that deliberately excludes them.
  if (underlyingOnly || expiry === null) {
    return { underlying, call: null, put: null };
  }

  /**
   * The token is attached only when it genuinely describes THIS leg. A resolved
   * instrument left over from a previous strike would otherwise ride along and
   * point the chart at the contract the operator just moved away from — the
   * stale-quote failure `useOptionQuote` documents, one level up and with a
   * securityId behind it instead of a price.
   */
  const leg = (
    strike: number | null,
    side: 'CE' | 'PE',
    instrument: OptionInstrument | null,
  ): ResolvedInstrument | null =>
    strike == null
      ? null
      : {
          symbol,
          expiry,
          strike,
          optionType: side,
          label: instrumentLabel(symbol, expiry, strike, side),
          instrument: instrumentDescribes(instrument, symbol, expiry, strike, side) ? instrument : null,
        };

  return {
    underlying,
    call: leg(callStrike, 'CE', selection.callInstrument),
    put: leg(putStrike, 'PE', selection.putInstrument),
  };
}

/**
 * What survives when the operator picks a different market.
 *
 * A NIFTY strike is not a SENSEX strike and a NIFTY expiry is not a SENSEX
 * expiry, so both are dropped: keeping them would leave the CE chart requesting
 * a contract that does not exist and the panel reporting "no traded history"
 * for what is really a nonsense instrument. `underlyingOnly` is dropped too —
 * it is an answer about the PREVIOUS symbol's option market.
 *
 * The selected watch is dropped here and re-resolved against the new market by
 * `reconcileWatchSelection`.
 */
export function selectMarket(prev: WatchSelection, symbol: string): WatchSelection {
  if (symbol === prev.symbol) return prev;
  return {
    ...prev,
    symbol,
    expiry: null,
    callStrike: null,
    putStrike: null,
    // The tokens belong to the PREVIOUS symbol's contracts. Carrying them would
    // leave a securityId for a NIFTY leg attached to a SENSEX selection.
    callInstrument: null,
    putInstrument: null,
    underlyingOnly: false,
    selectedWatchId: null,
  };
}

/**
 * Changing the expiry keeps the market but drops the strikes.
 *
 * The 24200 strike of the 18 AUG series and the 24200 of the 25 AUG series are
 * different contracts with different premiums; carrying the number across would
 * silently repoint both option charts at a series the operator never chose.
 */
export function selectExpiry(prev: WatchSelection, expiry: string | null): WatchSelection {
  if (expiry === prev.expiry) return prev;
  return {
    ...prev,
    expiry,
    callStrike: null,
    putStrike: null,
    callInstrument: null,
    putInstrument: null,
    selectedWatchId: null,
  };
}

/**
 * Set one leg. Only that leg moves — the other leg, the index and their feeds
 * are untouched, which is what keeps an unrelated live series from being torn
 * down and rebuilt when the operator adjusts a strike.
 */
export function selectStrike(prev: WatchSelection, side: 'CE' | 'PE', strike: number | null): WatchSelection {
  const strikeKey = side === 'CE' ? 'callStrike' : 'putStrike';
  const instrumentKey = side === 'CE' ? 'callInstrument' : 'putInstrument';
  if (prev[strikeKey] === strike) return prev;
  // The OTHER leg — its strike AND its token — is untouched. This is the
  // property the whole pair rests on: moving the call must not disturb the put,
  // and `...prev` alone guarantees it as long as nothing here writes a shared
  // field. Asserted directly in watchState.test.ts.
  return { ...prev, [strikeKey]: strike, [instrumentKey]: null, selectedWatchId: null };
}

/**
 * Move the highlight. Nothing else — no leg is created, dropped or repointed.
 *
 * Under its old name (`selectSide` writing `optionType`) this was the control
 * that decided which single strike the form edited and therefore which one leg
 * the engine received. It is now presentation plus the choice of which leg the
 * watch's rules evaluate on, and both legs travel regardless.
 */
export function selectSide(prev: WatchSelection, focusedSide: OptionType): WatchSelection {
  return focusedSide === prev.focusedSide ? prev : { ...prev, focusedSide };
}

export function setUnderlyingOnly(prev: WatchSelection, underlyingOnly: boolean): WatchSelection {
  return underlyingOnly === prev.underlyingOnly ? prev : { ...prev, underlyingOnly };
}

/**
 * Does this saved watch describe the instrument currently selected?
 *
 * Used to keep the Strategy Feed and the selection in agreement: a watch on
 * NIFTY 24350 CE is NOT the current watch while the operator is looking at
 * NIFTY 24200 CE, and the feed must not present it as though it were.
 *
 * The side is deliberately NOT compared as an equality on `selection.optionType`.
 * A watch names ONE leg; the workspace draws BOTH legs of the same expiry, so a
 * PUT watch on the strike the operator has selected as their put leg is
 * genuinely the watch for what is on screen.
 */
export function watchMatchesSelection(watch: WatchSession, selection: WatchSelection): boolean {
  if (watch.symbol !== selection.symbol) return false;

  const legs = watchLegs(watch);
  if (legs.ce === null && legs.pe === null) {
    // An underlying watch matches an underlying selection on the same symbol.
    return selection.underlyingOnly;
  }
  if (selection.underlyingOnly) return false;
  if (watch.expiry !== null && selection.expiry !== null && watch.expiry !== selection.expiry) return false;

  /**
   * A leg the watch does not name cannot disagree with the screen.
   *
   * That is what keeps a LEGACY single-leg row matchable: it names one side, so
   * only that side is compared. A pair watch names both, so both must agree —
   * a watch on 24200 CE / 24300 PE is NOT the watch for a screen showing
   * 24200 CE / 24350 PE, and presenting it as one would put another pair's
   * events under the current pair's heading.
   */
  const agrees = (leg: WatchLeg | null, selected: number | null) => leg === null || leg.strike === selected;
  return agrees(legs.ce, selection.callStrike) && agrees(legs.pe, selection.putStrike);
}

/**
 * Adopt a saved watch as the current selection.
 *
 * Selecting a watch in the feed REPOINTS the whole workspace at that watch's
 * instrument rather than quietly repointing the charts alone. Before this, the
 * charts followed the watch (via `ChartFocus`) while the market control kept
 * showing whatever it showed, so the screen displayed two different answers to
 * "what am I on".
 *
 * BOTH legs are set to the watch's strike, not just the one it names. That is
 * the pair the three-chart panel exists to show — the leg Sentinel is reading
 * beside its opposite at the same strike, so "which side is actually moving
 * with the index" is one glance rather than two screens (see
 * knowledge/Patterns/2026-08-16 - Sentinel charts on the bars the engine
 * reads). `SentinelLiveCharts` did exactly this itself before the selection
 * became canonical; moving it here changes where the rule lives, not what it
 * does, and the operator can still move either leg afterwards.
 */
export function selectionFromWatch(prev: WatchSelection, watch: WatchSession): WatchSelection {
  const legs = watchLegs(watch);

  if (legs.ce === null && legs.pe === null) {
    return {
      ...prev,
      symbol: watch.symbol,
      expiry: null,
      callStrike: null,
      putStrike: null,
      callInstrument: null,
      putInstrument: null,
      underlyingOnly: true,
      selectedWatchId: watch.id,
    };
  }

  const expiry = watch.expiry ?? prev.expiry;
  const toInstrument = (leg: WatchLeg | null): OptionInstrument | null =>
    leg === null || expiry === null
      ? null
      : {
          securityId: leg.securityId,
          exchangeSegment: leg.exchangeSegment,
          dhanInstrument: leg.dhanInstrument,
          tradingSymbol: leg.tradingSymbol,
          displayName: leg.tradingSymbol,
          underlying: watch.symbol,
          expiry,
          strike: leg.strike,
          optionType: leg.optionType,
          lotSize: leg.lotSize,
          tickSize: leg.tickSize,
        };

  /**
   * A LEGACY row names one leg, so the other has no strike to adopt.
   *
   * The pre-2026-08-18 version mirrored the named leg onto BOTH, because the
   * panel had to draw two charts out of one number and an ATM-width pair was
   * the least-wrong guess available. With a real pair on new watches that guess
   * is no longer needed, and making it would overwrite a put the operator had
   * deliberately chosen with a copy of the call — the exact overwrite this
   * change exists to remove.
   *
   * So the unnamed leg is KEPT — but only while it still describes a contract
   * that exists in the new context. A watch on BANKNIFTY adopted while the
   * screen is on NIFTY must not leave a NIFTY strike sitting in the put slot of
   * a BANKNIFTY selection: the number would look plausible, resolve to no
   * instrument, and block the form with a fault the operator did not cause. The
   * same applies across an expiry change, where 24200 is a different contract.
   */
  const sameContext = watch.symbol === prev.symbol && expiry === prev.expiry;
  const keptStrike = (strike: number | null) => (sameContext ? strike : null);
  const keptInstrument = (instrument: OptionInstrument | null) => (sameContext ? instrument : null);

  return {
    ...prev,
    symbol: watch.symbol,
    expiry,
    focusedSide: (legs.focusedSide ?? prev.focusedSide) as OptionType,
    underlyingOnly: false,
    callStrike: legs.ce ? legs.ce.strike : keptStrike(prev.callStrike),
    putStrike: legs.pe ? legs.pe.strike : keptStrike(prev.putStrike),
    callInstrument: legs.ce ? toInstrument(legs.ce) : keptInstrument(prev.callInstrument),
    putInstrument: legs.pe ? toInstrument(legs.pe) : keptInstrument(prev.putInstrument),
    selectedWatchId: watch.id,
  };
}

/**
 * Keep `selectedWatchId` pointing at a watch that still exists AND still
 * describes the current selection.
 *
 * Returns the id to use, which may be null. Null means "no saved watch covers
 * what is on screen" — an honest state: the charts then fall back to what
 * `/observe` read for the selected market, and the feed says the setup it was
 * showing is not the current one rather than leaving another instrument's
 * events up as though they were live.
 *
 * NOTE: this never closes or mutates a server-side watch. A watch the operator
 * created keeps running in `services/sentinel-py` until they stop it; this is
 * only about which one the screen is currently reporting.
 */
export function reconcileWatchSelection(selection: WatchSelection, watches: WatchSession[]): string | null {
  const current = selection.selectedWatchId
    ? (watches.find((w) => w.id === selection.selectedWatchId) ?? null)
    : null;
  if (current && watchMatchesSelection(current, selection)) return current.id;

  const matching = watches.filter((w) => watchMatchesSelection(w, selection));
  if (matching.length === 0) return null;
  // A live watch outranks a closed one — a finished setup on the same contract
  // is history, not what the feed should present as current.
  return (matching.find((w) => w.state !== 'EXITED') ?? matching[0]).id;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE PAIR: instrument attachment, the request, and what blocks it
//
// Everything below exists because Sentinel observes THREE series together — the
// underlying, a call and a put — and has to be able to say which of the two
// legs is expressing the underlying's move. It cannot do that from one leg, and
// it cannot do it from two strike numbers either: it needs two addressable
// contracts. See `OptionInstrument` for why a number is not an address.
//
// ⚠️ Nothing here decides WHICH side is better. The pair is configured and both
// legs are handed to the engine; ranking them is the engine's evaluation of
// live structure, momentum, volatility, premium behaviour and liquidity, and
// hard-coding "bullish → CE" here would pre-empt exactly the judgement the
// agents exist to make. See ARCHITECTURE.md §4 and Rule 2.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Does this token describe exactly this contract?
 *
 * Every field is compared, including `optionType`. That comparison is the guard
 * against the failure the brief names outright — "do not allow a CE control to
 * accidentally select a PE instrument or vice versa". The controls are
 * separate, the ladders are separate, and this is the third check: even if a PE
 * token reached the call slot, it would not be treated as describing the call.
 */
export function instrumentDescribes(
  instrument: OptionInstrument | null,
  symbol: string,
  expiry: string | null,
  strike: number | null,
  side: 'CE' | 'PE',
): boolean {
  if (!instrument || expiry === null || strike === null) return false;
  return (
    instrument.underlying === symbol &&
    instrument.expiry === expiry &&
    instrument.strike === strike &&
    instrument.optionType === side
  );
}

/**
 * Attach a resolved contract to one leg.
 *
 * Refuses a token that does not describe the leg it is being attached to, and
 * refuses to touch the OTHER leg. Returning `prev` unchanged on a mismatch is
 * deliberate: the resolver is asynchronous, so a response for the strike the
 * operator has already moved away from can and does arrive late. Writing it
 * would silently re-point the leg at the contract they abandoned.
 */
export function attachInstrument(
  prev: WatchSelection,
  side: 'CE' | 'PE',
  instrument: OptionInstrument | null,
): WatchSelection {
  const key = side === 'CE' ? 'callInstrument' : 'putInstrument';
  const strike = side === 'CE' ? prev.callStrike : prev.putStrike;

  if (instrument === null) return prev[key] === null ? prev : { ...prev, [key]: null };
  if (!instrumentDescribes(instrument, prev.symbol, prev.expiry, strike, side)) return prev;
  if (prev[key]?.securityId === instrument.securityId) return prev;
  return { ...prev, [key]: instrument };
}

/** One leg of the request, as it goes on the wire. */
export type WatchLegRequest = WatchLeg;

/**
 * The complete watch configuration. Mirrors `CreateWatchInput` and is the
 * ONLY thing "Start watching" sends — there is no `selectedStrike` field and
 * no single-leg shorthand for the request to fall back to.
 */
export interface WatchPairRequest {
  strategyId: string;
  symbol: string;
  expiry: string | null;
  ce: WatchLegRequest | null;
  pe: WatchLegRequest | null;
  focusedSide: OptionType;
  watchMode: WatchMode;
  timeframe: string;
}

function legRequest(instrument: OptionInstrument | null): WatchLegRequest | null {
  if (!instrument) return null;
  return {
    strike: instrument.strike,
    optionType: instrument.optionType,
    securityId: instrument.securityId,
    exchangeSegment: instrument.exchangeSegment,
    tradingSymbol: instrument.tradingSymbol,
    dhanInstrument: instrument.dhanInstrument,
    lotSize: instrument.lotSize,
    tickSize: instrument.tickSize,
  };
}

/**
 * Build the request from the canonical selection.
 *
 * The legs are read out of `resolveWatchContext`, not off the selection
 * directly, so they pass through the same `instrumentDescribes` filter the
 * charts do. One consequence worth stating: a leg whose token is stale is
 * absent here rather than wrong, and `validateWatchPair` then refuses the
 * request. Absent-and-refused beats present-and-mismatched.
 */
export function buildWatchRequest(
  selection: WatchSelection,
  strategyId: string,
  timeframe: string,
): WatchPairRequest {
  const mode = watchMode(selection);
  const resolved = resolveWatchContext(selection);
  return {
    strategyId,
    symbol: selection.symbol,
    expiry: mode === 'underlying' ? null : selection.expiry,
    ce: mode === 'underlying' ? null : legRequest(resolved.call?.instrument ?? null),
    pe: mode === 'underlying' ? null : legRequest(resolved.put?.instrument ?? null),
    focusedSide: selection.focusedSide,
    watchMode: mode,
    timeframe,
  };
}

// ── validation ──────────────────────────────────────────────────────────────

/** Every distinct reason the pair cannot be watched, each with its own message. */
export type WatchProblemCode =
  | 'no-expiry'
  | 'expired'
  | 'chain-loading'
  | 'chain-unavailable'
  | 'chain-stale'
  | 'strike-missing'
  | 'strike-not-listed'
  | 'instrument-unresolved'
  | 'instrument-mismatch';

export interface WatchProblem {
  code: WatchProblemCode;
  /** The leg it concerns, or null for a problem with the pair as a whole. */
  side: 'CE' | 'PE' | null;
  message: string;
}

/**
 * How old a chain read may be before the pair is refused.
 *
 * `useOptionChainStrikes` polls every 4s, so 30s is roughly seven missed
 * cycles — comfortably past a transient hiccup and well short of a session.
 * The point is not the exact number: it is that a watch is never started
 * against a ladder that may no longer list the strikes it is validating.
 */
export const CHAIN_STALE_MS = 30_000;

/** What the validator needs to know about the live ladders. */
export interface PairLadders {
  status: 'loading' | 'live' | 'unavailable';
  ce: { strike: number }[];
  pe: { strike: number }[];
  /** Epoch ms of the last successful read; null when there has never been one. */
  fetchedAt: number | null;
}

/**
 * Can this pair be watched right now, and if not, exactly why?
 *
 * Returns EVERY problem rather than the first, because the two legs fail
 * independently and a form that reveals one fault at a time makes the operator
 * fix the call, click, and discover the put. Each code maps to its own sentence
 * in `WatchCreator` — "24337 is not a listed strike" and "the chain has not
 * loaded" are different problems with different fixes, and a single "invalid
 * selection" would hide which one it is.
 *
 * An underlying watch has nothing to validate here: it names no contracts, so
 * none of these can be wrong about it.
 */
export function validateWatchPair(
  selection: WatchSelection,
  ladders: PairLadders,
  now: number,
  todayIso: string,
): WatchProblem[] {
  if (watchMode(selection) === 'underlying') return [];

  const problems: WatchProblem[] = [];
  const push = (code: WatchProblemCode, side: 'CE' | 'PE' | null, message: string) =>
    problems.push({ code, side, message });

  if (selection.expiry === null) {
    push('no-expiry', null, 'Choose an expiry before starting the watch.');
    return problems;
  }
  if (selection.expiry < todayIso) {
    // A contract that has already expired has no live premium and no future
    // bars. Starting a watch on it would produce an observation feed that can
    // never advance, which reads as a broken engine rather than a dead contract.
    push('expired', null, `The ${selection.expiry} contracts have expired. Choose a later expiry.`);
    return problems;
  }

  if (ladders.status === 'loading') {
    push('chain-loading', null, 'The option chain is still loading.');
    return problems;
  }
  if (ladders.status === 'unavailable') {
    push('chain-unavailable', null, `No live option chain for ${selection.symbol} ${selection.expiry} right now.`);
    return problems;
  }
  if (ladders.fetchedAt === null || now - ladders.fetchedAt > CHAIN_STALE_MS) {
    push(
      'chain-stale',
      null,
      'The option chain has not refreshed recently, so these strikes cannot be confirmed as still listed.',
    );
    return problems;
  }

  const checkLeg = (side: 'CE' | 'PE') => {
    const strike = side === 'CE' ? selection.callStrike : selection.putStrike;
    const instrument = side === 'CE' ? selection.callInstrument : selection.putInstrument;
    const rows = side === 'CE' ? ladders.ce : ladders.pe;
    const word = side === 'CE' ? 'call' : 'put';

    if (strike === null) {
      push('strike-missing', side, `Select a ${word} strike.`);
      return;
    }
    // The ladder is per side, so this is also the check that a strike listed
    // only on the opposite side cannot be watched on this one.
    if (!rows.some((r) => r.strike === strike)) {
      push('strike-not-listed', side, `${strike} ${side} is not in the live option chain for this expiry.`);
      return;
    }
    if (!instrument) {
      push('instrument-unresolved', side, `The ${strike} ${side} contract could not be resolved to an instrument.`);
      return;
    }
    if (!instrumentDescribes(instrument, selection.symbol, selection.expiry, strike, side)) {
      // The token on file describes a different contract from the one selected.
      // Sending it would start a watch on an instrument the operator can see
      // they did not choose — the single worst outcome available here.
      push(
        'instrument-mismatch',
        side,
        `The resolved instrument for the ${word} leg does not match ${strike} ${side}.`,
      );
    }
  };

  checkLeg('CE');
  checkLeg('PE');
  return problems;
}

/** Both legs valid and addressable — the only state "Start watching" allows. */
export function canStartWatch(
  selection: WatchSelection,
  ladders: PairLadders,
  now: number,
  todayIso: string,
): boolean {
  return validateWatchPair(selection, ladders, now, todayIso).length === 0;
}

// ── reading a watch back ────────────────────────────────────────────────────

/**
 * The pair a watch names, however that watch was recorded.
 *
 * THE ONE PLACE that knows a pre-2026-08-18 row carries a single leg in
 * `strike`/`optionType` instead of `ce`/`pe`. Every consumer — the feed, the
 * cards, the timeline, the price poll, the reconciler — reads legs through
 * here, so the legacy shape is a shim with one call site's worth of surface
 * rather than a second single-strike code path living on in the UI.
 *
 * `legacy` is reported rather than hidden: a row that names one leg genuinely
 * says nothing about the other, and a caller that renders it as a complete pair
 * would be inventing the missing half.
 */
export interface LegBearing {
  symbol?: string | null;
  expiry?: string | null;
  /** LEGACY mirror columns. */
  strike?: string | number | null;
  optionType?: OptionType | null;
  ce?: WatchLeg | null;
  pe?: WatchLeg | null;
  focusedSide?: OptionType | null;
}

export function watchLegs(watch: LegBearing): {
  ce: WatchLeg | null;
  pe: WatchLeg | null;
  focusedSide: OptionType | null;
  legacy: boolean;
} {
  if (watch.ce || watch.pe) {
    return { ce: watch.ce ?? null, pe: watch.pe ?? null, focusedSide: watch.focusedSide ?? null, legacy: false };
  }

  const strike = watch.strike == null ? null : Number(watch.strike);
  if (watch.optionType == null || strike == null || !Number.isFinite(strike)) {
    return { ce: null, pe: null, focusedSide: null, legacy: false };
  }

  // Reconstructed from the legacy columns. The instrument fields are empty
  // strings rather than invented ids: the row never held a token, and a
  // fabricated securityId would be indistinguishable from a resolved one.
  const leg: WatchLeg = {
    strike,
    optionType: watch.optionType,
    securityId: '',
    exchangeSegment: '',
    tradingSymbol: '',
    dhanInstrument: '',
    lotSize: null,
    tickSize: null,
  };
  return {
    ce: watch.optionType === 'CE' ? leg : null,
    pe: watch.optionType === 'PE' ? leg : null,
    focusedSide: watch.optionType,
    legacy: true,
  };
}

/**
 * How a watch names itself on screen: `NIFTY 18 AUG 24200 CE / 24300 PE`.
 *
 * Replaces the `[symbol, strike, optionType].join(' ')` expression that was
 * repeated in five components, each of which could only ever print one leg.
 */
export function watchPairLabel(watch: LegBearing): string {
  const legs = watchLegs(watch);
  const symbol = watch.symbol ?? '—';
  if (!legs.ce && !legs.pe) return symbol;
  const tag = expiryTag(watch.expiry ?? null);
  const sides = [legs.ce, legs.pe].filter((l): l is WatchLeg => l !== null).map((l) => `${l.strike} ${l.optionType}`);
  return [symbol, tag, sides.join(' / ')].filter(Boolean).join(' ');
}
