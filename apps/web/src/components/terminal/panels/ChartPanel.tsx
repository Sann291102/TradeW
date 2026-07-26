'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Panel, IconButton, cn } from '@tradew/ui';
import type { CandleInterval } from '@tradew/types';
import { INDEX_QUOTES, TOP_GAINERS, TOP_LOSERS, COMMODITIES } from '@/lib/mock/market';
import { fmt, pct } from '@/lib/format';
import { useCandles } from '@/lib/hooks/useCandles';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { useHasOptionChain } from '@/lib/hooks/useHasOptionChain';
import { useOptionQuote } from '@/lib/hooks/useOptionQuote';
import { useOptionCandles } from '@/lib/hooks/useOptionCandles';
import { TradeChart } from '@/components/charts/TradeChart';
import { deriveOptionCandles } from '@/lib/mock/optionCandles';
import { blackScholesPrice } from '@/lib/black-scholes';
import { MarketsTab } from './chart-tabs/MarketsTab';
import { TechnicalsTab } from './chart-tabs/TechnicalsTab';
import { OptionChainTab } from './chart-tabs/OptionChainTab';
import { DepthTab } from './chart-tabs/DepthTab';
import { SparkleIcon, PopOutIcon, CloseIcon } from '../../shell/icons';
import type { DockPanelContentProps } from './types';

export interface ContractContext {
  strike: number;
  optionType: 'CE' | 'PE';
  expiryLabel: string;
  /** Real ISO `YYYY-MM-DD` expiry, when this contract came from a live Dhan
   *  chain. Required to look up the contract's REAL premium (useOptionQuote);
   *  absent only for the simulated fallback chain. */
  expiryIso?: string;
  yearsToExpiry: number;
  ivPct: number;
}

const TIMEFRAMES = ['1m', '5m', '15m', '1H', '1D', '1W'] as const;
const VIEWS = ['markets', 'charts', 'technicals', 'optionChain', 'depth'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = {
  markets: 'Markets',
  charts: 'Charts',
  technicals: 'Technicals',
  optionChain: 'Option Chain',
  depth: 'Depth',
};

/** Pill label -> shared `CandleInterval` + lookback window. No weekly
 *  interval exists on the type yet, so '1W' reuses '1d' candles over a
 *  longer window rather than inventing a parallel interval. */
const TF_CONFIG: Record<(typeof TIMEFRAMES)[number], { interval: CandleInterval; days: number }> = {
  '1m': { interval: '1m', days: 1 },
  '5m': { interval: '5m', days: 3 },
  '15m': { interval: '15m', days: 5 },
  '1H': { interval: '1h', days: 14 },
  '1D': { interval: '1d', days: 90 },
  '1W': { interval: '1d', days: 365 },
};

/** Bar duration per timeframe, for the chart's "15:15–15:30" crosshair
 *  range label. Daily/weekly are omitted — a date alone is unambiguous
 *  there, and a "span" across non-trading hours would be misleading. */
const TF_MINUTES: Partial<Record<(typeof TIMEFRAMES)[number], number>> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1H': 60,
};

/**
 * Instrument panel — the consolidated single-panel workspace (reference:
 * instrument name/price header, then Markets / Charts / Technicals /
 * Option Chain / Depth tabs). Previously separate dock panels
 * (OptionChainPanel, DepthPanel) were folded into this one as tabs so the
 * whole instrument view lives under one header instead of three stacked
 * panels — their standalone components/PanelKinds still exist (never
 * deleted), just hidden from the default dock layout; see workspaceStore.ts.
 * Charts renders our own candlestick chart (`TradeChart`); Markets and
 * Technicals compute off a shared daily candle series (lib/technicals.ts).
 * Lazy-loaded (next/dynamic) per the performance brief. Default-exported for
 * dynamic import.
 */
