'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Badge, cn } from '@tradew/ui';
import { qk } from '@/lib/query/keys';
import { fmt, pct } from '@/lib/format';
import { blackScholesGreeks, type Greeks } from '@/lib/black-scholes';
import { useTradeBasketStore, useHydrateTradeBasket, contractKeyOf, type ContractKey } from '@/lib/store/tradeBasketStore';
import { EXPIRIES, ATM_STRIKE, strikeStepFor, formatExpiryLabel, resolveExpiry } from '@/lib/mock/optionChain';
import { fetchDhanExpiryList, fetchDhanOptionChain, type DhanOptionChain, type DhanOptionStrike } from '@/lib/dhanLiveFeed';
import { TradeIcon, SparkleIcon, BookmarkIcon, LayersIcon } from '@/components/shell/icons';
import { QuickActionsDock, type QuickAction } from './QuickActionsDock';
import { ContractAnalysisDrawer, type ContractAnalysisData } from './ContractAnalysisDrawer';

/** Number of strikes shown in the simulated (non-live) fallback table.
 *  For real Dhan data every strike the API returns is shown — traders need
 *  to scroll to far OTM strikes for hedges and spreads. */
const SIM_STRIKE_COUNT = 41; // ATM +/- 20
/** Dhan's option-chain REST endpoint is rate-limited to roughly one call every
 *  3s, which is the hard floor for OI/IV/Greeks refresh. Poll at that floor
 *  rather than the old 15s — the bridge's short response cache collapses
 *  duplicate requests from multiple tabs/components onto one upstream call, so
 *  polling faster here costs nothing upstream. (Per-strike LTP additionally
 *  arrives in real time over the websocket feed, which is not rate-limited.) */
const CHAIN_REFRESH_MS = 3_000;
const MAX_EXPIRY_TABS = 8;

interface Row {
  strike: number;
  callOi: number;
  callOiChangePct: number;
  callVolume: number;
  callLtp: number;
  callLtpChangePct: number;
  putOi: number;
  putOiChangePct: number;
  putVolume: number;
  putLtp: number;
  putLtpChangePct: number;
  ivPct: number;
  /** Real per-leg Greeks from Dhan, when this row came from the live chain
   *  (see `rowsFromLiveChain`) — used instead of the Black-Scholes estimate. */
  callGreeks?: Greeks | null;
  putGreeks?: Greeks | null;
}

/** `changePct` helper for a leg's LTP vs its previous close. */
function legChangePct(ltp: number, previousClose: number): number {
  return previousClose ? ((ltp - previousClose) / previousClose) * 100 : 0;
}

function toGreeks(leg: DhanOptionStrike['ce']): Greeks | null {
  if (!leg || leg.delta == null) return null;
  return { delta: leg.delta, gamma: leg.gamma ?? 0, theta: leg.theta ?? 0, vega: leg.vega ?? 0 };
}

/** Real Dhan chain -> the same `Row` shape the simulated table already
 *  renders. Returns ALL strikes so the trader can scroll to far OTM for
 *  hedges and spreads — the table container scrolls vertically. */
function rowsFromLiveChain(chain: DhanOptionChain): Row[] {
  return chain.strikes.map((s) => {
    const ivValues = [s.ce?.iv, s.pe?.iv].filter((v): v is number => v != null && v > 0);
    return {
      strike: s.strike,
      callOi: s.ce?.oi ?? 0,
      callOiChangePct: s.ce?.previousOi ? ((s.ce.oi - s.ce.previousOi) / s.ce.previousOi) * 100 : 0,
      callVolume: s.ce?.volume ?? 0,
      callLtp: s.ce?.ltp ?? 0,
      callLtpChangePct: s.ce ? legChangePct(s.ce.ltp, s.ce.previousClose) : 0,
      putOi: s.pe?.oi ?? 0,
      putOiChangePct: s.pe?.previousOi ? ((s.pe.oi - s.pe.previousOi) / s.pe.previousOi) * 100 : 0,
      putVolume: s.pe?.volume ?? 0,
      putLtp: s.pe?.ltp ?? 0,
      putLtpChangePct: s.pe ? legChangePct(s.pe.ltp, s.pe.previousClose) : 0,
      ivPct: ivValues.length > 0 ? ivValues.reduce((a, v) => a + v, 0) / ivValues.length : 0,
      callGreeks: toGreeks(s.ce),
      putGreeks: toGreeks(s.pe),
    };
  });
}

