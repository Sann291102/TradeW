'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, cn } from '@tradew/ui';
import { fmt, pct } from '@/lib/format';
import { blackScholesGreeks, type Greeks } from '@/lib/black-scholes';
import { useTradeBasketStore, useHydrateTradeBasket, contractKeyOf, type ContractKey } from '@/lib/store/tradeBasketStore';
import { EXPIRIES, ATM_STRIKE, strikeStepFor, formatExpiryLabel, resolveExpiry } from '@/lib/mock/optionChain';
import { fetchDhanExpiryList, fetchDhanOptionChain, type DhanOptionChain, type DhanOptionStrike } from '@/lib/dhanLiveFeed';
import { TradeIcon, SparkleIcon, BookmarkIcon, LayersIcon } from '@/components/shell/icons';
import { QuickActionsDock, type QuickAction } from './QuickActionsDock';
import { ContractAnalysisDrawer, type ContractAnalysisData } from './ContractAnalysisDrawer';

const STRIKE_COUNT = 9; // ATM +/- 4
const CHAIN_REFRESH_MS = 15_000;
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
 *  renders, windowed to `STRIKE_COUNT` strikes centered on the strike
 *  closest to spot (real strike spacing, not the app's assumed step). */
function rowsFromLiveChain(chain: DhanOptionChain, spot: number): Row[] {
  const strikes = chain.strikes;
  let closestIdx = 0;
  let closestDist = Infinity;
  strikes.forEach((s, i) => {
    const dist = Math.abs(s.strike - spot);
    if (dist < closestDist) {
      closestDist = dist;
      closestIdx = i;
    }
  });
  const half = Math.floor(STRIKE_COUNT / 2);
  const end = Math.min(strikes.length, closestIdx + half + 1);
  const start = Math.max(0, end - STRIKE_COUNT);
  return strikes.slice(start, Math.min(strikes.length, start + STRIKE_COUNT)).map((s) => {
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
  const half = Math.floor(STRIKE_COUNT / 2);
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
}

interface ExpiryOption {
  label: string;
  /** Real ISO date when this came from Dhan's expiry list; null for the
   *  simulated fallback table, which addresses expiries by label alone. */
  iso: string | null;
}

export function OptionChainTab({ underlyingSymbol = 'NIFTY', spotPrice, initialExpiryLabel }: OptionChainTabProps) {
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
  const [liveExpiries, setLiveExpiries] = useState<ExpiryOption[] | null>(null);
  const [expiryIdx, setExpiryIdx] = useState(() => {
    const found = EXPIRIES.findIndex((e) => e.label === initialExpiryLabel);
    return found >= 0 ? found : 0;
  });
  const [chain, setChain] = useState<DhanOptionChain | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ContractAnalysisData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLiveExpiries(null);
    setChain(null);
    fetchDhanExpiryList(underlyingSymbol).then((isoList) => {
      if (cancelled) return;
      if (isoList.length === 0) {
        setLiveExpiries([]);
        return;
      }
      // Dhan's expiry list runs years out (monthly/yearly contracts beyond
      // the weeklies) — the tab row only needs the near-term ones a trader
      // actually picks from, same rough count as the old mock EXPIRIES table.
      const mapped = isoList.slice(0, MAX_EXPIRY_TABS).map((iso) => ({ label: formatExpiryLabel(iso), iso }));
      setLiveExpiries(mapped);
      const found = initialExpiryLabel ? mapped.findIndex((e) => e.label === initialExpiryLabel) : -1;
      setExpiryIdx(found >= 0 ? found : 0);
    });
    return () => {
      cancelled = true;
    };
    // initialExpiryLabel is only meant to apply on first resolve for a symbol
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlyingSymbol]);

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
      fetchDhanOptionChain(underlyingSymbol, iso).then((data) => {
        if (!cancelled) setChain(data);
      });
    load();
    const timer = setInterval(load, CHAIN_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [underlyingSymbol, expiry.iso]);

  const live = chain != null && chain.strikes.length > 0;
  const STRIKE_STEP = strikeStepFor(underlyingSymbol);
  const SPOT = chain?.spot ?? spotPrice ?? ATM_STRIKE;
  const ATM = Math.round(SPOT / STRIKE_STEP) * STRIKE_STEP;

  const ROWS = useMemo(() => (live ? rowsFromLiveChain(chain!, SPOT) : buildRows(ATM, STRIKE_STEP)), [live, chain, SPOT, ATM, STRIKE_STEP]);
  const highlightStrike = useMemo(
    () => ROWS.reduce((closest, r) => (Math.abs(r.strike - SPOT) < Math.abs(closest.strike - SPOT) ? r : closest), ROWS[0])?.strike,
    [ROWS, SPOT],
  );
  const AVG_IV = useMemo(() => ROWS.reduce((a, r) => a + r.ivPct, 0) / ROWS.length, [ROWS]);
  const callOiRanks = useMemo(() => oiRanks(ROWS.map((r) => r.callOi)), [ROWS]);
  const putOiRanks = useMemo(() => oiRanks(ROWS.map((r) => r.putOi)), [ROWS]);

  const totalCallOi = ROWS.reduce((a, r) => a + r.callOi, 0);
  const totalPutOi = ROWS.reduce((a, r) => a + r.putOi, 0);
  const pcr = totalCallOi > 0 ? totalPutOi / totalCallOi : 0;

  function contractKey(strike: number, optionType: 'CE' | 'PE'): ContractKey {
    return { underlying: underlyingSymbol, strike, optionType, expiryLabel: expiry.label };
  }

  function navigateToContract(strike: number, optionType: 'CE' | 'PE', action?: 'buy' | 'sell') {
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

  return (
    <div className="flex flex-1 flex-col p-3">
      <div className="mb-1.5 flex shrink-0 flex-wrap items-center gap-1.5 text-[11px] text-faint">
        {live ? (
          <Badge tone="positive" className="px-1.5 py-0 text-[9px]">LIVE</Badge>
        ) : (
          <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">PREVIEW</Badge>
        )}
        {(chain?.spot ?? spotPrice) != null && (
          <>
            <span>Spot</span>
            <span className="font-mono font-bold text-text">{fmt(chain?.spot ?? spotPrice!)}</span>
            {!live && (
              <>
                <span>· ATM strike</span>
                <span className="font-mono font-bold text-teal">{ATM}</span>
                <span>(strikes are quantized to {STRIKE_STEP}-wide intervals — never exactly the spot)</span>
              </>
            )}
          </>
        )}
      </div>
      <div role="tablist" aria-label="Expiry" className="mb-1.5 flex shrink-0 items-center gap-1 overflow-x-auto pb-1.5">
        {expiries.map((e, i) => (
          <button
            key={e.label}
            role="tab"
            aria-selected={expiryIdx === i}
            onClick={() => setExpiryIdx(i)}
            className={cn(
              'shrink-0 rounded px-2 py-1 text-[10.5px] font-semibold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              expiryIdx === i ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            {e.label}
          </button>
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-0 text-[10.5px]">
          <thead className="text-faint">
            <tr>
              <th className="py-0.5 text-left font-semibold">OI</th>
              <th className="py-0.5 text-right font-semibold">Vol</th>
              <th className="py-0.5 text-right font-semibold">CE</th>
              <th className="w-16 py-0.5 text-center font-semibold">Strike</th>
              <th className="py-0.5 text-left font-semibold">PE</th>
              <th className="py-0.5 text-left font-semibold">Vol</th>
              <th className="py-0.5 text-right font-semibold">OI</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {ROWS.map((r) => {
              const atm = r.strike === highlightStrike;
              const callRank = callOiRanks.get(ROWS.indexOf(r));
              const putRank = putOiRanks.get(ROWS.indexOf(r));
              const callKey = `${r.strike}-CE`;
              const putKey = `${r.strike}-PE`;
              return (
                <tr key={r.strike} className={cn('border-b border-border', atm && 'bg-teal-bg')}>
                  <td className="py-0.5 pr-1 text-left text-faint">
                    <span className="text-muted">{r.callOi.toLocaleString('en-IN')}</span> <ChangeCell value={r.callOiChangePct} />
                    {callRank && (
                      <Badge tone="warning" className="ml-1 px-1 py-0 text-[8px]">
                        OI{callRank}
                      </Badge>
                    )}
                  </td>
                  <td className="py-0.5 text-right text-faint">{r.callVolume.toLocaleString('en-IN')}</td>
                  <td
                    className="relative py-0.5 text-right"
                    onMouseEnter={() => setHoverKey(callKey)}
                    onMouseLeave={() => setHoverKey((k) => (k === callKey ? null : k))}
                    onFocus={() => setHoverKey(callKey)}
                    onBlur={() => setHoverKey((k) => (k === callKey ? null : k))}
                  >
                    <div className={cn(hoverKey === callKey && 'opacity-0')}>
                      <span className="font-bold text-up">{fmt(r.callLtp)}</span> <ChangeCell value={r.callLtpChangePct} />
                      <div className="text-[9px] font-normal text-faint">IV {r.ivPct.toFixed(1)}%</div>
                    </div>
                    <QuickActionsDock visible={hoverKey === callKey} actions={actionsFor(r.strike, 'CE', r.callLtp, r.callLtpChangePct, r.ivPct)} />
                  </td>
                  <td className={cn('py-0.5 text-center font-bold', atm ? 'text-teal' : 'text-text')}>{r.strike}</td>
                  <td
                    className="relative py-0.5 text-left"
                    onMouseEnter={() => setHoverKey(putKey)}
                    onMouseLeave={() => setHoverKey((k) => (k === putKey ? null : k))}
                    onFocus={() => setHoverKey(putKey)}
                    onBlur={() => setHoverKey((k) => (k === putKey ? null : k))}
                  >
                    <div className={cn(hoverKey === putKey && 'opacity-0')}>
                      <span className="font-bold text-down">{fmt(r.putLtp)}</span> <ChangeCell value={r.putLtpChangePct} />
                      <div className="text-[9px] font-normal text-faint">IV {r.ivPct.toFixed(1)}%</div>
                    </div>
                    <QuickActionsDock visible={hoverKey === putKey} actions={actionsFor(r.strike, 'PE', r.putLtp, r.putLtpChangePct, r.ivPct)} />
                  </td>
                  <td className="py-0.5 text-left text-faint">{r.putVolume.toLocaleString('en-IN')}</td>
                  <td className="py-0.5 pl-1 text-right text-faint">
                    {putRank && (
                      <Badge tone="warning" className="mr-1 px-1 py-0 text-[8px]">
                        OI{putRank}
                      </Badge>
                    )}
                    <span className="text-muted">{r.putOi.toLocaleString('en-IN')}</span> <ChangeCell value={r.putOiChangePct} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-2 text-[10px] text-faint">
        <span>PCR (OI) <b className="text-text">{pcr.toFixed(2)}</b></span>
        <span>Watchlist <b className="text-text">{watchlist.length}</b> · Strategy <b className="text-text">{strategyLegs.length}</b></span>
        <span>
          {live
            ? `Live from Dhan's Option Chain API — strikes, OI, volume, IV and Greeks all real for ${underlyingSymbol} · ${expiry.label} expiry.`
            : spotPrice
              ? `Strikes centered on today's real spot (${fmt(spotPrice)}); OI/volume/IV and Greeks are still illustrative mock data — this underlying/expiry has no live chain right now.`
              : 'Greeks are Black-Scholes estimates from mock IV — illustrative, not live.'}
        </span>
      </div>

      <ContractAnalysisDrawer data={analysis} onClose={() => setAnalysis(null)} />
    </div>
  );
}
