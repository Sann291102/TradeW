'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Panel, IconButton, cn } from '@tradew/ui';
import type { CandleInterval } from '@tradew/types';
import { INDEX_QUOTES } from '@/lib/mock/market';
import { fmt, pct } from '@/lib/format';
import { useCandles } from '@/lib/hooks/useCandles';
import { TradeChart } from '@/components/charts/TradeChart';
import { deriveOptionCandles } from '@/lib/mock/optionCandles';
import { blackScholesPrice } from '@/lib/black-scholes';
import { MarketsTab } from './chart-tabs/MarketsTab';
import { TechnicalsTab } from './chart-tabs/TechnicalsTab';
import { OptionChainTab } from './chart-tabs/OptionChainTab';
import { DepthTab } from './chart-tabs/DepthTab';
import { SparkleIcon } from '../../shell/icons';
import type { DockPanelContentProps } from './types';

export interface ContractContext {
  strike: number;
  optionType: 'CE' | 'PE';
  expiryLabel: string;
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
}

export default function ChartPanel({
  className,
  actions,
  collapsed,
  symbol,
  trailingControls,
  contract,
  initialExpiryLabel,
}: ChartPanelProps) {
  const [view, setView] = useState<View>('charts');
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>('15m');

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

  const q = INDEX_QUOTES.find((i) => i.symbol === symbol) ?? INDEX_QUOTES[0];
  const up = q.change >= 0;
  const { interval, days } = TF_CONFIG[tf];
  const { candles } = useCandles(q.symbol, interval, days);
  const { candles: dailyCandles } = useCandles(q.symbol, '1d', 300);

  const contractCandles =
    contract && candles ? deriveOptionCandles(candles, contract.strike, contract.optionType, contract.yearsToExpiry, contract.ivPct) : null;
  const contractLtp = contract ? blackScholesPrice(q.ltp, contract.strike, contract.yearsToExpiry, contract.ivPct, contract.optionType === 'CE' ? 'call' : 'put') : null;

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
          <IconButton aria-label="Analyze this chart with TradeW AI" className="h-7 w-7 text-teal">
            <SparkleIcon className="h-4 w-4" />
          </IconButton>
          {actions}
        </>
      }
    >
      <div role="tablist" aria-label="Instrument view" className="mb-2 flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border pb-2">
        {VIEWS.map((v) => (
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

      {view === 'optionChain' && <OptionChainTab underlyingSymbol={q.symbol} initialExpiryLabel={initialExpiryLabel} />}

      {view === 'depth' && <DepthTab />}

      {view === 'charts' && (
        <>
          <div className="flex flex-1 items-center justify-center">
            {contract ? (
              contractCandles ? (
                <TradeChart candles={contractCandles} height={280} aria-label={`${q.symbol} ${contract.strike} ${contract.optionType} chart`} />
              ) : (
                <div className="h-[280px] w-full animate-pulse rounded bg-hover" />
              )
            ) : candles ? (
              <TradeChart candles={candles} height={280} aria-label={`${q.symbol} ${tf} chart`} />
            ) : (
              <div className="h-[280px] w-full animate-pulse rounded bg-hover" />
            )}
          </div>
          <p className="pt-2 text-center text-[10px] text-faint">
            {contract
              ? `${q.symbol} ${contract.strike} ${contract.optionType} — premium derived via Black-Scholes from mock underlying candles + mock IV, not a live feed.`
              : `${q.symbol} · ${tf} — mock candles; live provider lands in a later milestone.`}
          </p>
        </>
      )}
    </Panel>
  );
}
