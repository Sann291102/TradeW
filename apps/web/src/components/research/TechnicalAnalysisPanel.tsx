'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Candle } from '@tradew/types';
import { Badge, Card, CandleLoader, cn } from '@tradew/ui';
import { api } from '@/lib/api';
import { useCandles } from '@/lib/hooks/useCandles';
import { classicPivots, macdHistogram, rsi, sma, smaSignal, technicalIndicators } from '@/lib/technicals';
import { percent, ratio } from '@/lib/research/format';
import { DataUnavailable } from './DataUnavailable';

export function TechnicalAnalysisPanel({
  symbol,
  exchange,
}: {
  symbol: string;
  exchange?: string;
}) {
  const isUs = useMemo(() => /^NASDAQ|^NYSE|^AMEX/i.test(exchange ?? ''), [exchange]);
  const indianCandles = useCandles(isUs ? '' : symbol, '1d', 260);
  const usCandles = useQuery({
    queryKey: ['research', 'us-candles', symbol],
    queryFn: () => fetchUsStockCandles(symbol),
    enabled: isUs,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  const candles = isUs ? usCandles.data ?? null : indianCandles.candles;
  const loading = isUs ? usCandles.isPending : indianCandles.status === 'loading';
  const error = isUs
    ? usCandles.isError
      ? usCandles.error instanceof Error
        ? usCandles.error.message
        : 'US market candles could not be loaded.'
      : null
    : indianCandles.status === 'unavailable'
      ? indianCandles.reason === 'api-unreachable'
        ? 'The market-data bridge could not be reached.'
        : 'No historical candles are available for this symbol.'
      : null;

  return (
    <Card title="Technical analysis" subtitle="· actual candle history only">
      {loading && (
        <div className="flex justify-center py-10">
          <CandleLoader size="sm" label={`Loading technicals for ${symbol}`} />
        </div>
      )}

      {!loading && error && <DataUnavailable title="Technical analysis unavailable" reason={error} />}

      {!loading && !error && candles && candles.length >= 30 && <TechnicalBody candles={candles} />}
    </Card>
  );
}

function TechnicalBody({ candles }: { candles: Candle[] }) {
  const closes = candles.map((c) => c.close);
  const latest = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;
  const pivots = classicPivots(prev.high, prev.low, prev.close);
  const indicators = technicalIndicators(candles);
  const maPeriods = [20, 50, 100, 200] as const;
  const movingAverages = maPeriods.map((period) => ({ period, value: sma(closes, period), signal: smaSignal(latest.close, sma(closes, period)) }));
  const rsiValue = rsi(closes);
  const macd = macdHistogram(closes);
  const dailyReturns = closes.slice(1).map((value, index) => (closes[index] === 0 ? 0 : (value - closes[index]) / closes[index]));
  const volatility =
    dailyReturns.length >= 20
      ? Math.sqrt(dailyReturns.reduce((sum, value) => sum + value * value, 0) / dailyReturns.length) * Math.sqrt(252) * 100
      : null;
  const trend =
    movingAverages[0].value != null && movingAverages[1].value != null
      ? latest.close > movingAverages[0].value && movingAverages[0].value > movingAverages[1].value
        ? 'Bullish trend'
        : latest.close < movingAverages[0].value && movingAverages[0].value < movingAverages[1].value
          ? 'Bearish trend'
          : 'Mixed trend'
      : 'Trend unclear';
  const signals = [
    `Price ${latest.close > pivots.pivot ? 'above' : 'below'} the classic pivot (${ratio(pivots.pivot)})`,
    rsiValue != null ? `RSI ${rsiValue < 30 ? 'oversold' : rsiValue > 70 ? 'overbought' : 'neutral'} at ${ratio(rsiValue)}` : 'RSI unavailable',
    macd != null ? `MACD histogram ${macd >= 0 ? 'positive' : 'negative'} at ${ratio(macd)}` : 'MACD unavailable',
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
              1D candles
            </Badge>
            <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
              volume included
            </Badge>
          </div>
          <p className="mt-2 text-sm font-semibold text-text">{trend}</p>
          <p className="mt-1 text-[11px] text-faint">
            Close {ratio(latest.close)} · volume {latest.volume.toLocaleString('en-IN')} · annualized volatility{' '}
            {volatility != null ? percent(volatility) : 'not available'}
          </p>
          <LineChart candles={candles.slice(-60)} />
          <VolumeBars candles={candles.slice(-30)} />
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-border p-3">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-faint">Moving averages</h3>
            <div className="mt-2 space-y-1.5">
              {movingAverages.map((average) => (
                <div key={average.period} className="flex items-center justify-between text-[11px]">
                  <span className="text-muted">{average.period}-SMA</span>
                  <span className="font-mono text-text">
                    {average.value != null ? ratio(average.value) : '—'} ·{' '}
                    <span className={cn(average.signal === 'Bullish' ? 'text-up' : average.signal === 'Bearish' ? 'text-down' : 'text-faint')}>
                      {average.signal}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border p-3">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-faint">Support & resistance</h3>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
              <Level label="R2" value={pivots.r2} tone="negative" />
              <Level label="R1" value={pivots.r1} tone="negative" />
              <Level label="Pivot" value={pivots.pivot} tone="neutral" />
              <Level label="S1" value={pivots.s1} tone="positive" />
              <Level label="S2" value={pivots.s2} tone="positive" />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border p-3">
          <h3 className="text-[11px] font-bold uppercase tracking-wide text-faint">Indicator snapshot</h3>
          <ul className="mt-2 space-y-1 text-[11px]">
            {indicators.map((indicator) => (
              <li key={indicator.name} className="flex items-center justify-between">
                <span className="text-muted">{indicator.name}</span>
                <span className={cn(indicator.signal === 'Bullish' ? 'text-up' : indicator.signal === 'Bearish' ? 'text-down' : 'text-faint')}>
                  {indicator.value != null ? `${ratio(indicator.value)} · ${indicator.signal}` : indicator.signal}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-border p-3">
          <h3 className="text-[11px] font-bold uppercase tracking-wide text-faint">Relevant signals</h3>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-muted">
            {signals.map((signal) => (
              <li key={signal}>{signal}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function LineChart({ candles }: { candles: Candle[] }) {
  const width = 520;
  const height = 180;
  const closes = candles.map((c) => c.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const points = candles
    .map((candle, index) => {
      const x = (index / Math.max(candles.length - 1, 1)) * width;
      const y = max === min ? height / 2 : height - ((candle.close - min) / (max - min)) * height;
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-3 h-44 w-full rounded bg-bg/40">
      <polyline fill="none" stroke="currentColor" strokeWidth="2" className="text-teal" points={points} />
    </svg>
  );
}

function VolumeBars({ candles }: { candles: Candle[] }) {
  const width = 520;
  const height = 80;
  const maxVolume = Math.max(...candles.map((c) => c.volume), 1);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 h-20 w-full rounded bg-bg/40">
      {candles.map((candle, index) => {
        const barWidth = width / candles.length;
        const x = index * barWidth;
        const barHeight = (candle.volume / maxVolume) * height;
        return <rect key={`${candle.timestamp}-${index}`} x={x} y={height - barHeight} width={Math.max(barWidth - 1, 1)} height={barHeight} className="fill-teal/60" />;
      })}
    </svg>
  );
}

function Level({ label, value, tone }: { label: string; value: number; tone: 'positive' | 'negative' | 'neutral' }) {
  return (
    <div className="rounded border border-border2 px-2 py-1">
      <p className="text-[10px] text-faint">{label}</p>
      <p className={cn('font-mono', tone === 'positive' ? 'text-up' : tone === 'negative' ? 'text-down' : 'text-text')}>{ratio(value)}</p>
    </div>
  );
}

async function fetchUsStockCandles(symbol: string): Promise<Candle[]> {
  const response = (await api(
    `/us-stocks/candles?symbol=${encodeURIComponent(symbol)}&interval=1d&outputsize=260`,
  )) as { candles: Array<{ timestamp?: string; datetime?: string; open: number; high: number; low: number; close: number; volume: number }> };
  return response.candles.map((candle) => ({
    timestamp: new Date((candle.timestamp ?? candle.datetime) as string),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }));
}
