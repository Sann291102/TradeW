'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { CandleInterval } from '@tradew/types';
import { Card, EmptyState, Skeleton, cn } from '@tradew/ui';
import { TradeChart } from '@/components/charts/TradeChart';
import { ChartExpandButton } from '@/components/charts/ChartExpandButton';
import { useCandles } from '@/lib/hooks/useCandles';
import { fmt } from '@/lib/format';

type AssetTab = 'indices' | 'stocks' | 'fo' | 'commodities';
type Range = '1D' | '1W' | '1M' | '1Y' | '5Y';
type ChartType = 'line' | 'candles';

const ASSET_TABS: { key: AssetTab; label: string }[] = [
  { key: 'indices', label: 'Indices' },
  { key: 'stocks', label: 'Stocks' },
  { key: 'fo', label: 'F&O' },
  { key: 'commodities', label: 'Commodities' },
];

const RANGES: Range[] = ['1D', '1W', '1M', '1Y', '5Y'];

const RANGE_CONFIG: Record<Range, { interval: CandleInterval; days: number; intervalMinutes?: number }> = {
  '1D': { interval: '5m', days: 1, intervalMinutes: 5 },
  '1W': { interval: '1h', days: 7, intervalMinutes: 60 },
  '1M': { interval: '1d', days: 30 },
  '1Y': { interval: '1d', days: 365 },
  '5Y': { interval: '1d', days: 1825 },
};

const INDEX_SYMBOLS = [
  { symbol: 'NIFTY', label: 'NIFTY 50' },
  { symbol: 'BANKNIFTY', label: 'NIFTY Bank' },
  { symbol: 'SENSEX', label: 'Sensex' },
  { symbol: 'FINNIFTY', label: 'Fin Nifty' },
];

const STOCK_SYMBOLS = [
  { symbol: 'RELIANCE', label: 'Reliance' },
  { symbol: 'TCS', label: 'TCS' },
  { symbol: 'HDFCBANK', label: 'HDFC Bank' },
  { symbol: 'INFY', label: 'Infosys' },
  { symbol: 'TATAMOTORS', label: 'Tata Motors' },
];

const COMMODITY_SYMBOLS = [
  { symbol: 'GOLD', label: 'Gold' },
  { symbol: 'SILVER', label: 'Silver' },
  { symbol: 'CRUDEOIL', label: 'Crude Oil' },
];

/** Fallback height for the first paint, before the ResizeObserver below
 *  reports the card's real (grid-stretched) height. */
const FALLBACK_CHART_HEIGHT = 400;

function LineChartIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 17 9 11l4 3 7-9" />
      <path d="M4 21h16" />
    </svg>
  );
}

function CandlestickIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M7 4v3M7 15v5" />
      <rect x="4.5" y="7" width="5" height="8" rx="1" />
      <path d="M17 3v4M17 17v4" />
      <rect x="14.5" y="7" width="5" height="10" rx="1" />
    </svg>
  );
}

/**
 * MarketOverview — the reference's centerpiece chart card: asset-class tabs
 * (Indices/Stocks/F&O/Commodities) x range tabs (1D..5Y) over a real OHLC
 * series from `useCandles` (Dhan bridge `/candles`, same hook the terminal
 * chart uses). No fabricated series when history isn't available (the repo's
 * no-fabricated-data rule, see useCandles.ts) — F&O has no plain chartable
 * symbol on this surface (a contract needs expiry/strike/type, chosen on the
 * Trade screen's option chain), so that tab is an honest, clearly marked
 * integration point rather than a fake chart.
 *
 * Line and Candles are BOTH `TradeChart` (the same lightweight-charts/
 * TradingView-style engine the Trade screen uses), just a different
 * `seriesType` — previously Line used a separate hand-rolled SVG component,
 * which not only looked visually inconsistent with Candles but rendered at a
 * different actual pixel height (a proportional SVG viewBox vs a literal
 * pixel canvas), so toggling view visibly resized the card. One engine, for
 * both.
 *
 * The chart fills its card via CSS (`h-full flex-1`) and a `ResizeObserver`
 * reports that filled area's real pixel height back into React — lightweight-
 * charts needs an explicit pixel number, it has no percentage/auto sizing —
 * so the chart always exactly matches its grid row's height (set by its
 * sibling Watchlist + Market Alerts column in MarketWorkspace.tsx) at
 * whatever the viewport width happens to be, rather than a hardcoded height
 * that only lined up at one specific width.
 */
