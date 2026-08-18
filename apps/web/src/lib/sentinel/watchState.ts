import type { OptionType, WatchSession } from './strategyApi';

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

/** What the operator chose. The only writable market/strike state in the page. */
export interface WatchSelection {
  /** The market — the single value every consumer reads. */
  symbol: string;
  /** ISO `YYYY-MM-DD`. Null until the expiry list for `symbol` resolves. */
  expiry: string | null;
  /** Which side "Start watching" would create a watch on. */
  optionType: OptionType;
  /** The CALL leg drawn in the CE chart. */
  callStrike: number | null;
  /** The PUT leg drawn in the PE chart. */
  putStrike: number | null;
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
  optionType: 'CE',
  callStrike: null,
  putStrike: null,
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
  };

  // An underlying-only watch has no legs at all — not "legs we happen not to
  // have resolved yet". The distinction is what stops the CE/PE panels from
  // claiming to be part of a watch that deliberately excludes them.
  if (underlyingOnly || expiry === null) {
    return { underlying, call: null, put: null };
  }

  const leg = (strike: number | null, side: 'CE' | 'PE'): ResolvedInstrument | null =>
    strike == null
      ? null
      : { symbol, expiry, strike, optionType: side, label: instrumentLabel(symbol, expiry, strike, side) };

  return { underlying, call: leg(callStrike, 'CE'), put: leg(putStrike, 'PE') };
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
  return { ...prev, expiry, callStrike: null, putStrike: null, selectedWatchId: null };
}

/**
 * Set one leg. Only that leg moves — the other leg, the index and their feeds
 * are untouched, which is what keeps an unrelated live series from being torn
 * down and rebuilt when the operator adjusts a strike.
 */
export function selectStrike(prev: WatchSelection, side: 'CE' | 'PE', strike: number | null): WatchSelection {
  const key = side === 'CE' ? 'callStrike' : 'putStrike';
  if (prev[key] === strike) return prev;
  return { ...prev, [key]: strike, selectedWatchId: null };
}

export function selectSide(prev: WatchSelection, optionType: OptionType): WatchSelection {
  return optionType === prev.optionType ? prev : { ...prev, optionType };
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
  if (watch.strike == null || watch.optionType == null) {
    // An underlying watch matches an underlying selection on the same symbol.
    return selection.underlyingOnly;
  }
  if (selection.underlyingOnly) return false;
  if (watch.expiry !== null && selection.expiry !== null && watch.expiry !== selection.expiry) return false;
  const strike = Number(watch.strike);
  if (!Number.isFinite(strike)) return false;
  return watch.optionType === 'CE' ? strike === selection.callStrike : strike === selection.putStrike;
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
  const strike = watch.strike == null ? null : Number(watch.strike);
  const hasLeg = watch.optionType != null && strike != null && Number.isFinite(strike);

  if (!hasLeg) {
    return {
      ...prev,
      symbol: watch.symbol,
      expiry: null,
      callStrike: null,
      putStrike: null,
      underlyingOnly: true,
      selectedWatchId: watch.id,
    };
  }

  return {
    ...prev,
    symbol: watch.symbol,
    expiry: watch.expiry ?? prev.expiry,
    optionType: watch.optionType as OptionType,
    underlyingOnly: false,
    callStrike: strike as number,
    putStrike: strike as number,
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