export interface ChartPanelProps extends DockPanelContentProps {
  /** Which index to show — resolved against INDEX_QUOTES, falls back to the
   *  first entry (NIFTY) if omitted or unrecognized. Fixes index cards that
   *  all opened the same hardcoded chart regardless of which was clicked. */
  symbol?: string;
  /** Extra controls appended to the instrument-view tab row (e.g. a layout
   *  menu), for callers that render this panel outside the dock. */
  trailingControls?: ReactNode;
  /** When set, the Charts tab shows this option contract's own premium
   *  (derived from the underlying's candles via Black-Scholes — see
   *  lib/mock/optionCandles.ts) instead of the underlying's price. Markets/
   *  Technicals stay on the underlying either way — that's what traders
   *  actually reference for a derivative. */
  contract?: ContractContext;
  /** Pre-selects this expiry when the Option Chain tab first renders, so
   *  arriving from a specific contract lands on the right expiry. */
  initialExpiryLabel?: string;
  /** Which tab to open on. Lets a caller deep-link straight to Option Chain /
   *  Technicals / Depth — these are tabs in THIS panel, not separate dock
   *  panels, so there is no other way to address them from a URL. Used by the
   *  TradeW AI assistant's "show the option chain" command. */
  initialView?: View;
}

export default function ChartPanel({
  className,
  actions,
  collapsed,
  symbol,
  trailingControls,
  contract,
  initialExpiryLabel,
  initialView,
}: ChartPanelProps) {
  const [view, setView] = useState<View>(initialView ?? 'charts');
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>('15m');
  const [maximized, setMaximized] = useState(false);

  // Full-screen chart: an in-app maximized overlay (not the native Fullscreen
  // API, which the app shell can restrict). Esc exits; the height is derived
  // from the viewport so the chart actually fills the screen.
  const [viewportH, setViewportH] = useState(0);
  useEffect(() => {
    const update = () => setViewportH(window.innerHeight);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMaximized(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);
  const chartHeight = maximized ? Math.max(320, viewportH - 180) : 280;

  // Arriving here is a client-side navigation (router.push from the Option
  // Chain's "Open chart" action) — this component doesn't remount, so local
  // `view` state wouldn't otherwise change. Jump to Charts whenever a NEW
  // contract shows up (but don't fight the user if they navigate away from
  // Charts while the same contract stays selected).
  const contractKey = contract ? `${contract.strike}-${contract.optionType}-${contract.expiryLabel}` : null;
  const prevContractKey = useRef<string | null>(null);
  useEffect(() => {
    if (contractKey && contractKey !== prevContractKey.current) setView('charts');
    prevContractKey.current = contractKey;
  }, [contractKey]);

  // Which instrument to show — the requested symbol, or NIFTY only when
  // none was requested at all (bare /trade with no query param).
  const symbolKey = symbol ?? INDEX_QUOTES[0].symbol;

  // The Dhan live-feed bridge now resolves the full F&O stock universe
  // (~211 symbols), every NSE ETF (~331) and all 5 commodities/indices from
  // Dhan's own scrip master (lib/dhanLiveFeed.ts) — not just the handful in
  // the small mock lists below. Look it up by the REAL requested symbol, not
  // by whatever the mock lookup happens to find, so a stock/ETF outside the
  // old ~20-symbol mock lists (e.g. ADANIENT, any ETF) still resolves to
  // itself instead of silently falling back to NIFTY.
  const { quotes: liveIndices, stocks: liveStocks, etfs: liveEtfs, commodities: liveCommodities, status: liveStatus } = useDhanLiveFeed();
  const liveReady = liveStatus !== 'loading' && liveStatus !== 'unreachable';
  const liveMatch = liveReady
    ? [...(liveIndices ?? []), ...(liveStocks ?? []), ...(liveEtfs ?? []), ...(liveCommodities ?? [])].find((lq) => lq.symbol === symbolKey)
    : undefined;

  // Base (mock) quote — mainly for `name` and as a last-resort price when
  // the bridge is unreachable. Checked by the real symbolKey too; when
  // nothing matches (most of the F&O/ETF universe isn't in these small
  // illustrative lists), fall back to the live feed's own display name
  // rather than a hardcoded NIFTY object.
  const mockQuote: { symbol: string; name: string; ltp: number; changePct: number } =
    INDEX_QUOTES.find((i) => i.symbol === symbolKey) ??
    TOP_GAINERS.find((i) => i.symbol === symbolKey) ??
    TOP_LOSERS.find((i) => i.symbol === symbolKey) ??
    COMMODITIES.find((i) => i.symbol === symbolKey) ??
    { symbol: symbolKey, name: liveMatch?.displayName ?? symbolKey, ltp: liveMatch?.ltp ?? 0, changePct: liveMatch?.changePct ?? 0 };
  const q = liveMatch ? { ...mockQuote, ltp: liveMatch.ltp, changePct: liveMatch.changePct } : mockQuote;
  const up = q.changePct >= 0;
  const { interval, days } = TF_CONFIG[tf];
  const { candles, status: candlesStatus } = useCandles(q.symbol, interval, days, liveMatch?.ltp);
  const { candles: dailyCandles } = useCandles(q.symbol, '1d', 300, liveMatch?.ltp);
  const realCandles = candlesStatus === 'live';

  // The contract's REAL premium, straight from Dhan's option chain — the exact
  // number the Option Chain table shows for this strike. Previously this panel
  // displayed a Black-Scholes theoretical price instead, which disagreed with
  // the chain (e.g. chain 160.75 vs chart ~220 for NIFTY 23800 CE). The
  // theoretical price is now only a labelled fallback for contracts with no
  // live chain (simulated expiries, closed/unlisted markets).
  const { quote: optionQuote, status: optionQuoteStatus } = useOptionQuote(
    contract ? q.symbol : undefined,
    contract?.expiryIso,
    contract?.strike,
    contract?.optionType,
  );
  const realOptionLtp = optionQuote?.ltp && optionQuote.ltp > 0 ? optionQuote.ltp : null;
  // Real implied vol from the same chain row beats the mock IV smile for the
  // derived series' shape; fall back to the mock only when there's no chain.
  // Clamped to a sane band. Implied vol is a percentage (single/low-double
  // digits for index options); anything outside this is a bad input, not a real
  // market reading, and feeding it to Black-Scholes produced a flat, meaningless
  // series. Guards the fallback path in particular — see TradeWorkspace's note
  // on the old NIFTY-shaped IV smile that yielded ~37,225% on SENSEX strikes.
  const rawIv = optionQuote?.iv && optionQuote.iv > 0 ? optionQuote.iv : contract?.ivPct ?? 0;
  const liveIvPct = Math.min(150, Math.max(1, rawIv || 12.5));

  // The derived series must keep a STABLE array identity across price ticks.
  // Rebuilding it on every quote refresh re-ran TradeChart's setData +
  // fitContent, which silently threw away the user's zoom/pan every few
  // seconds. So the scale anchor and IV are captured once per (contract,
  // timeframe, candle series) and held; the live price then moves only the last
  // bar, via TradeChart's `liveLast` -> series.update(), which never touches the
  // visible range.
  const seriesKey = `${contractKey ?? ''}|${tf}|${candles?.length ?? 0}`;
  const anchorRef = useRef<{ key: string; ltp: number | null; iv: number }>({ key: '', ltp: null, iv: 0 });
  if (anchorRef.current.key !== seriesKey) {
    anchorRef.current = { key: seriesKey, ltp: realOptionLtp, iv: liveIvPct };
  } else if (anchorRef.current.ltp == null && realOptionLtp != null) {
    // First real quote for this series — adopt it once, then hold it.
    anchorRef.current = { key: seriesKey, ltp: realOptionLtp, iv: liveIvPct };
  }
  const anchorLtp = anchorRef.current.ltp;
  const contractIvPct = anchorRef.current.iv || liveIvPct;

  // REAL per-contract OHLC from Dhan. This is the contract's own traded
  // history, so no implied-vol guess and no scale anchoring are involved at all.
  const { candles: realContractCandles, status: optionCandlesStatus } = useOptionCandles(
    contract ? q.symbol : undefined,
    contract?.expiryIso,
    contract?.strike,
    contract?.optionType,
    interval,
    days,
  );
  const hasRealContractCandles = !!realContractCandles?.length;

  // Fallback only — used when Dhan has no history for this contract (illiquid
  // or newly listed strike). Clearly labelled as derived in the caption below;
  // never presented as traded data.
  const derivedContractCandles = useMemo(
    () =>
      contract && candles && !hasRealContractCandles
        ? deriveOptionCandles(
            candles,
            contract.strike,
            contract.optionType,
            contract.yearsToExpiry,
            contractIvPct,
            // Anchor the series onto the real premium so the last bar reads the
            // same price as the chain.
            anchorLtp ?? undefined,
          )
        : null,
    [contract?.strike, contract?.optionType, contract?.yearsToExpiry, contractIvPct, candles, anchorLtp, hasRealContractCandles],
  );
  const contractCandles = realContractCandles ?? derivedContractCandles;
  const contractLtp = contract
    ? realOptionLtp ??
      blackScholesPrice(q.ltp, contract.strike, contract.yearsToExpiry, contractIvPct, contract.optionType === 'CE' ? 'call' : 'put')
    : null;

  // Whether this symbol has a live options market — determined dynamically
  // per-symbol from Dhan's own Option Chain API (no hardcoded stock/
  // commodity list, see useHasOptionChain), so a stock with real listed
  // derivatives shows the tab and one without doesn't, automatically.
  // Defaults to hidden until resolved, so the tab never flashes in and then
  // disappears — chart/price rendering above is unaffected either way.
  const optionable = useHasOptionChain(q.symbol);
  const views = optionable ? VIEWS : VIEWS.filter((v) => v !== 'optionChain');
  useEffect(() => {
    if (!optionable && view === 'optionChain') setView('charts');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionable]);

  return (
    <Panel
      className={className}
      collapsed={collapsed}
      scroll={view !== 'charts'}
      bodyClassName="flex flex-col"
      elevation={1}
      title={
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-bold normal-case text-text">
            {q.symbol}
            {contract && ` ${contract.strike} ${contract.optionType}`}
          </span>
          <span className="font-mono text-[12px] tabular-nums text-text">{fmt(contract ? contractLtp ?? 0 : q.ltp)}</span>
          {!contract && (
            <span className={cn('font-mono text-[11px] tabular-nums', up ? 'text-up' : 'text-down')}>{pct(q.changePct)}</span>
          )}
          {contract && <span className="text-[10.5px] text-faint">{contract.expiryLabel} expiry</span>}
        </span>
      }
      actions={
        <>
          {view === 'charts' && (
            <div role="tablist" aria-label="Timeframe" className="flex items-center gap-0.5">
              {TIMEFRAMES.map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tf === t}
                  onClick={() => setTf(t)}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    tf === t ? 'bg-teal-bg text-teal' : 'text-muted hover:text-text',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          {view === 'charts' && (
            <IconButton
              aria-label={maximized ? 'Exit full screen' : 'Full screen chart'}
              onClick={() => setMaximized((m) => !m)}
              className="h-7 w-7"
            >
              {maximized ? <CloseIcon className="h-4 w-4" /> : <PopOutIcon className="h-4 w-4" />}
            </IconButton>
          )}
          <IconButton aria-label="Analyze this chart with TradeW AI" className="h-7 w-7 text-teal">
            <SparkleIcon className="h-4 w-4" />
          </IconButton>
          {actions}
        </>
      }
    >
      <div role="tablist" aria-label="Instrument view" className="mb-2 flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border pb-2">
        {views.map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn(
              'shrink-0 rounded px-2.5 py-1 text-xs font-semibold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              view === v ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            {VIEW_LABEL[v]}
          </button>
        ))}
        {trailingControls && <div className="ml-auto flex shrink-0 items-center gap-1.5">{trailingControls}</div>}
      </div>

      {view === 'markets' && <MarketsTab dailyCandles={dailyCandles ?? []} />}

      {view === 'technicals' && <TechnicalsTab dailyCandles={dailyCandles ?? []} ltp={q.ltp} />}

      {view === 'optionChain' && <OptionChainTab underlyingSymbol={q.symbol} spotPrice={q.ltp} initialExpiryLabel={initialExpiryLabel} onOpenChart={() => setView('charts')} />}

      {view === 'depth' && <DepthTab />}

      {view === 'charts' && (
        <div className={cn('flex flex-1 flex-col', maximized && 'fixed inset-0 z-50 bg-bg p-4')}>
          {maximized && (
            <div className="mb-3 flex shrink-0 items-center justify-between">
              <span className="text-sm font-bold text-text">
                {q.symbol}
                {contract && ` ${contract.strike} ${contract.optionType}`} · {tf}
                <span className="ml-2 font-mono text-[13px] tabular-nums">{fmt(contract ? contractLtp ?? 0 : q.ltp)}</span>
              </span>
              <IconButton aria-label="Exit full screen" onClick={() => setMaximized(false)} className="h-7 w-7">
                <CloseIcon className="h-4 w-4" />
              </IconButton>
            </div>
          )}
          <div className="flex flex-1 items-center justify-center">
            {contract ? (
              contractCandles ? (
                <TradeChart candles={contractCandles} height={chartHeight} liveLast={contractLtp ?? undefined} fitKey={`${q.symbol}|${contractKey}|${tf}`} intervalMinutes={TF_MINUTES[tf]} aria-label={`${q.symbol} ${contract.strike} ${contract.optionType} chart`} />
              ) : (
                <div className="w-full animate-pulse rounded bg-hover" style={{ height: chartHeight }} />
              )
            ) : candles ? (
              <TradeChart candles={candles} height={chartHeight} liveLast={liveMatch?.ltp} fitKey={`${q.symbol}|${tf}`} intervalMinutes={TF_MINUTES[tf]} aria-label={`${q.symbol} ${tf} chart`} />
            ) : (
              <div className="w-full animate-pulse rounded bg-hover" style={{ height: chartHeight }} />
            )}
          </div>
          <p className="pt-2 text-center text-[10px] text-faint">
            {contract
              ? hasRealContractCandles
                ? `${q.symbol} ${contract.strike} ${contract.optionType} · ${tf} — real traded OHLC for this contract from Dhan${realOptionLtp ? `, live premium ${fmt(realOptionLtp)} (matches the Option Chain tab)` : ''}.`
                : realOptionLtp
                  ? `${q.symbol} ${contract.strike} ${contract.optionType} · ${fmt(realOptionLtp)} — live premium is real (matches the Option Chain tab), but Dhan has no traded candle history for this contract${optionCandlesStatus === 'loading' ? ' loaded yet' : ''}; the shape below is derived from the underlying via Black-Scholes at IV ${contractIvPct.toFixed(1)}% and is NOT traded data.`
                  : `${q.symbol} ${contract.strike} ${contract.optionType} — no live chain for this contract${optionQuoteStatus === 'loading' ? ' yet' : ''}; showing a Black-Scholes theoretical premium, NOT a traded price.`
              : realCandles
                ? `${q.symbol} · ${tf} — real OHLC history from Dhan (charting by TradingView).`
                : liveMatch
                  ? `${q.symbol} · ${tf} — simulated history, rescaled to today's real Dhan LTP.`
                  : `${q.symbol} · ${tf} — simulated candles (no live history for this symbol).`}
          </p>
        </div>
      )}
    </Panel>
  );
}
