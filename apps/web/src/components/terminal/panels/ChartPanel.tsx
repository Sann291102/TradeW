'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Panel, IconButton, cn } from '@tradew/ui';
import type { CandleInterval } from '@tradew/types';
import { INDEX_QUOTES, TOP_GAINERS, TOP_LOSERS, COMMODITIES } from '@/lib/mock/market';
import { fmt } from '@/lib/format';
import { useCandles } from '@/lib/hooks/useCandles';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { useHasOptionChain } from '@/lib/hooks/useHasOptionChain';
import { useOptionQuote } from '@/lib/hooks/useOptionQuote';
import { useOptionCandles } from '@/lib/hooks/useOptionCandles';
import { TradeChart, type ChartPriceLine } from '@/components/charts/TradeChart';
import { MarketsTab } from './chart-tabs/MarketsTab';
import { TechnicalsTab } from './chart-tabs/TechnicalsTab';
import { OptionChainTab } from './chart-tabs/OptionChainTab';
import { DepthTab } from './chart-tabs/DepthTab';
import { InstrumentHeader } from '@/components/trade/InstrumentHeader';
import { SparkleIcon, CloseIcon } from '../../shell/icons';
import { ChartExpandButton } from '@/components/charts/ChartExpandButton';
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

/**
 * Shown wherever real data is missing. The panel states the reason and draws
 * nothing — no placeholder series, no last-known number. Per the 2026-07-26
 * no-fabricated-data rule: a trading screen that invents a plausible price is
 * worse than one that admits it is offline.
 */
function DataUnavailable({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex h-full min-h-[120px] w-full flex-col items-center justify-center gap-1 px-4 text-center">
      <p className="text-[12px] font-semibold text-muted">{title}</p>
      {detail && <p className="max-w-md text-[11px] leading-relaxed text-faint">{detail}</p>}
    </div>
  );
}

/** Pill label -> shared `CandleInterval` + lookback window. No weekly
 *  interval exists on the type yet, so '1W' reuses '1d' candles over a
 *  longer window rather than inventing a parallel interval. */
