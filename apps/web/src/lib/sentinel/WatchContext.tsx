'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { OptionType, WatchSession } from './strategyApi';
import { useExpiries, type ExpiriesResult } from './useExpiries';
import { useOptionChainStrikes, type OptionChainStrikes } from './useOptionChainStrikes';
import { useOptionInstruments, type PairInstruments } from './useOptionInstruments';
import {
  DEFAULT_SELECTION,
  attachInstrument,
  reconcileWatchSelection,
  resolveWatchContext,
  selectExpiry,
  selectMarket,
  selectSide,
  selectStrike,
  selectionFromWatch,
  setUnderlyingOnly,
  watchMode,
  type PairLadders,
  type ResolvedWatchContext,
  type WatchMode,
  type WatchSelection,
} from './watchState';

/**
 * The canonical market/strike context for the whole `/sentinel` workspace.
 *
 * ── ROOT CAUSE THIS CLOSES ─────────────────────────────────────────────────
 *
 * The market and strike controls stopped driving the charts in commit 5c651e2
 * (2026-08-11, "reference-design dashboard on real /observe data"). That
 * rebuild dropped `SentinelLiveCharts` from the page, and with it the two lines
 * that had connected the toolbar to the charts:
 *
 *     const [ceStrike, setCeStrike] = useState<number | null>(null);
 *     <OptionChainPanel symbol={symbol}
 *       onSelectionChange={({ ce, pe }) => { setCeStrike(ce); setPeStrike(pe); }} />
 *     <SentinelLiveCharts … ceStrike={ceStrike} peStrike={peStrike} />
 *
 * Commit 5349103 (2026-08-16) put the charts BACK, inside `SentinelDashboard`,
 * but hardcoded `ceStrike={null} peStrike={null}` — the wiring was never
 * restored. `OptionChainPanel` kept rendering in the toolbar with its
 * `onSelectionChange` prop unpassed, so from 2026-08-11 onward every strike the
 * operator picked there was written to component state nobody read, and the
 * charts silently drew their OWN nearest-expiry ATM poll instead.
 *
 * Meanwhile `WatchCreator` — the "Watch market" section — had grown a second
 * `MarketSelector` and a full second copy of market/expiry/side/strike. So the
 * page had two market dropdowns that never agreed and a set of charts that
 * listened to neither.
 *
 * ── WHAT THIS IS ───────────────────────────────────────────────────────────
 *
 * ONE provider holding ONE `WatchSelection`, plus the ONE option-chain read
 * derived from it. Everything downstream — `/observe`, the three charts, the
 * Strategy Feed, the watch creator, the toolbar's context badge — reads from
 * here. There is no other market/strike state in the workspace.
 *
 * ── WHY A CONTEXT AND NOT THE ZUSTAND STORE ────────────────────────────────
 *
 * `useWorkspaceStore` is the app-shell continuity store (tabs, panels, theme —
 * `WORKSPACE-CONTINUITY.md`). This state is scoped to one route and is torn
 * down with it; putting it in the global store would make it a fifth thing that
 * outlives the surface that owns it. Persistence (below) is handled directly,
 * which is the only thing the store was buying us here.
 *
 * ── THE ONE CHAIN READ ─────────────────────────────────────────────────────
 *
 * `useOptionChainStrikes` polls every 4s against a bridge that serialises
 * option-family calls behind a 3.1s floor. Three components used to call it on
 * `/sentinel` at once (the toolbar chain panel, the charts, the watch creator),
 * i.e. three independent timers hitting one rate-limited upstream for the same
 * ladder. It is called EXACTLY ONCE here and fanned out through context — the
 * same fix `useSentinel` documents for `/observe` and `useDhanLiveFeed` for the
 * tick stream. Do not add a second call site.
 *
 * ── TIMEFRAME IS NOT A FIELD HERE, ON PURPOSE ──────────────────────────────
 *
 * The brief lists `timeframe` as part of the canonical state. It is part of the
 * canonical *resolved* context, but it is not operator-writable and is not
 * stored: the series is whatever the ENGINE reads — `SNAPSHOT_INTERVAL` (15m)
 * for `/observe`, `rules.timeframe` for a sentinel-py watch — resolved through
 * `chartFocus.resolveSeries`, which also reproduces the bridge's silent `?? '5'`
 * substitution. A user-settable timeframe here would put the chart back on bars
 * the engine never read, which is the exact bug the 2026-08-16 work removed.
 * See knowledge/Patterns/2026-08-16 - Sentinel charts on the bars the engine
 * reads.
 */