function buildRows(atm: number, strikeStep: number): Row[] {
  const rows: Row[] = [];
  const half = Math.floor(SIM_STRIKE_COUNT / 2);
  for (let i = -half; i <= half; i++) {
    const strike = atm + i * strikeStep;
    const dist = Math.abs(i);
    const callLtp = Math.max(4, 180 - i * 20 + Math.sin(i) * 6);
    const putLtp = Math.max(4, 60 + i * 22 + Math.cos(i) * 6);
    rows.push({
      strike,
      callOi: Math.round((12000 - dist * 900) * (1 + 0.15 * Math.sin(i * 1.7))),
      callOiChangePct: Math.sin(i * 1.3) * 45 + (i < 0 ? 15 : -8),
      callVolume: Math.round(4500 * Math.exp(-dist * 0.28) * (1 + 0.3 * Math.cos(i))),
      callLtp,
      callLtpChangePct: -20 - dist * 6 + Math.sin(i * 2) * 8,
      putOi: Math.round((9000 + dist * 1100) * (1 + 0.15 * Math.cos(i * 1.7))),
      putOiChangePct: Math.cos(i * 1.3) * 40 + (i > 0 ? 12 : -10),
      putVolume: Math.round(3800 * Math.exp(-dist * 0.24) * (1 + 0.3 * Math.sin(i))),
      putLtp,
      putLtpChangePct: -18 + dist * 5 + Math.cos(i * 2) * 8,
      ivPct: 12.5 + Math.pow(dist, 1.5) * 1.1,
    });
  }
  return rows;
}

/** Rank the top-4 OI values in a column, matching the reference's "OI 1..4" badges. */
function oiRanks(values: number[]): Map<number, number> {
  const ranked = values
    .map((v, i) => [v, i] as const)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 4);
  const ranks = new Map<number, number>();
  ranked.forEach(([, i], rank) => ranks.set(i, rank + 1));
  return ranks;
}

function ChangeCell({ value }: { value: number }) {
  return <span className={cn('text-[9.5px]', value >= 0 ? 'text-up' : 'text-down')}>({pct(value)})</span>;
}

interface OptionChainTabProps {
  /** Underlying symbol this chain belongs to — carried into contract nav
   *  links (Chart/Buy/Sell). Also picks the strike interval (strikeStepFor)
   *  and, with spotPrice, where the ladder is centered. */
  underlyingSymbol?: string;
  /** Real spot (Dhan LTP) when the caller has one — see ChartPanel, which
   *  passes its own already-live-aware `q.ltp`. Falls back to the fixed mock
   *  ATM_STRIKE (NIFTY-shaped) only when no live price is available at all,
   *  same as before this was wired up. */
  spotPrice?: number;
  initialExpiryLabel?: string;
  /** Called the moment the user acts on a contract (Open chart / Buy / Sell),
   *  so the host (ChartPanel) can switch to its Charts view immediately —
   *  even when re-selecting the same strike, where the URL is unchanged and
   *  the router push is a no-op, so nothing would otherwise "open". */
  onOpenChart?: () => void;
}

interface ExpiryOption {
  label: string;
  /** Real ISO date when this came from Dhan's expiry list; null for the
   *  simulated fallback table, which addresses expiries by label alone. */
  iso: string | null;
}

