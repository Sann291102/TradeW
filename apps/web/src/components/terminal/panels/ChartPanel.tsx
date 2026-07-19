'use client';

import { useState } from 'react';
import { Panel, Sparkline, IconButton, cn } from '@tradew/ui';
import { INDEX_QUOTES } from '@/lib/mock/market';
import { fmt, pct } from '@/lib/format';
import { SparkleIcon } from '../../shell/icons';
import type { DockPanelContentProps } from './types';

const TIMEFRAMES = ['1m', '5m', '15m', '1H', '1D', '1W'] as const;

/**
 * Chart slot — the trading chart with the canonical toolbar (symbol + live
 * price, timeframe pills, indicators, AI shortcut). Milestone 2 renders a
 * placeholder trend (large Sparkline) in place of a real charting engine;
 * this panel is lazy-loaded (next/dynamic in WorkspaceDock) per the
 * performance brief. Default-exported for dynamic import.
 */
export default function ChartPanel({ className, actions, collapsed }: DockPanelContentProps) {
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>('15m');
  const q = INDEX_QUOTES[0];
  const up = q.change >= 0;
  return (
    <Panel
      className={className}
      collapsed={collapsed}
      scroll={false}
      bodyClassName="flex flex-col"
      title={
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-bold normal-case text-text">{q.symbol}</span>
          <span className="font-mono text-[12px] tabular-nums text-text">{fmt(q.ltp)}</span>
          <span className={cn('font-mono text-[11px] tabular-nums', up ? 'text-up' : 'text-down')}>{pct(q.changePct)}</span>
        </span>
      }
      actions={
        <>
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
          <IconButton aria-label="Analyze this chart with TradeW AI" className="h-7 w-7 text-teal">
            <SparkleIcon className="h-4 w-4" />
          </IconButton>
          {actions}
        </>
      }
    >
      <div className="flex flex-1 items-center justify-center">
        <Sparkline data={q.spark} width={640} height={200} className="w-full" aria-label={`${q.symbol} ${tf} chart preview`} />
      </div>
      <p className="pt-2 text-center text-[10px] text-faint">
        Chart preview · {tf} — charting engine / TradingView workspace lands in a later milestone.
      </p>
    </Panel>
  );
}
