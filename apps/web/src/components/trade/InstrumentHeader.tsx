'use client';

import type { Candle } from '@tradew/types';
import { Badge, cn } from '@tradew/ui';
import { fmt, pct, sign } from '@/lib/format';
import { getDayStats } from '@/lib/trade/dayStats';
import type { DhanFeedStatus } from '@/lib/hooks/useDhanLiveFeed';

function OhlcStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[68px]">
      <div className="text-[10.5px] text-faint">{label}</div>
      <div className="font-mono text-[13px] font-semibold tabular-nums text-text">{value}</div>
    </div>
  );
}

export interface InstrumentHeaderProps {
  symbol: string;
  name: string;
  ltp: number | null;
  changePct: number | null;
  /** Real daily candles (same series ChartPanel already fetches for the
   *  Markets/Technicals tabs) — the OHLC row below the price is derived from
   *  this, not a separate fetch. */
  dailyCandles: Candle[];
  feedStatus: DhanFeedStatus;
  /** Exchange badge — always NSE for now (every symbol on this feed is NSE),
   *  kept as a prop rather than hardcoded JSX so it reads as data, not chrome. */
  exchange?: string;
}

/**
 * Rich instrument header — name, live price, change, and the day's OHLC row,
 * matching the reference screenshot's hero header. Deliberately renders
 * inside ChartPanel's body (not Panel's compact title bar, which is shared
 * chrome used by every other panel in the app) so this page can have a
 * larger, denser header without changing Panel's look everywhere else.
 * Every value here is a prop straight from ChartPanel's existing live feed /
 * candle state — no new data fetch, no new store.
 */
export function InstrumentHeader({ symbol, name, ltp, changePct, dailyCandles, feedStatus, exchange = 'NSE' }: InstrumentHeaderProps) {
  const up = (changePct ?? 0) >= 0;
  const stats = getDayStats(dailyCandles);
  // Prefer the exact absolute change from today's real prev-close candle;
  // only fall back to deriving it from the feed's rounded percent (still real
  // data, just less precise) when daily candles haven't loaded yet.
  const changeAbs =
    ltp != null && stats ? ltp - stats.prev.close : ltp != null && changePct != null ? ltp - ltp / (1 + changePct / 100) : null;

  return (
    <div className="flex flex-col gap-3 border-b border-border px-1 pb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[19px] font-bold leading-tight text-text">{name}</h1>
            <button
              type="button"
              disabled
              title="Watchlist not connected yet"
              aria-label="Add to watchlist (not connected yet)"
              className="text-faint opacity-60"
            >
              <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3.5l2.7 5.9 6.3.7-4.7 4.4 1.3 6.3L12 17.6l-5.6 3.2 1.3-6.3-4.7-4.4 6.3-.7L12 3.5z" />
              </svg>
            </button>
          </div>
          <div className="mt-0.5 text-[11.5px] text-faint">{symbol}</div>
        </div>
        <Badge tone="neutral" className="shrink-0">
          {exchange}
        </Badge>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex items-baseline gap-2.5">
          <span className="font-mono text-[30px] font-bold leading-none tabular-nums text-text">
            {ltp != null ? fmt(ltp) : '—'}
          </span>
          {ltp != null && changePct != null ? (
            <span className={cn('flex items-center gap-1 rounded-md px-2 py-1 text-[13px] font-bold', up ? 'bg-up-bg text-up' : 'bg-down-bg text-down')}>
              {up ? '▲' : '▼'}
              {changeAbs != null && `${sign(changeAbs)}${fmt(Math.abs(changeAbs))}`} ({pct(changePct)})
            </span>
          ) : (
            <span className="text-[11px] text-faint">live feed not connected</span>
          )}
        </div>

        {stats && (
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <OhlcStat label="Open" value={fmt(stats.today.open)} />
            <OhlcStat label="High" value={fmt(stats.today.high)} />
            <OhlcStat label="Low" value={fmt(stats.today.low)} />
            <OhlcStat label="Prev. Close" value={fmt(stats.prev.close)} />
          </div>
        )}
      </div>

      {feedStatus === 'unreachable' && (
        <Badge tone="warning" className="w-fit">
          Live feed not connected
        </Badge>
      )}
    </div>
  );
}
