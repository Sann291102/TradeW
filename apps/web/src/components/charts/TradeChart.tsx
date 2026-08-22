'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
  ColorType,
  CrosshairMode,
  TickMarkType,
} from 'lightweight-charts';
import type { Candle } from '@tradew/types';
import { cn } from '@tradew/ui';
import { candleTime, type ChartDrawing } from '@/lib/charts/drawings';
import { ChartDrawingsPrimitive } from './drawingPrimitive';
import { useSettingsStore } from '@/lib/store/settingsStore';

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
  /** Live last-traded price. When provided, the most recent (forming) candle's
   *  close/high/low track this in real time via `series.update()` — so the
   *  chart stays in sync with the live feed without a full re-fetch and,
   *  crucially, without resetting the user's zoom/pan (setData + fitContent
   *  would). Omit for a purely historical chart. */
  liveLast?: number;
  /** Identity of the series being shown — e.g. `SYMBOL|contract|timeframe`.
   *  The view is auto-fitted ONLY when this changes. Any other data update
   *  (a reload, a re-derive, a live tick) leaves the user's zoom/pan exactly as
   *  they set it. Without this, a trader's zoom was silently thrown away every
   *  time the series object was rebuilt. */
  fitKey?: string;
  /** 'candlestick' (default, every existing caller) or 'area' — a filled
   *  line series plotting each bar's close, colored by direction (matching
   *  the reference dashboard's "Line" chart view). Changing this recreates
   *  the chart's series, so it's meant for a deliberate view toggle
   *  (MarketOverview's Line/Candles switch), not a per-render value. */
  seriesType?: 'candlestick' | 'area';
  /** Zones and lines painted inside the chart's own render pass — fair value
   *  gaps, trendlines, order blocks. Rendered by `ChartDrawingsPrimitive`; the
   *  array is replaced wholesale, and erasure is tag-scoped at the caller (see
   *  `lib/charts/drawings.ts`) so one producer's redraw can't wipe another's. */
  drawings?: ChartDrawing[];
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
export function TradeChart({
  candles,
  height = 320,
  className,
  intervalMinutes,
  liveLast,
  fitKey,
  priceLines,
  seriesType = 'candlestick',
  drawings,
  ...aria
}: TradeChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Area'> | null>(null);
  // Latest live price, read inside the setData effect without making it a
  // dependency — otherwise every tick would re-run setData (and refit).
  const liveLastRef = useRef<number | undefined>(liveLast);
  liveLastRef.current = liveLast;
  /** Which series the current view was last auto-fitted for (see `fitKey`). */
  const lastFitKeyRef = useRef<string | null>(null);
  const priceLineRefs = useRef<IPriceLine[]>([]);
  /** Direction of the area series' current data (last close vs first close) —
   *  read by `applyTheme` on a theme change, when no data update is in
   *  flight. Only meaningful for `seriesType: 'area'`. */
  const lastDirectionRef = useRef<'up' | 'down'>('up');
  /** The drawing layer. Attached inside the mount effect rather than in an
   *  effect of its own: the series it hangs off is torn down and rebuilt when
   *  `seriesType` changes, and a separate effect's cleanup would run against a
   *  chart `chart.remove()` had already disposed. */
  const drawingsPrimitiveRef = useRef<ChartDrawingsPrimitive | null>(null);
  /** Read once at attach time without making `drawings` a mount dependency. */
  const drawingsRef = useRef<ChartDrawing[] | undefined>(drawings);
  drawingsRef.current = drawings;
  /** The live chart's theme/chrome applier, published by the mount effect. */
  const applyThemeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const applyTheme = () => {
      const chart = chartRef.current;
      if (!chart) return;
      // Chart chrome the user can switch off in Settings -> Appearance. Read
      // from the store at apply-time rather than closed over, for the same
      // reason the colours are read from tokens: this function is also the
      // MutationObserver callback, and it must report current state whenever
      // it runs.
      const chrome = useSettingsStore.getState().prefs.appearance;
      const gridColor = chrome.showChartGrid ? readToken('--border') : 'transparent';
      chart.applyOptions({
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: readToken('--muted'),
        },
        grid: {
          vertLines: { color: gridColor, visible: chrome.showChartGrid },
          horzLines: { color: gridColor, visible: chrome.showChartGrid },
        },
        crosshair: { mode: chrome.showCrosshair ? CrosshairMode.Normal : CrosshairMode.Hidden },
        rightPriceScale: { borderColor: readToken('--border2') },
        timeScale: { borderColor: readToken('--border2') },
      });
      // `--candle-up` / `--candle-down` default to `--green` / `--red` in
      // tokens.css and are overridden inline on <html> when the account has
      // picked its own colours. Reading them here — rather than the direction
      // tokens directly — is what makes Settings -> Appearance reach a real
      // chart, and it is why this observer also watches the two data-candle-*
      // attributes below.
      const upColor = readToken('--candle-up') || readToken('--green');
      const downColor = readToken('--candle-down') || readToken('--red');
      if (seriesType === 'candlestick') {
        (seriesRef.current as ISeriesApi<'Candlestick'> | null)?.applyOptions({
          // Hollow up-candles: a transparent body with a coloured border, the
          // convention many desktop terminals use to make direction readable
          // without relying on fill alone.
          upColor: chrome.hollowUpCandles ? 'transparent' : upColor,
          downColor,
          borderVisible: chrome.hollowUpCandles,
          borderUpColor: upColor,
          borderDownColor: downColor,
          wickUpColor: upColor,
          wickDownColor: downColor,
        });
      } else {
        const up = lastDirectionRef.current !== 'down';
        (seriesRef.current as ISeriesApi<'Area'> | null)?.applyOptions({
          lineColor: up ? upColor : downColor,
          topColor: readToken(up ? '--green-bg' : '--red-bg'),
          bottomColor: 'transparent',
          lineWidth: 2,
        });
      }
      // Drawing colours are resolved from tokens at paint time, so a theme
      // change needs a new frame or zones keep the old palette.
      drawingsPrimitiveRef.current?.requestRedraw();
    };

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      localization: { timeFormatter: makeIstCrosshairFormatter(intervalMinutes) },
    });
    chartRef.current = chart;
    seriesRef.current =
      seriesType === 'candlestick'
        ? chart.addCandlestickSeries()
        : chart.addAreaSeries({ lineWidth: 2, priceLineVisible: true });

    const drawingsPrimitive = new ChartDrawingsPrimitive();
    seriesRef.current.attachPrimitive(drawingsPrimitive);
    drawingsPrimitiveRef.current = drawingsPrimitive;
    drawingsPrimitive.setDrawings(drawingsRef.current ?? []);

    applyTheme();
    // Published so the preference effect below can re-run it without
    // recreating the chart. A ref rather than state: assigning it must not
    // re-render, and it has to be readable by an effect that deliberately does
    // not depend on the chart's mount cycle.
    applyThemeRef.current = applyTheme;

    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    resizeObserver.observe(el);

    const themeObserver = new MutationObserver(applyTheme);
    // `data-candle-up`/`data-candle-down` mirror the inline custom properties
    // written by lib/settings/apply.ts. The attributes exist ONLY so this
    // observer has something to filter on — a MutationObserver cannot watch a
    // single CSS custom property, and watching `style` would wake on every
    // unrelated inline-style write to <html>.
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-candle-up', 'data-candle-down'],
    });

    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      // No explicit detachPrimitive: `chart.remove()` disposes the series and
      // everything attached to it, and calling detach afterwards would touch a
      // disposed object.
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      drawingsPrimitiveRef.current = null;
      applyThemeRef.current = null;
    };
    // height intentionally excluded — resized via ResizeObserver, not re-init.
    // seriesType IS a dependency — switching it tears down and recreates the
    // chart with the other series kind (a deliberate, infrequent view toggle,
    // not something that needs an in-place series swap).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesType]);

  /**
   * Re-apply chart chrome when the account's appearance settings change.
   *
   * The COLOURS arrive through the MutationObserver above (they are written to
   * <html> as custom properties, which is also what makes them survive a chart
   * remount). The three booleans have no DOM representation — nothing would
   * paint differently for a grid toggle — so they are subscribed to here and
   * pushed through the same applier, which keeps one code path deciding what
   * the chart looks like.
   */
  const chartChrome = useSettingsStore((s) => {
    const a = s.prefs.appearance;
    return `${a.showChartGrid}|${a.showCrosshair}|${a.hollowUpCandles}`;
  });
  useEffect(() => {
    applyThemeRef.current?.();
  }, [chartChrome]);

  // The chart itself is created once on mount, so switching timeframe has to
  // re-apply the crosshair formatter — otherwise a 15m chart would keep
  // showing a 5m chart's bar span.
  useEffect(() => {
    chartRef.current?.applyOptions({ localization: { timeFormatter: makeIstCrosshairFormatter(intervalMinutes) } });
  }, [intervalMinutes]);

  // The mount effect only sizes width (via ResizeObserver); height comes in as
  // a prop, so a height change (e.g. entering full screen) must be applied to
  // the chart canvas explicitly or it stays at its original size.
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
    chartRef.current?.applyOptions({ height });
  }, [height]);

  // Drawings are pushed into the primitive rather than passed through a
  // render: the chart owns its own frame scheduling, so this asks for a
  // repaint instead of performing one.
  useEffect(() => {
    drawingsPrimitiveRef.current?.setDrawings(drawings ?? []);
  }, [drawings]);

  // Full history load — runs only when the candle *series* itself changes
  // (symbol / timeframe), NOT on every live tick, because live ticks no longer
  // reload the series (see useCandles). fitContent here is therefore a
  // deliberate "fit the new series", and it no longer fights the user's zoom
  // on every price update the way it used to.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    if (seriesType === 'candlestick') {
      const data = candles.map((c) => ({
        time: candleTime(c) as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      // Fold the current live price into the forming bar so the newly-loaded
      // series already reflects the feed, before the per-tick effect below
      // takes over.
      const live = liveLastRef.current;
      if (live != null && data.length > 0) {
        const last = data[data.length - 1];
        last.close = live;
        last.high = Math.max(last.high, live);
        last.low = Math.min(last.low, live);
      }
      (series as ISeriesApi<'Candlestick'>).setData(data);
    } else {
      const data = candles.map((c) => ({
        time: candleTime(c) as UTCTimestamp,
        value: c.close,
      }));
      const live = liveLastRef.current;
      if (live != null && data.length > 0) data[data.length - 1].value = live;

      const up = data.length < 2 || data[data.length - 1].value >= data[0].value;
      lastDirectionRef.current = up ? 'up' : 'down';
      (series as ISeriesApi<'Area'>).applyOptions({
        lineColor: readToken(up ? '--green' : '--red'),
        topColor: readToken(up ? '--green-bg' : '--red-bg'),
        bottomColor: 'transparent',
      });
      (series as ISeriesApi<'Area'>).setData(data);
    }

    // Fit ONLY for a genuinely new series (symbol / contract / timeframe).
    // Re-fitting on any other data change is what used to wipe the user's zoom.
    const key = fitKey ?? '';
    if (lastFitKeyRef.current !== key) {
      lastFitKeyRef.current = key;
      chartRef.current?.timeScale().fitContent();
    }
    // fitKey is read intentionally without being a dependency — it gates the
    // fit, it must not by itself trigger a data reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, seriesType]);

  // Live tick — patch just the last (forming) candle in place. series.update()
  // mutates the final bar without touching the visible range, so the chart
  // tracks the live price while preserving whatever zoom/pan the user set.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || liveLast == null || candles.length === 0) return;
    const last = candles[candles.length - 1];
    const time = candleTime(last) as UTCTimestamp;
    if (seriesType === 'candlestick') {
      (series as ISeriesApi<'Candlestick'>).update({
        time,
        open: last.open,
        high: Math.max(last.high, liveLast),
        low: Math.min(last.low, liveLast),
        close: liveLast,
      });
    } else {
      (series as ISeriesApi<'Area'>).update({ time, value: liveLast });
    }
  }, [liveLast, candles, seriesType]);

  return <div ref={containerRef} className={cn('w-full', className)} style={{ height }} {...aria} />;
}
