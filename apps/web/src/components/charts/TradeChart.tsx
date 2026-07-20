'use client';

import { useEffect, useRef } from 'react';
import { createChart, type IChartApi, type ISeriesApi, ColorType, CrosshairMode } from 'lightweight-charts';
import type { Candle } from '@tradew/types';
import { cn } from '@tradew/ui';

export interface TradeChartProps {
  candles: Candle[];
  height?: number;
  className?: string;
  'aria-label'?: string;
}

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Our own candlestick chart (lightweight-charts, Apache-2.0) — the interim
 * charting engine for Index/Trade workspaces (see
 * docs/product-architecture/TRADINGVIEW-WORKSPACE.md for the real TradingView
 * integration, planned as a separate subdomain). Colors are read from the
 * live design tokens at mount and re-applied whenever `data-theme` changes,
 * so light/dark/high-contrast all render correctly with no chart-specific
 * theme branching here.
 */
export function TradeChart({ candles, height = 320, className, ...aria }: TradeChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const applyTheme = () => {
      const chart = chartRef.current;
      if (!chart) return;
      chart.applyOptions({
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: readToken('--muted'),
        },
        grid: {
          vertLines: { color: readToken('--border') },
          horzLines: { color: readToken('--border') },
        },
        rightPriceScale: { borderColor: readToken('--border2') },
        timeScale: { borderColor: readToken('--border2') },
      });
      seriesRef.current?.applyOptions({
        upColor: readToken('--green'),
        downColor: readToken('--red'),
        borderVisible: false,
        wickUpColor: readToken('--green'),
        wickDownColor: readToken('--red'),
      });
    };

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;
    seriesRef.current = chart.addCandlestickSeries();
    applyTheme();

    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    resizeObserver.observe(el);

    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // height intentionally excluded — resized via ResizeObserver, not re-init
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    seriesRef.current?.setData(
      candles.map((c) => ({
        time: Math.floor(c.timestamp.getTime() / 1000) as import('lightweight-charts').UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return <div ref={containerRef} className={cn('w-full', className)} style={{ height }} {...aria} />;
}
