'use client';

import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import {
  resolveLineSegment,
  resolveZoneRect,
  type ChartDrawing,
  type DrawingDirection,
  type DrawingViewport,
} from '@/lib/charts/drawings';

/**
 * Paints `ChartDrawing[]` onto a lightweight-charts pane.
 *
 * ── WHY A SERIES PRIMITIVE AND NOT AN ABSOLUTE-POSITIONED OVERLAY ──────────
 *
 * The obvious implementation is a second canvas on top of the chart with its
 * own `ResizeObserver` and a subscription to the visible-range event. That
 * approach re-implements — and then has to keep in sync with — coordinate
 * conversion, device-pixel-ratio scaling, clipping and repaint scheduling, and
 * it lags by a frame on every pan because it repaints *after* the chart does.
 *
 * lightweight-charts 4.1 introduced Series Primitives, and 4.2.3 (the version
 * pinned in `apps/web/package.json`) exposes `series.attachPrimitive()`. A
 * primitive is drawn inside the chart's own render pass, so pan and zoom stay
 * pixel-locked to the candles with no synchronisation code at all.
 *
 * This matters for the version pin: **dropping below 4.1 removes the API this
 * file is built on.** It is not a soft dependency.
 *
 * ── ZONES PAINT UNDER THE CANDLES ──────────────────────────────────────────
 *
 * Zones return `zOrder: 'bottom'`, lines `'normal'`. A translucent band drawn
 * *over* a candlestick mutes the body colour that tells a trader whether the
 * bar closed up or down — the drawing would be degrading the data it exists to
 * annotate. Lines are thin enough to sit on top, and need to, or a trendline
 * disappears behind every bar it touches.
 */

/**
 * The structural shape of fancy-canvas' `CanvasRenderingTarget2D`.
 *
 * Declared here rather than imported from `fancy-canvas` because that package
 * is a *transitive* dependency (lightweight-charts pulls it in) and importing
 * it directly would make `apps/web` depend on a package it never declared —
 * which works right up until a hoisting change removes it.
 */
interface BitmapScope {
  context: CanvasRenderingContext2D;
  bitmapSize: { width: number; height: number };
  mediaSize: { width: number; height: number };
  horizontalPixelRatio: number;
  verticalPixelRatio: number;
}
interface RenderTarget {
  useBitmapCoordinateSpace(fn: (scope: BitmapScope) => void): void;
}

type AnySeries = ISeriesApi<SeriesType>;

function readToken(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Resolve a direction to a live design token, so drawings re-theme with the
 * rest of the chart instead of carrying hardcoded hex.
 *
 * Note these are read at paint time, not cached: `TradeChart` already watches
 * `data-theme` and repaints, and a cached colour would survive a theme switch.
 */
function colorFor(direction: DrawingDirection): string {
  switch (direction) {
    case 'bullish':
      return readToken('--green') || '#16a34a';
    case 'bearish':
      return readToken('--red') || '#dc2626';
    default:
      return readToken('--muted') || '#888888';
  }
}

/**
 * Translucency is applied with `globalAlpha`, never by appending an alpha
 * channel to the token's value.
 *
 * The tokens are authored in several formats across themes, and string-editing
 * a colour you did not parse is how `bg-up/15` became a silent no-op elsewhere
 * in this repo (see `Patterns/2026-08-05 - Sentinel workspace premium
 * redesign`). `globalAlpha` is format-agnostic and cannot fail quietly.
 */
const ZONE_FILL_ALPHA = 0.14;
const ZONE_BORDER_ALPHA = 0.55;

class DrawingsPaneView {
  constructor(
    private readonly host: ChartDrawingsPrimitive,
    private readonly layer: 'zones' | 'lines',
  ) {}

  zOrder(): 'bottom' | 'normal' {
    return this.layer === 'zones' ? 'bottom' : 'normal';
  }

  renderer() {
    const drawings = this.host.currentDrawings();
    const view = this.host.viewport();
    if (!view || drawings.length === 0) return null;
    const layer = this.layer;

    return {
      draw(target: RenderTarget) {
        target.useBitmapCoordinateSpace((scope) => {
          const { context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr } = scope;
          ctx.save();

          for (const d of drawings) {
            if (layer === 'zones' && d.kind === 'zone') {
              const rect = resolveZoneRect(d, view);
              if (!rect) continue;
              const color = colorFor(d.direction);
              const x = rect.x1 * hr;
              const y = rect.y1 * vr;
              const w = (rect.x2 - rect.x1) * hr;
              const h = (rect.y2 - rect.y1) * vr;

              ctx.globalAlpha = ZONE_FILL_ALPHA;
              ctx.fillStyle = color;
              ctx.fillRect(x, y, w, h);

              // A 1px edge at a higher alpha: the fill alone is too faint to
              // locate the exact gap boundary, which is the number the trader
              // is actually reading off the zone.
              ctx.globalAlpha = ZONE_BORDER_ALPHA;
              ctx.strokeStyle = color;
              ctx.lineWidth = Math.max(1, Math.floor(hr));
              ctx.strokeRect(x, y, w, h);
            } else if (layer === 'lines' && d.kind === 'line') {
              const seg = resolveLineSegment(d, view);
              if (!seg) continue;
              ctx.globalAlpha = 1;
              ctx.strokeStyle = colorFor(d.direction);
              ctx.lineWidth = Math.max(1, Math.floor(1.5 * hr));
              ctx.setLineDash(d.dashed ? [4 * hr, 4 * hr] : []);
              ctx.beginPath();
              ctx.moveTo(seg.x1 * hr, seg.y1 * vr);
              ctx.lineTo(seg.x2 * hr, seg.y2 * vr);
              ctx.stroke();
              ctx.setLineDash([]);
            }
          }

          ctx.restore();
        });
      },
    };
  }
}

/**
 * Attach one of these per series. `setDrawings` is the only mutator; it
 * requests a redraw rather than painting, so the chart stays the single
 * scheduler of its own frames.
 */
export class ChartDrawingsPrimitive {
  private drawings: ChartDrawing[] = [];
  private chart: IChartApi | null = null;
  private series: AnySeries | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views = [new DrawingsPaneView(this, 'zones'), new DrawingsPaneView(this, 'lines')];

  attached(param: { chart: IChartApi; series: AnySeries; requestUpdate: () => void }): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews() {
    return this.views;
  }

  currentDrawings(): readonly ChartDrawing[] {
    return this.drawings;
  }

  setDrawings(next: readonly ChartDrawing[]): void {
    this.drawings = [...next];
    this.requestUpdate?.();
  }

  /**
   * Repaint without changing the data. Needed on a theme switch: colours are
   * resolved from tokens at paint time, so the drawings keep the old theme's
   * palette until something asks for a new frame.
   */
  requestRedraw(): void {
    this.requestUpdate?.();
  }

  /**
   * Build the converters the geometry needs, or null before the primitive is
   * attached. `timeToCoordinate` returns null for any time that is not a bar
   * in the loaded series — the geometry treats that as information (see
   * `resolveZoneRect`), so it is passed through rather than defaulted here.
   */
  viewport(): DrawingViewport | null {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return null;
    const timeScale = chart.timeScale();
    return {
      timeToX: (time: number) => timeScale.timeToCoordinate(time as Time) as number | null,
      priceToY: (price: number) => series.priceToCoordinate(price) as number | null,
      paneWidth: chart.paneSize().width,
    };
  }
}
