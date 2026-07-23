'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  ColorType,
  CrosshairMode,
  TickMarkType,
} from 'lightweight-charts';
import type { Candle } from '@tradew/types';
import { cn } from '@tradew/ui';

/** A horizontal marker drawn across the chart — used for strategy strikes. */
export interface ChartPriceLine {
  price: number;
  /** Shown on the price axis and at the line's right edge. */
  title: string;
  /** A design token name (e.g. '--up'), resolved at draw time so the line
   *  re-themes with everything else. Falls back to the muted token. */
  colorToken?: string;
  dashed?: boolean;
}

export interface TradeChartProps {
  candles: Candle[];
  height?: number;
  className?: string;
  'aria-label'?: string;
  /** Horizontal lines drawn over the series — strategy strikes, breakevens. */
  priceLines?: ChartPriceLine[];
  /** Candle duration in minutes. When given (intraday only), the crosshair
   *  label shows the bar's full span — "22 Jul 15:15–15:30" — instead of
   *  just its open time. Candles are open-stamped by convention, so the
   *  final bar of an NSE session reads 15:15 even though it runs to the
   *  15:30 close; showing the range removes that ambiguity. */
  intervalMinutes?: number;
}

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * lightweight-charts renders time-axis/crosshair labels from a plain JS
 * `Date`, which formats in the *browser's* local timezone by default — NSE
 * trading hours (9:15–15:30) are IST-relative, so on any machine not itself
 * set to IST the axis silently drifts (e.g. renders in UTC, ~5.5h earlier).
 * These two formatters pin every label to Asia/Kolkata explicitly, matching
 * what a trader actually expects regardless of the viewer's own timezone.
 */
function istTickMarkFormatter(time: Time, tickMarkType: TickMarkType): string {
  const date = new Date((time as number) * 1000);
  switch (tickMarkType) {
    case TickMarkType.Year:
      return date.toLocaleString('en-US', { year: 'numeric', timeZone: 'Asia/Kolkata' });
    case TickMarkType.Month:
      return date.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Kolkata' });
    case TickMarkType.DayOfMonth:
      return date.toLocaleString('en-US', { day: 'numeric', timeZone: 'Asia/Kolkata' });
    case TickMarkType.TimeWithSeconds:
      return date.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
    case TickMarkType.Time:
    default:
      return date.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  }
}

const IST_HHMM: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' };

function makeIstCrosshairFormatter(intervalMinutes?: number) {
  return (time: Time): string => {
    const openMs = (time as number) * 1000;
    const open = new Date(openMs);
    const day = open.toLocaleString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });
    if (!intervalMinutes) return day;
    const close = new Date(openMs + intervalMinutes * 60_000);
    return `${day} ${open.toLocaleString('en-GB', IST_HHMM)}–${close.toLocaleString('en-GB', IST_HHMM)}`;
  };
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
export function TradeChart({ candles, height = 320, className, intervalMinutes, priceLines, ...aria }: TradeChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLineRefs = useRef<IPriceLine[]>([]);

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
      timeScale: { timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      localization: { timeFormatter: makeIstCrosshairFormatter(intervalMinutes) },
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

  // The chart itself is created once on mount, so switching timeframe has to
  // re-apply the crosshair formatter — otherwise a 15m chart would keep
  // showing a 5m chart's bar span.
  useEffect(() => {
    chartRef.current?.applyOptions({ localization: { timeFormatter: makeIstCrosshairFormatter(intervalMinutes) } });
  }, [intervalMinutes]);

  // Strategy strike/breakeven markers. Every line is removed and redrawn on
  // change — lightweight-charts has no update-in-place for price lines, and
  // the count is small (at most a handful of legs plus breakevens).
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    for (const line of priceLineRefs.current) series.removePriceLine(line);
    priceLineRefs.current = [];

    for (const spec of priceLines ?? []) {
      priceLineRefs.current.push(
        series.createPriceLine({
          price: spec.price,
          color: readToken(spec.colorToken ?? '--muted') || '#888',
          lineWidth: 1,
          lineStyle: spec.dashed ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: true,
          title: spec.title,
        }),
      );
    }

    return () => {
      const current = seriesRef.current;
      if (!current) return;
      for (const line of priceLineRefs.current) current.removePriceLine(line);
      priceLineRefs.current = [];
    };
  }, [priceLines]);

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