export function MarketOverview() {
  const [assetTab, setAssetTab] = useState<AssetTab>('indices');
  const [range, setRange] = useState<Range>('1D');
  const [symbol, setSymbol] = useState('NIFTY');
  const [chartType, setChartType] = useState<ChartType>('line');
  const [maximized, setMaximized] = useState(false);

  const chartWrapperRef = useRef<HTMLDivElement>(null);
  const [chartHeight, setChartHeight] = useState(FALLBACK_CHART_HEIGHT);

  useEffect(() => {
    const el = chartWrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h && h > 40) setChartHeight(Math.round(h));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const quickPicks = assetTab === 'indices' ? INDEX_SYMBOLS : assetTab === 'stocks' ? STOCK_SYMBOLS : assetTab === 'commodities' ? COMMODITY_SYMBOLS : [];
  const { interval, days, intervalMinutes } = RANGE_CONFIG[range];
  const chartable = assetTab !== 'fo';
  const { candles, status, reason } = useCandles(chartable ? symbol : '', interval, days);

  function onAssetTab(tab: AssetTab) {
    setAssetTab(tab);
    if (tab === 'indices') setSymbol('NIFTY');
    else if (tab === 'stocks') setSymbol('RELIANCE');
    else if (tab === 'commodities') setSymbol('GOLD');
  }

  const low = candles && candles.length > 0 ? Math.min(...candles.map((c) => c.low)) : null;
  const high = candles && candles.length > 0 ? Math.max(...candles.map((c) => c.high)) : null;

  return (
    <Card
      title="Market Overview"
      elevation={2}
      className={cn('flex h-full flex-col', maximized && 'fixed inset-0 z-50 max-w-none overflow-y-auto rounded-none')}
      actions={
        <div role="tablist" aria-label="Chart range" className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              role="tab"
              aria-selected={range === r}
              onClick={() => setRange(r)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-bold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                range === r ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
              )}
            >
              {r}
            </button>
          ))}
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Asset class" className="flex gap-1">
          {ASSET_TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={assetTab === t.key}
              onClick={() => onAssetTab(t.key)}
              className={cn(
                'rounded-lg px-2.5 py-1 text-xs font-bold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                assetTab === t.key ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {quickPicks.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {quickPicks.map((q) => (
              <button
                key={q.symbol}
                onClick={() => setSymbol(q.symbol)}
                aria-pressed={symbol === q.symbol}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-[11px] font-semibold transition-colors duration-micro',
                  symbol === q.symbol ? 'border-teal text-teal' : 'border-border2 text-faint hover:text-muted',
                )}
              >
                {q.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {!chartable ? (
        <div className="flex flex-1 flex-col justify-center">
          <EmptyState
            title="Option-contract charts live on the Trade screen"
            description="F&O charting needs a contract (underlying, expiry, strike, type) — pick one from the option chain to see its real chart."
            action={
              <Link href="/trade" className="text-xs font-bold text-teal hover:underline">
                Open Trade →
              </Link>
            }
          />
        </div>
      ) : status === 'loading' ? (
        <Skeleton className="w-full flex-1" style={{ minHeight: FALLBACK_CHART_HEIGHT }} />
      ) : status === 'unavailable' ? (
        <div className="flex flex-1 flex-col justify-center">
          <EmptyState
            title={reason === 'api-unreachable' ? 'Live chart data unreachable' : 'No history for this symbol yet'}
            description={
              reason === 'api-unreachable'
                ? 'The market-data bridge could not be reached — showing nothing rather than an invented chart.'
                : `Dhan has no ${range} bars for ${symbol} at this interval.`
            }
          />
        </div>
      ) : (
        <>
          {/* flex-1 so this fills whatever's left of the card's (grid-
              stretched) height after the tabs above and the Low/High row
              below take their own natural size — ResizeObserver on this
              exact element feeds `chartHeight`. Relatively positioned to
              itself, not the whole card — the expand button must overlay
              only the chart, not collide with the row beneath it. */}
          <div ref={chartWrapperRef} className="relative min-h-[200px] flex-1">
            <TradeChart
              candles={candles ?? []}
              height={chartHeight}
              seriesType={chartType === 'line' ? 'area' : 'candlestick'}
              intervalMinutes={intervalMinutes}
              fitKey={`${symbol}|${range}|${chartType}`}
              aria-label={`${symbol} ${chartType === 'line' ? 'line' : 'candlestick'} chart`}
            />
            <ChartExpandButton expanded={maximized} onToggle={() => setMaximized((m) => !m)} />
          </div>

          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-muted">
              Low <b className="font-mono tabular-nums text-down">{low != null ? fmt(low) : '—'}</b>
            </span>

            {/* Line/Candles chart-type toggle — both render via TradeChart. */}
            <div role="tablist" aria-label="Chart type" className="flex gap-1">
              <button
                type="button"
                role="tab"
                aria-selected={chartType === 'line'}
                aria-label="Line chart"
                title="Line chart"
                onClick={() => setChartType('line')}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                  chartType === 'line' ? 'bg-teal-bg text-teal' : 'text-faint hover:bg-hover hover:text-muted',
                )}
              >
                <LineChartIcon />
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={chartType === 'candles'}
                aria-label="Candlestick chart"
                title="Candlestick chart"
                onClick={() => setChartType('candles')}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                  chartType === 'candles' ? 'bg-teal-bg text-teal' : 'text-faint hover:bg-hover hover:text-muted',
                )}
              >
                <CandlestickIcon />
              </button>
            </div>

            <span className="text-muted">
              High <b className="font-mono tabular-nums text-up">{high != null ? fmt(high) : '—'}</b>
            </span>
          </div>
        </>
      )}
    </Card>
  );
}