const STORAGE_KEY = 'tradew-sentinel-watch-v1';

export interface SentinelWatchContextValue {
  /** The canonical selection. Read-only to consumers; write via the setters. */
  selection: WatchSelection;
  /** `option` | `underlying`, derived from `selection.underlyingOnly`. */
  mode: WatchMode;
  /** The instruments the charts and the engine address, resolved once. */
  instruments: ResolvedWatchContext;

  /** The expiry list for the selected market — one read, shared. */
  expiries: ExpiriesResult;
  /** The strike ladder for the selected market + expiry — one poll, shared. */
  chain: OptionChainStrikes;
  /**
   * Where each leg's contract resolution stands. Read by the form to say
   * "resolving…" / "that contract could not be resolved" per leg rather than
   * showing one combined state for two independent lookups.
   */
  legs: PairInstruments;
  /** The ladders in the shape `validateWatchPair` consumes. */
  ladders: PairLadders;

  setMarket: (symbol: string) => void;
  setExpiry: (expiry: string | null) => void;
  setSide: (side: OptionType) => void;
  setCallStrike: (strike: number | null) => void;
  setPutStrike: (strike: number | null) => void;
  setUnderlying: (underlyingOnly: boolean) => void;
  /** Adopt a saved watch: repoints the WHOLE workspace, not just the charts. */
  adoptWatch: (watch: WatchSession) => void;
  /**
   * Reconcile the selected watch id against the live watch list. Called by the
   * feed once per list change; a no-op when the current id is still correct.
   */
  syncWatches: (watches: WatchSession[]) => void;
}

const WatchCtx = createContext<SentinelWatchContextValue | null>(null);

/**
 * Restore the last selection so a refresh returns to the same market/strike.
 *
 * Read lazily on first render rather than in an effect: the workspace fires
 * `/observe` for `selection.symbol` immediately, and hydrating a beat later
 * would spend a request on the default market before switching to the real one.
 * `selectedWatchId` is deliberately NOT restored — whether that watch still
 * exists is a server fact, and `syncWatches` establishes it from the real list.
 */
function readStored(): WatchSelection {
  if (typeof window === 'undefined') return DEFAULT_SELECTION;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SELECTION;
    const parsed = JSON.parse(raw) as Partial<WatchSelection>;
    if (typeof parsed.symbol !== 'string' || !parsed.symbol) return DEFAULT_SELECTION;
    return {
      symbol: parsed.symbol,
      expiry: typeof parsed.expiry === 'string' ? parsed.expiry : null,
      focusedSide: parsed.focusedSide === 'PE' ? 'PE' : 'CE',
      callStrike: typeof parsed.callStrike === 'number' ? parsed.callStrike : null,
      putStrike: typeof parsed.putStrike === 'number' ? parsed.putStrike : null,
      /**
       * Tokens are NOT restored — they are re-resolved against the live scrip
       * master on mount.
       *
       * A securityId persisted before a weekend can name a contract that has
       * since expired or been re-listed, and a stale token is worse than no
       * token: the strike beside it still looks right, so nothing on screen
       * reveals that the chart and the watch are addressing a dead contract.
       * Re-resolving costs one call per leg and settles within a frame or two.
       */
      callInstrument: null,
      putInstrument: null,
      underlyingOnly: parsed.underlyingOnly === true,
      selectedWatchId: null,
    };
  } catch {
    return DEFAULT_SELECTION;
  }
}