const TF_CONFIG: Record<(typeof TIMEFRAMES)[number], { interval: CandleInterval; days: number }> = {
  // Depths raised 2026-07-27. The old values (1/3/5/14/90/365) were a
  // client-side constant, not an API limit — 5m was capped at 3 days here while
  // Dhan returns 30 days of 5m bars in one call without complaint.
  //
  // Every number below was MEASURED against Dhan's own API, not assumed, and
  // each sits at or under the point where it starts refusing:
  //
  //   1m   5d   -> 1500 bars
  //   5m   30d  -> 1578 bars
  //   15m  60d  -> 1032 bars
  //   1h   90d  ->  434 bars   (180d returns HTTP 400 — this is the ceiling)
  //   1d   365d ->  245 bars   (730d and 1825d BOTH return the same 245 bars;
  //                             /charts/historical caps daily at ~1 year, so
  //                             asking for more is a slower request for
  //                             identical data)
  //
  // 1D and 1W therefore share a depth. That is Dhan's limit, not an oversight —
  // going deeper needs the persisted Candle table, not a bigger number here.
  '1m': { interval: '1m', days: 5 },
  '5m': { interval: '5m', days: 30 },
  '15m': { interval: '15m', days: 60 },
  '1H': { interval: '1h', days: 90 },
  '1D': { interval: '1d', days: 365 },
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
  /** Horizontal markers drawn over the Charts tab — used by the Learning Hub's
   *  Apply action to show a strategy's strikes against the underlying. Only
   *  applied to the underlying's chart, not to a single contract's premium
   *  chart, where a strike line would be meaningless. */
  priceLines?: ChartPriceLine[];
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
  priceLines,
}: ChartPanelProps) {
  const [view, setView] = useState<View>(initialView ?? 'charts');
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>('15m');
  const [maximized, setMaximized] = useState(false);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /**
   * Trade from the full-screen chart.
   *
   * Maximised, the order ticket is off screen entirely — the chart was a
   * read-only surface, which is why a full-screen chart was reported as not
   * being tradeable.
   *
   * Deliberately NOT a one-click market order the way a broker terminal does
   * it. This sets the side and drops back to the ticket, where quantity,
   * product and order type are visible before anything is sent. A single
   * mis-click on a full-screen chart should never be able to place a lot.
   * `?action=` is the mechanism TradeWorkspace already uses to preselect a
   * side, so this reuses it rather than adding a parallel path.
   */
  function tradeFromChart(side: 'buy' | 'sell') {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('action', side);
    setMaximized(false);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

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

  // Display NAME only — these illustrative lists are NOT a price source.
  // When the bridge is unreachable the panel shows no price at all rather
  // than a hardcoded one: a stale fake LTP under a real ticker is
  // indistinguishable from a live quote, which is exactly how the 23,882.15
  // mock NIFTY in lib/mock/market.ts rendered as if it were the market.
  // Name falls back to the feed's own display name, then the symbol itself.
  const displayName =
    INDEX_QUOTES.find((i) => i.symbol === symbolKey)?.name ??
    TOP_GAINERS.find((i) => i.symbol === symbolKey)?.name ??
    TOP_LOSERS.find((i) => i.symbol === symbolKey)?.name ??
    COMMODITIES.find((i) => i.symbol === symbolKey)?.name ??
    liveMatch?.displayName ??
    symbolKey;
  const q: { symbol: string; name: string; ltp: number | null; changePct: number | null } = {
    symbol: symbolKey,
    name: displayName,
    ltp: liveMatch?.ltp ?? null,
    changePct: liveMatch?.changePct ?? null,
  };
  const { interval, days } = TF_CONFIG[tf];
  const { candles, status: candlesStatus, reason: candlesReason } = useCandles(q.symbol, interval, days);
  const { candles: dailyCandles } = useCandles(q.symbol, '1d', 300);
  const realCandles = candlesStatus === 'live';

  // The contract's REAL premium, straight from Dhan's option chain — the exact
  // number the Option Chain table shows for this strike. This panel used to
  // display a Black-Scholes theoretical price when the chain was missing,
  // which disagreed with the chain (e.g. chain 160.75 vs chart ~220 for NIFTY
  // 23800 CE); that fallback is gone, along with the implied-vol clamp and
  // series scale-anchor that existed only to keep the derived curve stable.
  // No chain row now means no premium shown.
  const { quote: optionQuote, status: optionQuoteStatus } = useOptionQuote(
    contract ? q.symbol : undefined,
    contract?.expiryIso,
    contract?.strike,
    contract?.optionType,
  );
  const realOptionLtp = optionQuote?.ltp && optionQuote.ltp > 0 ? optionQuote.ltp : null;

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

  // No derived series, and no theoretical premium. Black-Scholes could only
  // approximate the shape, and a synthetic curve drawn on a price chart is
  // fabricated market data however carefully it is captioned. When Dhan has
  // no traded history (or no live chain) for a contract, the panel says so
  // instead of drawing something. deriveOptionCandles/blackScholesPrice are
  // untouched in lib/ — they still serve the pricing maths elsewhere.
  const contractCandles = realContractCandles ?? null;
  /** Real traded premium from Dhan's chain, or null. Never theoretical. */
  const contractLtp = contract ? realOptionLtp : null;

  // Whether this symbol has a live options market — determined dynamically
  // per-symbol from Dhan's own Option Chain API (no hardcoded stock/
  // commodity list, see useHasOptionChain), so a stock with real listed
  // derivatives shows the tab and one without doesn't, automatically.
  // Hidden ONLY on a confirmed 'no'. On 'unknown' (bridge unreachable) the tab
  // stays and reports that it isn't connected — hiding it on an outage made
  // NIFTY, the exchange's most heavily traded options underlying, render with
  // no Option Chain tab at all. An outage must never look like an instrument
  // fact. See useHasOptionChain's three-state contract.
  const optionable = useHasOptionChain(q.symbol);
  const views = optionable === 'no' ? VIEWS.filter((v) => v !== 'optionChain') : VIEWS;
  useEffect(() => {
    if (optionable === 'no' && view === 'optionChain') setView('charts');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionable]);

  // The rich hero header (name/price/OHLC row, reference-matched) replaces
  // Panel's compact title bar for the underlying view — that compact bar is
  // shared chrome used by every other panel in the app, too small for this
  // page's hero treatment. The option-contract view is untouched: it keeps
  // the original compact title/actions exactly as before, since the
  // reference this redesign matches is the underlying instrument screen, not
  // a contract view.
  return (
    <Panel
      className={className}
      collapsed={collapsed}
      scroll={view !== 'charts'}
      bodyClassName="flex flex-col"
      elevation={1}
      title={
        contract ? (
          <span className="flex items-center gap-2">
            <span className="text-[13px] font-bold normal-case text-text">
              {q.symbol} {contract.strike} {contract.optionType}
            </span>
            <span className="font-mono text-[12px] tabular-nums text-text">{contractLtp != null ? fmt(contractLtp) : '—'}</span>
            <span className="text-[10.5px] text-faint">{contract.expiryLabel} expiry</span>
          </span>
        ) : undefined
      }
      actions={
        contract ? (
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
            <IconButton aria-label="Analyze this chart with TradeW AI" className="h-7 w-7 text-teal">
              <SparkleIcon className="h-4 w-4" />
            </IconButton>
            {actions}
          </>
        ) : undefined
      }
    >
      {!contract && (
        <InstrumentHeader
          symbol={q.symbol}
          name={q.name}
          ltp={q.ltp}
          changePct={q.changePct}
          dailyCandles={dailyCandles ?? []}
          feedStatus={liveStatus}
        />
      )}

      <div role="tablist" aria-label="Instrument view" className={cn('mb-2 flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border pb-2', !contract && 'pt-3')}>
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
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {!contract && view === 'charts' && (
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
          {!contract && (
            <IconButton aria-label="Analyze this chart with TradeW AI" className="h-7 w-7 text-teal">
              <SparkleIcon className="h-4 w-4" />
            </IconButton>
          )}
          {trailingControls}
        </div>
      </div>

      {view === 'markets' && <MarketsTab dailyCandles={dailyCandles ?? []} />}

      {view === 'technicals' &&
        (q.ltp != null ? (
          <TechnicalsTab dailyCandles={dailyCandles ?? []} ltp={q.ltp} />
        ) : (
          <DataUnavailable
            title="Live feed not connected"
            detail={`No live price for ${q.symbol}, so indicators cannot be computed. Start the Dhan live-feed bridge on port 4600 and reload.`}
          />
        ))}

      {view === 'optionChain' &&
        (optionable === 'unknown' ? (
          <DataUnavailable
            title="Option chain not connected"
            detail={`Could not reach Dhan's option-chain API to load ${q.symbol}. This is a connection problem, not a statement about whether ${q.symbol} has listed options.`}
          />
        ) : q.ltp != null ? (
          <OptionChainTab underlyingSymbol={q.symbol} spotPrice={q.ltp} initialExpiryLabel={initialExpiryLabel} onOpenChart={() => setView('charts')} />
        ) : (
          <DataUnavailable
            title="Live feed not connected"
            detail={`No live spot price for ${q.symbol}; the chain cannot be centred without one.`}
          />
        ))}

      {view === 'depth' && <DepthTab />}

      {view === 'charts' && (
        <div className={cn('flex flex-1 flex-col', maximized && 'fixed inset-0 z-50 bg-bg p-4')}>
          {maximized && (
            <div className="mb-3 flex shrink-0 items-center justify-between">
              <span className="text-sm font-bold text-text">
                {q.symbol}
                {contract && ` ${contract.strike} ${contract.optionType}`} · {tf}
                <span className="ml-2 font-mono text-[13px] tabular-nums">
                  {contract ? (contractLtp != null ? fmt(contractLtp) : '—') : q.ltp != null ? fmt(q.ltp) : '—'}
                </span>
              </span>
              <div className="flex items-center gap-1.5">
                {/* Bid/ask-style SELL and BUY, the way a broker terminal puts
                    them on the chart. These preselect the side and return to
                    the ticket rather than firing a market order — see
                    tradeFromChart. */}
                <button
                  type="button"
                  onClick={() => tradeFromChart('sell')}
                  className="rounded-lg bg-down px-3 py-1.5 text-xs font-bold text-white transition-opacity duration-micro hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  SELL
                </button>
                <button
                  type="button"
                  onClick={() => tradeFromChart('buy')}
                  className="rounded-lg bg-up px-3 py-1.5 text-xs font-bold text-white transition-opacity duration-micro hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  BUY
                </button>
                <IconButton aria-label="Exit full screen" onClick={() => setMaximized(false)} className="ml-1 h-7 w-7">
                  <CloseIcon className="h-4 w-4" />
                </IconButton>
              </div>
            </div>
          )}
          {/* `relative` anchors the expand control to the chart's own corner. */}
          <div className="relative flex flex-1 items-center justify-center">
            <ChartExpandButton expanded={maximized} onToggle={() => setMaximized((m) => !m)} />
            {contract ? (
              contractCandles ? (
                <TradeChart candles={contractCandles} height={chartHeight} liveLast={contractLtp ?? undefined} fitKey={`${q.symbol}|${contractKey}|${tf}`} intervalMinutes={TF_MINUTES[tf]} aria-label={`${q.symbol} ${contract.strike} ${contract.optionType} chart`} />
              ) : optionCandlesStatus === 'loading' ? (
                <div className="w-full animate-pulse rounded bg-hover" style={{ height: chartHeight }} />
              ) : (
                <DataUnavailable
                  title="No traded history for this contract"
                  detail={`Dhan has no traded candles for ${q.symbol} ${contract.strike} ${contract.optionType}. Nothing is drawn — this panel no longer derives a Black-Scholes shape to fill the gap.`}
                />
              )
            ) : candles ? (
              <TradeChart
                candles={candles}
                height={chartHeight}
                liveLast={liveMatch?.ltp}
                fitKey={`${q.symbol}|${tf}`}
                intervalMinutes={TF_MINUTES[tf]}
                priceLines={priceLines}
                aria-label={`${q.symbol} ${tf} chart`}
              />
            ) : candlesStatus === 'loading' ? (
              <div className="w-full animate-pulse rounded bg-hover" style={{ height: chartHeight }} />
            ) : candlesReason === 'api-unreachable' ? (
              <DataUnavailable
                title="Market data API not connected"
                detail="The Dhan live-feed bridge (port 4600) is not reachable, so no real candles could be loaded. Start it and reload — no simulated series will be drawn in the meantime."
              />
            ) : (
              <DataUnavailable
                title="No history available"
                detail={`Dhan returned no candles for ${q.symbol} at ${tf}. Try a different timeframe, or check that this symbol is covered by the feed.`}
              />
            )}
          </div>
          <p className="pt-2 text-center text-[10px] text-faint">
            {contract
              ? hasRealContractCandles
                ? `${q.symbol} ${contract.strike} ${contract.optionType} · ${tf} — real traded OHLC for this contract from Dhan${realOptionLtp ? `, live premium ${fmt(realOptionLtp)} (matches the Option Chain tab)` : ''}.`
                : realOptionLtp
                  ? `${q.symbol} ${contract.strike} ${contract.optionType} · ${fmt(realOptionLtp)} — live premium is real (matches the Option Chain tab); Dhan has no traded candle history for this contract, so no chart is drawn.`
                  : `${q.symbol} ${contract.strike} ${contract.optionType} — no live chain for this contract${optionQuoteStatus === 'loading' ? ' yet' : ''}. No premium and no chart: nothing here is estimated.`
              : realCandles
                ? `${q.symbol} · ${tf} — real OHLC history from Dhan (charting by TradingView).`
                : candlesStatus === 'loading'
                  ? `${q.symbol} · ${tf} — loading real history from Dhan…`
                  : `${q.symbol} · ${tf} — no real data. Nothing is simulated.`}
          </p>
        </div>
      )}
    </Panel>
  );
}