export function OptionChainTab({ underlyingSymbol = 'NIFTY', spotPrice, initialExpiryLabel, onOpenChart }: OptionChainTabProps) {
  useHydrateTradeBasket();
  const router = useRouter();
  const watchlist = useTradeBasketStore((s) => s.watchlist);
  const strategyLegs = useTradeBasketStore((s) => s.strategyLegs);
  const toggleWatchlist = useTradeBasketStore((s) => s.toggleWatchlist);
  const toggleStrategy = useTradeBasketStore((s) => s.toggleStrategy);

  // Real expiry dates from Dhan's Option Chain API (bridge's
  // /optionchain/expirylist route) — null while loading/not-yet-known,
  // [] once confirmed there are none (ETF/commodity, or unreachable), both
  // of which fall back to the simulated EXPIRIES table below.
  const [expiryIdx, setExpiryIdx] = useState(() => {
    const found = EXPIRIES.findIndex((e) => e.label === initialExpiryLabel);
    return found >= 0 ? found : 0;
  });
  const [chain, setChain] = useState<DhanOptionChain | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ContractAnalysisData | null>(null);

  // Shares the cached expiry list with Sentinel's `useExpiries` and the
  // ApplyStrategy dialog. It also gives the request a failure path it did not
  // have: the previous `.then()` carried no `.catch`, so a rejected list was an
  // unhandled promise rejection that left `liveExpiries` null forever.
  const expiryQuery = useQuery({
    queryKey: qk.optionChain.expiries(underlyingSymbol),
    queryFn: () => fetchDhanExpiryList(underlyingSymbol),
    staleTime: 60 * 60 * 1000,
  });

  const liveExpiries: ExpiryOption[] | null = useMemo(() => {
    if (!expiryQuery.data) return expiryQuery.isError ? [] : null;
    // Dhan's expiry list runs years out (monthly/yearly contracts beyond the
    // weeklies) — the tab row only needs the near-term ones a trader actually
    // picks from, same rough count as the old mock EXPIRIES table.
    return expiryQuery.data
      .slice(0, MAX_EXPIRY_TABS)
      .map((iso) => ({ label: formatExpiryLabel(iso), iso }));
  }, [expiryQuery.data, expiryQuery.isError]);

  useEffect(() => {
    if (!liveExpiries || liveExpiries.length === 0) return;
    const found = initialExpiryLabel ? liveExpiries.findIndex((e) => e.label === initialExpiryLabel) : -1;
    setExpiryIdx(found >= 0 ? found : 0);
    // initialExpiryLabel is only meant to apply on first resolve for a symbol
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlyingSymbol, liveExpiries]);

  const expiries: ExpiryOption[] = liveExpiries && liveExpiries.length > 0 ? liveExpiries : EXPIRIES.map((e) => ({ label: e.label, iso: null }));
  const expiry = expiries[expiryIdx] ?? expiries[0];
  const resolvedExpiry = (expiry.iso ? resolveExpiry(expiry.iso) : resolveExpiry(expiry.label)) ?? { label: expiry.label, days: EXPIRIES[0].days };
  const yearsToExpiry = resolvedExpiry.days / 365;

  // Real chain data for the selected underlying + expiry, refreshed on an
  // interval — the bridge itself caches/throttles the underlying Dhan calls,
  // so polling here never risks the rate limit regardless of how often this
  // fires or how many tabs are open.
  useEffect(() => {
    if (!expiry.iso) {
      setChain(null);
      return;
    }
    let cancelled = false;
    const iso = expiry.iso;
    const load = () =>
      fetchDhanOptionChain(underlyingSymbol, iso)
        .then((data) => {
          if (!cancelled) setChain(data);
        })
        // The bridge being briefly unreachable is not fatal: the table falls
        // back to its computed rows and the next tick tries again. Previously
        // this had no catch at all, so a failure was an unhandled rejection.
        .catch(() => undefined);
    load();
    // Skipped while the tab is hidden — a backgrounded terminal was refreshing
    // the whole chain on this cadence for a screen nobody could see.
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    }, CHAIN_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [underlyingSymbol, expiry.iso]);

  const live = chain != null && chain.strikes.length > 0;
  const STRIKE_STEP = strikeStepFor(underlyingSymbol);
  const SPOT = chain?.spot ?? spotPrice ?? ATM_STRIKE;
  const ATM = Math.round(SPOT / STRIKE_STEP) * STRIKE_STEP;

  const ROWS = useMemo(() => (live ? rowsFromLiveChain(chain!) : buildRows(ATM, STRIKE_STEP)), [live, chain, ATM, STRIKE_STEP]);

  // Find the two strikes that bracket the current spot price.
  // E.g. if spot = 24624.65 with 50-step, highlight both 24600 and 24650.
  const atmStrikes = useMemo(() => {
    const set = new Set<number>();
    if (ROWS.length === 0) return set;
    // Strike just below (or equal) spot
    const below = [...ROWS].reverse().find((r) => r.strike <= SPOT);
    // Strike just above (or equal) spot
    const above = ROWS.find((r) => r.strike >= SPOT);
    if (below) set.add(below.strike);
    if (above) set.add(above.strike);
    // If spot lands exactly on a strike, only that one will be in the set
    return set;
  }, [ROWS, SPOT]);

  // The "primary" ATM strike used for scroll targeting — the one closest to spot
  const primaryAtmStrike = useMemo(
    () => ROWS.reduce((closest, r) => (Math.abs(r.strike - SPOT) < Math.abs(closest.strike - SPOT) ? r : closest), ROWS[0])?.strike,
    [ROWS, SPOT],
  );

  const AVG_IV = useMemo(() => ROWS.reduce((a, r) => a + r.ivPct, 0) / ROWS.length, [ROWS]);
  const callOiRanks = useMemo(() => oiRanks(ROWS.map((r) => r.callOi)), [ROWS]);
  const putOiRanks = useMemo(() => oiRanks(ROWS.map((r) => r.putOi)), [ROWS]);

  // Auto-scroll the ATM row into the center of the viewport, but ONLY when:
  //  - the component first renders with data
  //  - the expiry tab changes
  //  - the ATM strike itself shifts (spot moved far enough to change which strike is closest)
  // This avoids fighting user scrolling on every 3s data poll.
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const atmRowRef = useRef<HTMLTableRowElement>(null);
  const lastScrolledAtmRef = useRef<string | null>(null);
  useEffect(() => {
    const scrollKey = `${expiry.label}:${primaryAtmStrike}`;
    if (scrollKey === lastScrolledAtmRef.current) return; // ATM hasn't changed — don't scroll

    // Double-rAF: first rAF fires after React commits the DOM (refs are set),
    // second rAF fires after the browser has completed layout of those new rows.
    // This guarantees the ATM row element exists and has its final position.
    const frame1 = requestAnimationFrame(() => {
      const frame2 = requestAnimationFrame(() => {
        const row = atmRowRef.current;
        const container = tableContainerRef.current;
        if (!row || !container) return;
        lastScrolledAtmRef.current = scrollKey;

        // Calculate where the row is relative to the container's scroll viewport,
        // then scroll so the row is centered vertically in the container.
        const rowRect = row.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const rowMiddle = rowRect.top + rowRect.height / 2;
        const containerMiddle = containerRect.top + containerRect.height / 2;
        const scrollOffset = rowMiddle - containerMiddle;
        container.scrollTop = container.scrollTop + scrollOffset;
      });
      cleanupRef = frame2;
    });
    let cleanupRef = frame1;
    return () => cancelAnimationFrame(cleanupRef);
  }, [ROWS, primaryAtmStrike, expiry.label]);

  const totalCallOi = ROWS.reduce((a, r) => a + r.callOi, 0);
  const totalPutOi = ROWS.reduce((a, r) => a + r.putOi, 0);
  const pcr = totalCallOi > 0 ? totalPutOi / totalCallOi : 0;

  function contractKey(strike: number, optionType: 'CE' | 'PE'): ContractKey {
    return { underlying: underlyingSymbol, strike, optionType, expiryLabel: expiry.label };
  }

  function navigateToContract(strike: number, optionType: 'CE' | 'PE', action?: 'buy' | 'sell') {
    // Switch the host to the chart right away — covers re-selecting the same
    // strike, where the query string doesn't change and router.push is a no-op.
    onOpenChart?.();
    const params = new URLSearchParams({
      symbol: underlyingSymbol,
      strike: String(strike),
      type: optionType,
      // Real ISO date when live so the /trade page's Black-Scholes day-count
      // (contract chart, IV) resolves against the real expiry too — see
      // resolveExpiry. Falls back to the mock label otherwise, unchanged.
      expiry: expiry.iso ?? expiry.label,
    });
    if (action) params.set('action', action);
    router.push(`/trade?${params.toString()}`);
  }

  function actionsFor(strike: number, optionType: 'CE' | 'PE', ltp: number, ltpChangePct: number, ivPct: number): QuickAction[] {
    const key = contractKey(strike, optionType);
    const inWatchlist = watchlist.some((w) => contractKeyOf(w) === contractKeyOf(key));
    const inStrategy = strategyLegs.some((w) => contractKeyOf(w) === contractKeyOf(key));
    const row = ROWS.find((r) => r.strike === strike);
    const realGreeks = optionType === 'CE' ? row?.callGreeks : row?.putGreeks;
    const greeks = realGreeks ?? blackScholesGreeks(SPOT, strike, yearsToExpiry, ivPct, optionType === 'CE' ? 'call' : 'put');
    return [
      { key: 'buy', label: 'Buy', icon: <span className="text-[10px] font-bold">B</span>, tone: 'up', onClick: () => navigateToContract(strike, optionType, 'buy') },
      { key: 'sell', label: 'Sell', icon: <span className="text-[10px] font-bold">S</span>, tone: 'down', onClick: () => navigateToContract(strike, optionType, 'sell') },
      { key: 'chart', label: 'Open chart', icon: <TradeIcon className="h-3 w-3" />, onClick: () => navigateToContract(strike, optionType) },
      {
        key: 'analyze',
        label: 'Analyze',
        icon: <SparkleIcon className="h-3 w-3" />,
        tone: 'teal',
        onClick: () => {
          if (!row) return;
          setAnalysis({
            underlying: underlyingSymbol,
            strike,
            optionType,
            expiryLabel: expiry.label,
            ltp,
            ltpChangePct,
            ivPct,
            oi: optionType === 'CE' ? row.callOi : row.putOi,
            oiChangePct: optionType === 'CE' ? row.callOiChangePct : row.putOiChangePct,
            volume: optionType === 'CE' ? row.callVolume : row.putVolume,
            greeks,
            ivVsAverage: ivPct - AVG_IV,
          });
        },
      },
      { key: 'watchlist', label: inWatchlist ? 'Remove from watchlist' : 'Add to watchlist', icon: <BookmarkIcon className="h-3 w-3" />, active: inWatchlist, onClick: () => toggleWatchlist(key) },
      { key: 'strategy', label: inStrategy ? 'Remove from strategy' : 'Add to strategy', icon: <LayersIcon className="h-3 w-3" />, active: inStrategy, onClick: () => toggleStrategy(key) },
    ];
  }

  // Calculate summary metrics matching reference image.png
  const maxCallOiRow = useMemo(() => ROWS.reduce((max, r) => (r.callOi > max.callOi ? r : max), ROWS[0]), [ROWS]);
  const maxPutOiRow = useMemo(() => ROWS.reduce((max, r) => (r.putOi > max.putOi ? r : max), ROWS[0]), [ROWS]);
  
  const maxPainStrike = useMemo(() => {
    if (ROWS.length === 0) return ATM;
    let minLoss = Infinity;
    let bestStrike = ATM;
    for (const targetRow of ROWS) {
      const s = targetRow.strike;
      let totalLoss = 0;
      for (const r of ROWS) {
        if (s > r.strike) totalLoss += (s - r.strike) * r.callOi;
        if (s < r.strike) totalLoss += (r.strike - s) * r.putOi;
      }
      if (totalLoss < minLoss) {
        minLoss = totalLoss;
        bestStrike = s;
      }
    }
    return bestStrike;
  }, [ROWS, ATM]);

  const fmtCr = (val: number) => (val >= 10_000_000 ? `${(val / 10_000_000).toFixed(2)} Cr` : val >= 100_000 ? `${(val / 100_000).toFixed(2)} L` : val.toLocaleString('en-IN'));

  return (
    <div className="flex flex-1 flex-col space-y-3 p-3">
      {/* 7 Summary Stat Tiles (reference image.png) */}
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-7">
        <div className="rounded-xl bg-card p-2.5 shadow-sm">
          <div className="text-[10px] font-semibold text-faint">Max Pain</div>
          <div className="mt-0.5 font-mono text-base font-extrabold text-text">{fmt(maxPainStrike)}</div>
        </div>

        <div className="rounded-xl bg-card p-2.5 shadow-sm">
          <div className="flex items-center justify-between text-[10px] font-semibold text-faint">
            <span>Put Call Ratio</span>
            <span>ℹ</span>
          </div>
          <div className="mt-0.5 font-mono text-base font-extrabold text-text">{pcr.toFixed(2)}</div>
          <div className="mt-1 flex h-1 w-full overflow-hidden rounded-full bg-border">
            <div style={{ width: `${Math.min(100, Math.max(10, pcr * 50))}%` }} className="bg-up h-full" />
            <div className="flex-1 bg-down h-full" />
          </div>
        </div>

        <div className="rounded-xl bg-card p-2.5 shadow-sm">
          <div className="flex items-center justify-between text-[10px] font-semibold text-faint">
            <span>PCR (OI)</span>
            <span>ℹ</span>
          </div>
          <div className="mt-0.5 font-mono text-base font-extrabold text-text">{pcr.toFixed(2)}</div>
        </div>

        <div className="rounded-xl bg-card p-2.5 shadow-sm">
          <div className="text-[10px] font-semibold text-faint">Spot Price</div>
          <div className="mt-0.5 font-mono text-base font-extrabold text-text">{fmt(SPOT)}</div>
          <div className="text-[10px] font-bold text-up">+0.76%</div>
        </div>

        <div className="rounded-xl bg-card p-2.5 shadow-sm">
          <div className="text-[10px] font-semibold text-faint">IV</div>
          <div className="mt-0.5 font-mono text-base font-extrabold text-text">{AVG_IV.toFixed(2)}%</div>
          <div className="text-[10px] font-bold text-amber">Moderate</div>
        </div>

        <div className="rounded-xl bg-card p-2.5 shadow-sm">
          <div className="text-[10px] font-semibold text-faint">Max OI (Call)</div>
          <div className="mt-0.5 font-mono text-base font-extrabold text-text">{maxCallOiRow ? fmtCr(maxCallOiRow.callOi) : '—'}</div>
          <div className="text-[10px] text-faint">@ {maxCallOiRow?.strike}</div>
        </div>

        <div className="rounded-xl bg-card p-2.5 shadow-sm">
          <div className="text-[10px] font-semibold text-faint">Max OI (Put)</div>
          <div className="mt-0.5 font-mono text-base font-extrabold text-text">{maxPutOiRow ? fmtCr(maxPutOiRow.putOi) : '—'}</div>
          <div className="text-[10px] text-faint">@ {maxPutOiRow?.strike}</div>
        </div>
      </div>

      {/* Controls Bar: Expiries & Strike dropdowns (reference image.png) */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card p-1.5 text-xs">
        <div role="tablist" aria-label="Expiry" className="flex items-center gap-1 overflow-x-auto">
          {expiries.map((e, i) => (
            <button
              key={e.label}
              role="tab"
              aria-selected={expiryIdx === i}
              onClick={() => setExpiryIdx(i)}
              className={cn(
                'shrink-0 rounded px-2.5 py-1 text-[11px] font-bold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                expiryIdx === i ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
              )}
            >
              {e.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 pr-1">
          <select className="rounded-md border border-border/40 bg-bg px-2 py-1 text-xs font-semibold text-text">
            <option>Select Strike ∨</option>
          </select>
          <select className="rounded-md border border-border/40 bg-bg px-2 py-1 text-xs font-semibold text-text">
            <option>ATM ∨</option>
          </select>
        </div>
      </div>

      {/* 10-Column Option Chain Table (reference image.png) */}
      <div ref={tableContainerRef} className="min-w-0 flex-1 overflow-x-auto overflow-y-auto rounded-lg bg-card" style={{ maxHeight: 'calc(100vh - 340px)' }}>
        <table className="w-full min-w-[760px] border-separate border-spacing-0 text-[14px]">
          <thead className="sticky top-0 z-10 bg-card text-faint">
            <tr className="border-b border-border/80 bg-hover/60 text-[13px] uppercase font-extrabold tracking-wider">
              <th colSpan={5} className="py-2 text-center text-up">CALLS</th>
              <th className="py-2 text-center text-text">STRIKE</th>
              <th colSpan={4} className="py-2 text-center text-down">PUTS</th>
            </tr>
            <tr className="border-b border-border text-faint text-[13px]">
              <th className="py-1 pl-2 text-left font-semibold">OI</th>
              <th className="py-1 text-right font-semibold">LTP</th>
              <th className="py-1 text-right font-semibold">Change</th>
              <th className="py-1 text-right font-semibold">IV</th>
              <th className="py-1 text-right pr-2 font-semibold">Delta</th>
              <th className="w-20 py-1 text-center font-bold text-text bg-hover/30">Strike</th>
              <th className="py-1 pl-2 text-left font-semibold">IV</th>
              <th className="py-1 text-left font-semibold">Change</th>
              <th className="py-1 text-left font-semibold">LTP</th>
              <th className="py-1 pr-2 text-right font-semibold">OI</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {ROWS.map((r, rowIdx) => {
              const isAtm = atmStrikes.has(r.strike);
              const isPrimaryAtm = r.strike === primaryAtmStrike;
              const callRank = callOiRanks.get(rowIdx);
              const putRank = putOiRanks.get(rowIdx);
              const callKey = `${r.strike}-CE`;
              const putKey = `${r.strike}-PE`;
              const realCallGreeks = r.callGreeks ?? blackScholesGreeks(SPOT, r.strike, yearsToExpiry, r.ivPct, 'call');
              const realPutGreeks = r.putGreeks ?? blackScholesGreeks(SPOT, r.strike, yearsToExpiry, r.ivPct, 'put');

              return (
                <tr
                  key={r.strike}
                  ref={isPrimaryAtm ? atmRowRef : undefined}
                  className={cn(
                    'border-b border-border/40 hover:bg-hover/50 transition-colors',
                    isAtm && 'bg-teal-bg/60 font-bold',
                  )}
                >
                  {/* CALLS SIDE: OI | LTP | Change | IV | Delta */}
                  <td className="py-1 pl-2 text-left text-faint">
                    <span className="text-muted">{r.callOi.toLocaleString('en-IN')}</span>
                    {callRank && (
                      <Badge tone="warning" className="ml-1 px-1 py-0 text-[8px]">
                        OI{callRank}
                      </Badge>
                    )}
                  </td>
                  <td
                    className="relative py-1 text-right"
                    onMouseEnter={() => setHoverKey(callKey)}
                    onMouseLeave={() => setHoverKey((k) => (k === callKey ? null : k))}
                  >
                    <span className="font-bold text-up">{fmt(r.callLtp)}</span>
                    <QuickActionsDock visible={hoverKey === callKey} actions={actionsFor(r.strike, 'CE', r.callLtp, r.callLtpChangePct, r.ivPct)} />
                  </td>
                  <td className="py-1 text-right">
                    <ChangeCell value={r.callLtpChangePct} />
                  </td>
                  <td className="py-1 text-right text-faint">{r.ivPct.toFixed(1)}%</td>
                  <td className="py-1 pr-2 text-right text-faint">{realCallGreeks.delta.toFixed(2)}</td>

                  {/* STRIKE CENTER */}
                  <td className={cn('py-1 text-center font-bold bg-hover/20 border-x border-border/40', isAtm ? 'text-teal' : 'text-text')}>
                    {r.strike.toLocaleString('en-IN')}
                  </td>

                  {/* PUTS SIDE: IV | Change | LTP | OI */}
                  <td className="py-1 pl-2 text-left text-faint">{r.ivPct.toFixed(1)}%</td>
                  <td className="py-1 text-left">
                    <ChangeCell value={r.putLtpChangePct} />
                  </td>
                  <td
                    className="relative py-1 text-left"
                    onMouseEnter={() => setHoverKey(putKey)}
                    onMouseLeave={() => setHoverKey((k) => (k === putKey ? null : k))}
                  >
                    <span className="font-bold text-down">{fmt(r.putLtp)}</span>
                    <QuickActionsDock visible={hoverKey === putKey} actions={actionsFor(r.strike, 'PE', r.putLtp, r.putLtpChangePct, r.ivPct)} />
                  </td>
                  <td className="py-1 pr-2 text-right text-faint">
                    {putRank && (
                      <Badge tone="warning" className="mr-1 px-1 py-0 text-[8px]">
                        OI{putRank}
                      </Badge>
                    )}
                    <span className="text-muted">{r.putOi.toLocaleString('en-IN')}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-2 text-[10px] text-faint">
        <span>PCR (OI) <b className="text-text">{pcr.toFixed(2)}</b></span>
        <span>Watchlist <b className="text-text">{watchlist.length}</b> · Strategy <b className="text-text">{strategyLegs.length}</b></span>
        <span>
          {live
            ? `Live from Dhan's Option Chain API — strikes, OI, volume, IV and Greeks all real for ${underlyingSymbol} · ${expiry.label} expiry.`
            : spotPrice
              ? `Strikes centered on today's real spot (${fmt(spotPrice)}); OI/volume/IV and Greeks are illustrative fallback.`
              : 'Greeks are Black-Scholes estimates from mock IV.'}
        </span>
      </div>

      <ContractAnalysisDrawer data={analysis} onClose={() => setAnalysis(null)} />
    </div>
  );
}