export function SentinelWatchProvider({
  children,
  /** Test seam only — production always restores from storage. */
  initialSelection,
}: {
  children: ReactNode;
  initialSelection?: WatchSelection;
}) {
  /**
   * `useState` with a lazy initialiser, NOT `readStored()` inline: the reader
   * touches `localStorage`, and running it on every render would both cost a
   * parse per render and defeat the point of holding the value in state.
   *
   * Server-render returns `DEFAULT_SELECTION` (no `window`), so the first
   * client render can differ from the server's HTML. `/sentinel` is a client
   * component behind an entitlement check that already renders a third state
   * while the session resolves, so there is no server-rendered market label to
   * mismatch against.
   */
  // Resolved ONCE. `readStored()` touches localStorage, and a bare call in the
  // body (or inside `useRef(...)`, whose argument is evaluated every render)
  // would re-read and re-parse it on every render.
  const [initial] = useState<WatchSelection>(() => initialSelection ?? readStored());
  const [selection, setSelection] = useState<WatchSelection>(initial);

  /**
   * Did this session start from a selection the operator had already made?
   *
   * `readStored` returns the `DEFAULT_SELECTION` object itself when there is
   * nothing to restore, so identity answers the question exactly.
   *
   * Only meaningful for the one-time bootstrap in `syncWatches`: with nothing
   * restored, the default market is a guess, and opening on the watch the
   * operator is actually running is a better answer than making them re-pick
   * it. With something restored, that IS their choice and nothing overrides it.
   */
  const hadStoredRef = useRef(initial !== DEFAULT_SELECTION);
  const bootstrappedRef = useRef(false);

  // Persist everything except the watch id — see `readStored`.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      // Tokens are omitted alongside the watch id: both are facts about the
      // world rather than about the operator's choice, and both are
      // re-established on mount. See `readStored`.
      const {
        selectedWatchId: _omitId,
        callInstrument: _omitCall,
        putInstrument: _omitPut,
        ...persistable
      } = selection;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
    } catch {
      // A full or disabled localStorage must not take the workspace down; the
      // selection simply does not survive the next reload.
    }
  }, [selection]);

  const expiries = useExpiries(selection.symbol);

  /**
   * Settle the expiry as soon as the list for THIS market resolves.
   *
   * Only when it is still null: an operator who deliberately picked a later
   * series must not have it pulled back to the nearest on the next poll. A
   * confirmed 'none' means the instrument has no options market, which is what
   * `underlyingOnly` records — matching `WatchCreator`'s long-standing rule
   * that an UNREADABLE list is never allowed to force the underlying (that bug
   * started watches on the index without saying so, 2026-08-17).
   */
  useEffect(() => {
    if (expiries.status === 'ready') {
      setSelection((prev) => (prev.expiry === null ? { ...prev, expiry: expiries.nearest } : prev));
    } else if (expiries.status === 'none') {
      setSelection((prev) => (prev.underlyingOnly ? prev : { ...prev, underlyingOnly: true }));
    }
  }, [expiries.status, expiries.nearest]);

  /**
   * THE option-chain read for the workspace. Gated so nothing is fetched for a
   * watch on the underlying, and pinned to the chosen expiry rather than
   * re-resolving "nearest" independently — two components resolving nearest
   * separately is how they end up on two different series.
   */
  const chainEnabled = !selection.underlyingOnly && expiries.status === 'ready';
  const chain = useOptionChainStrikes(selection.symbol, chainEnabled, selection.expiry);

  /**
   * Fill empty legs from the real ladder's at-the-money row, and drop a leg the
   * new ladder does not list.
   *
   * The ATM default is resolved from the chain Dhan actually published — never
   * a rounded number — so a strike that reaches the charts is always one that
   * trades. Both legs are defaulted because the panel draws both; the operator
   * overrides either independently.
   */
  useEffect(() => {
    if (chain.status !== 'live') return;
    setSelection((prev) => {
      if (prev.underlyingOnly) return prev;
      const listed = (rows: { strike: number }[], current: number | null) =>
        current !== null && rows.some((r) => r.strike === current) ? current : null;

      const call = listed(chain.ce, prev.callStrike) ?? chain.ce[chain.atmIndex]?.strike ?? null;
      const put = listed(chain.pe, prev.putStrike) ?? chain.pe[chain.atmIndex]?.strike ?? null;
      if (call === prev.callStrike && put === prev.putStrike) return prev;
      return { ...prev, callStrike: call, putStrike: put };
    });
    // `chain.expiry` is in the deps because a new expiry is a new ladder even
    // when the ATM index happens to land on the same row number.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.status, chain.atmIndex, chain.expiry]);

  /**
   * THE contract resolution for the workspace — one per leg, both independent.
   *
   * Gated on the same condition as the chain read: an underlying watch has no
   * legs to address. Note it is driven off `selection.callStrike`/`putStrike`
   * rather than off the chain, so a leg re-resolves exactly when the operator
   * moves it and at no other time.
   */
  const legs = useOptionInstruments(
    selection.symbol,
    selection.expiry,
    selection.callStrike,
    selection.putStrike,
    !selection.underlyingOnly,
  );

  /**
   * Fold each resolved contract into the canonical selection.
   *
   * `attachInstrument` is the guard, not this effect: it refuses a token that
   * does not describe the leg it is being attached to, so a response that
   * arrives after the operator has moved the strike is dropped rather than
   * written. Two separate effects, one per leg, so attaching the call can never
   * re-render a put that did not change.
   */
  useEffect(() => {
    setSelection((prev) => attachInstrument(prev, 'CE', legs.ce.instrument));
  }, [legs.ce.instrument]);

  useEffect(() => {
    setSelection((prev) => attachInstrument(prev, 'PE', legs.pe.instrument));
  }, [legs.pe.instrument]);

  /**
   * The ladders in the shape the validator reads. Derived here so the form and
   * anything else that needs to ask "can this pair be watched" reads ONE
   * description of the chain rather than each assembling its own.
   */
  const ladders = useMemo<PairLadders>(
    () => ({ status: chain.status, ce: chain.ce, pe: chain.pe, fetchedAt: chain.fetchedAt }),
    [chain.status, chain.ce, chain.pe, chain.fetchedAt],
  );

  const setMarket = useCallback((symbol: string) => setSelection((p) => selectMarket(p, symbol)), []);
  const setExpiry = useCallback((expiry: string | null) => setSelection((p) => selectExpiry(p, expiry)), []);
  const setSide = useCallback((side: OptionType) => setSelection((p) => selectSide(p, side)), []);
  const setCallStrike = useCallback((s: number | null) => setSelection((p) => selectStrike(p, 'CE', s)), []);
  const setPutStrike = useCallback((s: number | null) => setSelection((p) => selectStrike(p, 'PE', s)), []);
  const setUnderlying = useCallback((v: boolean) => setSelection((p) => setUnderlyingOnly(p, v)), []);
  const adoptWatch = useCallback((watch: WatchSession) => setSelection((p) => selectionFromWatch(p, watch)), []);

  /**
   * Keep the selected watch pointing at something that exists and still
   * describes what is on screen.
   *
   * Returns the SAME selection object when nothing changed. That matters: the
   * watch list re-polls on a timer and hands back a fresh array every time, so
   * anything keyed on array identity would re-render the workspace — and
   * restart the charts' data hooks — every poll. Same class of guard as
   * `observationKey` in `StrategyTimelineFeed`.
   *
   * The bootstrap decision is made OUTSIDE the updater because it mutates a
   * ref, and React may invoke an updater more than once.
   */
  const syncWatches = useCallback((watches: WatchSession[]) => {
    const bootstrap = !bootstrappedRef.current && !hadStoredRef.current && watches.length > 0;
    if (watches.length > 0) bootstrappedRef.current = true;

    setSelection((prev) => {
      if (bootstrap) {
        // Nothing was restored, so the default market is a guess. Open on the
        // watch the operator is actually running: market, expiry, strike, the
        // charts and the feed then agree from the first frame.
        const live = watches.find((w) => w.state !== 'EXITED') ?? watches[0];
        if (live) return selectionFromWatch(prev, live);
      }
      const next = reconcileWatchSelection(prev, watches);
      return next === prev.selectedWatchId ? prev : { ...prev, selectedWatchId: next };
    });
  }, []);

  const instruments = useMemo(() => resolveWatchContext(selection), [selection]);

  const value = useMemo<SentinelWatchContextValue>(
    () => ({
      selection,
      mode: watchMode(selection),
      instruments,
      expiries,
      chain,
      legs,
      ladders,
      setMarket,
      setExpiry,
      setSide,
      setCallStrike,
      setPutStrike,
      setUnderlying,
      adoptWatch,
      syncWatches,
    }),
    [
      selection,
      instruments,
      expiries,
      chain,
      legs,
      ladders,
      setMarket,
      setExpiry,
      setSide,
      setCallStrike,
      setPutStrike,
      setUnderlying,
      adoptWatch,
      syncWatches,
    ],
  );

  return <WatchCtx.Provider value={value}>{children}</WatchCtx.Provider>;
}

/**
 * The canonical watch context.
 *
 * Throws outside the provider rather than falling back to a default: a silent
 * default is a fifth copy of the state, and the whole point of this module is
 * that there are no other copies.
 */
export function useSentinelWatch(): SentinelWatchContextValue {
  const ctx = useContext(WatchCtx);
  if (!ctx) throw new Error('useSentinelWatch must be used inside <SentinelWatchProvider>');
  return ctx;
}
