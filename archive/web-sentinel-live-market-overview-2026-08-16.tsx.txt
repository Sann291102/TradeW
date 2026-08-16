'use client';

import { useMemo, useState } from 'react';
import type { CandleInterval } from '@tradew/types';
import { cn } from '@tradew/ui';
import { TradeChart } from '@/components/charts/TradeChart';
import { useCandles } from '@/lib/hooks/useCandles';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { buildIndicatorStrip } from '@/lib/sentinel/indicators';
import { fmt, pct } from '@/lib/format';

/**
 * Live Market Overview — real Dhan candles for the selected market/timeframe
 * with a computed indicator strip (EMA20 · RSI14 · VWAP · MACD · OI · IV).
 * Every number is derived from the real OHLCV series; when the bridge has no
 * history the card says so rather than drawing a fabricated chart.
 */

const TABS: { key: CandleInterval; label: string; days: number; minutes: number }[] = [
  { key: '1m', label: '1m', days: 1, minutes: 1 },
  { key: '5m', label: '5m', days: 5, minutes: 5 },
  { key: '15m', label: '15m', days: 10, minutes: 15 },
  { key: '1h', label: '1H', days: 30, minutes: 60 },
  { key: '1d', label: '1D', days: 180, minutes: 1440 },
];

export function LiveMarketOverview({ symbol, marketName }: { symbol: string; marketName: string }) {
  const [tab, setTab] = useState<CandleInterval>('15m');
  const active = TABS.find((t) => t.key === tab) ?? TABS[2];
  const { candles, status, reason } = useCandles(symbol, tab, active.days);
  const { quotes, stocks, etfs, commodities } = useDhanLiveFeed();

  const quote = useMemo(() => {
    const all = [...(quotes ?? []), ...(stocks ?? []), ...(etfs ?? []), ...(commodities ?? [])];
    return all.find((q) => q.symbol?.toUpperCase() === symbol.toUpperCase()) ?? null;
  }, [quotes, stocks, etfs, commodities, symbol]);

  const strip = useMemo(() => buildIndicatorStrip(candles), [candles]);
  const lastClose = quote?.ltp ?? strip.lastClose ?? null;
  const changePct = quote?.changePct ?? null;

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[13px] font-bold text-text">Live Market Overview</h2>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-bg p-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors',
                tab === t.key ? 'bg-teal text-navy' : 'text-muted hover:text-text',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-baseline gap-3">
        <span className="text-[13px] font-bold text-text">{marketName}</span>
        {lastClose != null && <span className="font-mono text-[20px] font-extrabold text-text">{fmt(lastClose)}</span>}
        {changePct != null && (
          <span className={cn('font-mono text-[13px] font-bold', changePct >= 0 ? 'text-up' : 'text-down')}>
            {pct(changePct)}
          </span>
        )}
      </div>

      <div className="mt-3">
        {status === 'loading' && (
          <div className="flex h-[300px] items-center justify-center text-[12px] text-faint">Loading real candles…</div>
        )}
        {status === 'unavailable' && (
          <div className="flex h-[300px] flex-col items-center justify-center gap-1 text-center">
            <p className="text-[13px] font-bold text-text">No chart data</p>
            <p className="max-w-sm text-[11.5px] text-faint">
              {reason === 'api-unreachable'
                ? 'The Dhan live-feed bridge is unreachable. No candles are drawn rather than showing fabricated data.'
                : `Dhan has no ${active.label} history for ${marketName} yet.`}
            </p>
          </div>
        )}
        {status === 'live' && candles && candles.length > 0 && (
          <TradeChart
            candles={candles}
            height={300}
            intervalMinutes={active.minutes}
            liveLast={quote?.ltp}
            fitKey={`${symbol}|${tab}`}
            aria-label={`${marketName} ${active.label} candles`}
          />
        )}
      </div>

      {/* indicator strip — computed from the real series */}
      <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
        <Indicator label="EMA 20" value={strip.ema20 == null ? '—' : fmt(strip.ema20)} tag={strip.ema20Position ? (strip.ema20Position === 'above' ? 'Above Price' : 'Below Price') : undefined} tagTone={strip.ema20Position === 'above' ? 'text-up' : 'text-down'} />
        <Indicator label="RSI (14)" value={strip.rsi14 == null ? '—' : strip.rsi14.toFixed(1)} tag={strip.rsi14 == null ? undefined : strip.rsi14 >= 70 ? 'Overbought' : strip.rsi14 <= 30 ? 'Oversold' : 'Neutral'} tagTone={strip.rsi14 != null && (strip.rsi14 >= 70 || strip.rsi14 <= 30) ? 'text-amber' : 'text-muted'} />
        <Indicator label="VWAP" value={strip.vwap == null ? '—' : fmt(strip.vwap)} />
        <Indicator label="MACD" value={strip.macd == null ? '—' : strip.macd.histogram.toFixed(1)} tag={strip.macd?.bias === 'bullish' ? 'Bullish' : strip.macd ? 'Bearish' : undefined} tagTone={strip.macd?.bias === 'bullish' ? 'text-up' : 'text-down'} />
        <Indicator label="OI Change" value={strip.oiChangePct == null ? '—' : pct(strip.oiChangePct)} tagTone={strip.oiChangePct != null && strip.oiChangePct >= 0 ? 'text-up' : 'text-down'} />
        <Indicator label="Volume" value={candles && candles.length ? fmt(candles[candles.length - 1].volume) : '—'} />
      </div>
    </section>
  );
}

function Indicator({ label, value, tag, tagTone }: { label: string; value: string; tag?: string; tagTone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg p-2.5">
      <p className="text-[9.5px] font-bold uppercase tracking-wideTrack text-faint">{label}</p>
      <p className="mt-1 font-mono text-[13px] font-bold text-text">{value}</p>
      {tag && <p className={cn('mt-0.5 text-[10px] font-semibold', tagTone ?? 'text-muted')}>{tag}</p>}
    </div>
  );
}
