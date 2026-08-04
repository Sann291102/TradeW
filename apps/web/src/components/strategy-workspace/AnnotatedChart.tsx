'use client';

import { useMemo, useState } from 'react';
import type { ChartAnnotation, Pane, SerializedCandle } from '@/lib/strategy-workspace/types';

/**
 * Panel 1 — the live market chart with the AI's annotation layer drawn on it.
 *
 * Rendered as inline SVG rather than through a charting library. Three reasons:
 * the annotation geometry already arrives in chart coordinates so there is
 * nothing to adapt; every drawn element needs to be individually hoverable to
 * surface its explanation, which most libraries make awkward; and it keeps the
 * workspace free of a heavyweight client dependency for what is ultimately
 * lines and rectangles.
 *
 * Price and time scales are computed once over the candle range and shared by
 * the candles and every annotation, so a line the service anchored at 24 318
 * lands on the bar where price actually was 24 318.
 */

const PRICE_PANE_HEIGHT = 380;
const SUB_PANE_HEIGHT = 96;
const PADDING = { top: 12, right: 64, bottom: 22, left: 8 };

interface Props {
  candles: SerializedCandle[];
  annotations: ChartAnnotation[];
  panes: Pane[];
  symbol: string;
  timeframe: string;
  /** Annotation currently highlighted from the sibling panel. */
  focusedId: string | null;
  onFocus: (id: string | null) => void;
}

export function AnnotatedChart({ candles, annotations, panes, symbol, timeframe, focusedId, onFocus }: Props) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const subPanes = panes.filter((p): p is 'rsi' | 'macd' => p === 'rsi' || p === 'macd');
  const width = 900;
  const height = PRICE_PANE_HEIGHT + subPanes.length * SUB_PANE_HEIGHT;

  const scales = useMemo(() => buildScales(candles, annotations, width, subPanes), [candles, annotations, width, subPanes.join()]);

  if (candles.length === 0) {
    return (
      <div className="flex h-[380px] items-center justify-center rounded-lg border border-border bg-surface">
        <p className="max-w-sm text-center text-[12px] leading-relaxed text-muted">
          No candles were returned for {symbol} on the {timeframe} timeframe. Nothing is drawn rather than showing a
          chart built from placeholder bars.
        </p>
      </div>
    );
  }

  const visible = annotations.filter((a) => !hidden.has(a.kind));
  // Array.from rather than spreading the Set: apps/web's tsconfig target does
  // not enable downlevelIteration, so `[...new Set()]` does not compile here.
  const kinds = Array.from(new Set(annotations.map((a) => a.kind)));

  const toggleKind = (kind: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div>
          <span className="text-[13px] font-semibold text-text">{symbol}</span>
          <span className="ml-2 text-[11px] text-muted">{timeframe}</span>
          <span className="ml-2 text-[11px] text-faint">{candles.length} bars</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => toggleKind(kind)}
              className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                hidden.has(kind)
                  ? 'border-border text-faint line-through'
                  : 'border-border text-muted hover:text-text'
              }`}
              title={hidden.has(kind) ? `Show ${kind}` : `Hide ${kind}`}
            >
              {kind.replace(/-/g, ' ')}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full min-w-[720px]"
          role="img"
          aria-label={`${symbol} ${timeframe} chart with ${visible.length} AI annotations`}
        >
          <PriceGrid scales={scales} width={width} />

          {/* Zones sit beneath the candles so price stays readable through them. */}
          {visible
            .filter((a) => a.pane === 'price' && a.band)
            .map((annotation) => (
              <ZoneBand
                key={annotation.id}
                annotation={annotation}
                scales={scales}
                width={width}
                focused={focusedId === annotation.id}
                onFocus={onFocus}
              />
            ))}

          <Candles candles={candles} scales={scales} />

          {visible
            .filter((a) => a.pane === 'price' && !a.band)
            .map((annotation) => (
              <AnnotationPath
                key={annotation.id}
                annotation={annotation}
                scales={scales}
                width={width}
                focused={focusedId === annotation.id}
                onFocus={onFocus}
              />
            ))}

          {subPanes.map((pane, i) => (
            <SubPane
              key={pane}
              pane={pane}
              index={i}
              width={width}
              scales={scales}
              annotations={visible.filter((a) => a.pane === pane)}
              focusedId={focusedId}
              onFocus={onFocus}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

interface Scales {
  x: (time: number) => number;
  y: (price: number) => number;
  /** Per-sub-pane value scale, keyed by pane name. */
  sub: Record<string, { y: (value: number) => number; min: number; max: number; top: number }>;
  minPrice: number;
  maxPrice: number;
  minTime: number;
  maxTime: number;
  barWidth: number;
  priceTicks: number[];
}

/**
 * Build shared scales.
 *
 * The price domain includes annotation geometry, not just the candles: a
 * projected objective or a level above the visible range would otherwise be
 * clipped off the top of the chart, and an annotation the user cannot see is
 * indistinguishable from one that was never drawn.
 */
function buildScales(
  candles: SerializedCandle[],
  annotations: ChartAnnotation[],
  width: number,
  subPanes: ('rsi' | 'macd')[],
): Scales {
  const times = candles.map((c) => c.time);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);

  const pricePoints = [
    ...candles.flatMap((c) => [c.high, c.low]),
    ...annotations
      .filter((a) => a.pane === 'price')
      .flatMap((a) => [
        ...a.points.map((p) => p.price),
        ...(a.band ? [a.band.top, a.band.bottom] : []),
        ...a.levels.map((l) => l.price),
      ]),
  ].filter((v) => Number.isFinite(v));

  const rawMin = Math.min(...pricePoints);
  const rawMax = Math.max(...pricePoints);
  const pad = (rawMax - rawMin) * 0.04 || 1;
  const minPrice = rawMin - pad;
  const maxPrice = rawMax + pad;

  const plotWidth = width - PADDING.left - PADDING.right;
  const plotHeight = PRICE_PANE_HEIGHT - PADDING.top - PADDING.bottom;
  const timeSpan = maxTime - minTime || 1;

  const x = (time: number) => PADDING.left + ((time - minTime) / timeSpan) * plotWidth;
  const y = (price: number) =>
    PADDING.top + plotHeight - ((price - minPrice) / (maxPrice - minPrice || 1)) * plotHeight;

  const sub: Scales['sub'] = {};
  subPanes.forEach((pane, i) => {
    const top = PRICE_PANE_HEIGHT + i * SUB_PANE_HEIGHT;
    const values = annotations
      .filter((a) => a.pane === pane)
      .flatMap((a) => a.points.map((p) => p.price))
      .filter((v) => Number.isFinite(v));
    // RSI has a fixed, meaningful 0–100 domain; MACD's is data-dependent and
    // symmetric around zero so the histogram reads correctly either side.
    const min = pane === 'rsi' ? 0 : Math.min(0, ...values);
    const max = pane === 'rsi' ? 100 : Math.max(0, ...values);
    const inner = SUB_PANE_HEIGHT - 16;
    sub[pane] = {
      top,
      min,
      max,
      y: (value: number) => top + 8 + inner - ((value - min) / (max - min || 1)) * inner,
    };
  });

  return {
    x,
    y,
    sub,
    minPrice,
    maxPrice,
    minTime,
    maxTime,
    barWidth: Math.max(1.5, (plotWidth / Math.max(1, candles.length)) * 0.62),
    priceTicks: ticksFor(minPrice, maxPrice, 6),
  };
}

function ticksFor(min: number, max: number, count: number): number[] {
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, i) => min + step * i);
}

// ---------------------------------------------------------------------------
// Chart primitives
// ---------------------------------------------------------------------------

function PriceGrid({ scales, width }: { scales: Scales; width: number }) {
  return (
    <g>
      {scales.priceTicks.map((price) => (
        <g key={price}>
          <line
            x1={PADDING.left}
            x2={width - PADDING.right}
            y1={scales.y(price)}
            y2={scales.y(price)}
            stroke="currentColor"
            className="text-border"
            strokeWidth={0.5}
            opacity={0.5}
          />
          <text
            x={width - PADDING.right + 6}
            y={scales.y(price) + 3}
            className="fill-current text-faint"
            fontSize={9}
          >
            {price.toFixed(price > 1000 ? 0 : 2)}
          </text>
        </g>
      ))}
    </g>
  );
}

function Candles({ candles, scales }: { candles: SerializedCandle[]; scales: Scales }) {
  return (
    <g>
      {candles.map((candle) => {
        const up = candle.close >= candle.open;
        const colour = up ? '#16a34a' : '#dc2626';
        const cx = scales.x(candle.time);
        const bodyTop = scales.y(Math.max(candle.open, candle.close));
        const bodyBottom = scales.y(Math.min(candle.open, candle.close));
        return (
          <g key={candle.time}>
            <line x1={cx} x2={cx} y1={scales.y(candle.high)} y2={scales.y(candle.low)} stroke={colour} strokeWidth={0.75} />
            <rect
              x={cx - scales.barWidth / 2}
              y={bodyTop}
              width={scales.barWidth}
              // A doji has zero body height and would render as nothing at all.
              height={Math.max(0.75, bodyBottom - bodyTop)}
              fill={colour}
            />
          </g>
        );
      })}
    </g>
  );
}

function ZoneBand({
  annotation,
  scales,
  width,
  focused,
  onFocus,
}: {
  annotation: ChartAnnotation;
  scales: Scales;
  width: number;
  focused: boolean;
  onFocus: (id: string | null) => void;
}) {
  if (!annotation.band) return null;
  const top = scales.y(annotation.band.top);
  const bottom = scales.y(annotation.band.bottom);
  const startX = annotation.points[0] ? scales.x(annotation.points[0].time) : PADDING.left;

  return (
    <g
      onMouseEnter={() => onFocus(annotation.id)}
      onMouseLeave={() => onFocus(null)}
      className="cursor-pointer"
    >
      <rect
        x={startX}
        y={Math.min(top, bottom)}
        width={Math.max(2, width - PADDING.right - startX)}
        height={Math.max(1, Math.abs(bottom - top))}
        fill={annotation.style.color}
        opacity={focused ? Math.min(1, annotation.style.opacity * 2.2) : annotation.style.opacity}
      />
      <text x={startX + 4} y={Math.min(top, bottom) + 10} fontSize={9} fill={annotation.style.color}>
        {annotation.label}
      </text>
      <title>{`${annotation.label} — ${annotation.explanation}`}</title>
    </g>
  );
}

function AnnotationPath({
  annotation,
  scales,
  width,
  focused,
  onFocus,
}: {
  annotation: ChartAnnotation;
  scales: Scales;
  width: number;
  focused: boolean;
  onFocus: (id: string | null) => void;
}) {
  const dash =
    annotation.style.dash === 'dashed' ? '6 4' : annotation.style.dash === 'dotted' ? '2 3' : undefined;
  const strokeWidth = focused ? annotation.style.width + 1.5 : annotation.style.width;

  // Fibonacci arrives as a stack of levels sharing one timestamp, so it is
  // drawn as horizontal rules rather than as a polyline through them — a
  // polyline would render as a single vertical line at that instant.
  if (annotation.kind === 'fibonacci') {
    return (
      <g onMouseEnter={() => onFocus(annotation.id)} onMouseLeave={() => onFocus(null)} className="cursor-pointer">
        {annotation.points.map((point, i) => (
          <line
            key={i}
            x1={PADDING.left}
            x2={width - PADDING.right}
            y1={scales.y(point.price)}
            y2={scales.y(point.price)}
            stroke={annotation.style.color}
            strokeWidth={strokeWidth}
            strokeDasharray={dash}
            opacity={focused ? 1 : annotation.style.opacity}
          />
        ))}
        <title>{`${annotation.label} — ${annotation.explanation}`}</title>
      </g>
    );
  }

  // A single point describes a horizontal level that extends across the chart.
  const path =
    annotation.points.length === 1
      ? `M ${PADDING.left} ${scales.y(annotation.points[0].price)} L ${width - PADDING.right} ${scales.y(annotation.points[0].price)}`
      : annotation.points
          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${scales.x(p.time)} ${scales.y(p.price)}`)
          .join(' ');

  const last = annotation.points[annotation.points.length - 1];

  return (
    <g onMouseEnter={() => onFocus(annotation.id)} onMouseLeave={() => onFocus(null)} className="cursor-pointer">
      <path
        d={path}
        fill="none"
        stroke={annotation.style.color}
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
        opacity={focused ? 1 : annotation.style.opacity}
      />
      {/* An invisible fat stroke gives the thin line a usable hover target. */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={10} />
      {last && (
        <text x={width - PADDING.right + 6} y={scales.y(last.price) + 3} fontSize={9} fill={annotation.style.color}>
          {annotation.kind === 'ema' || annotation.kind === 'vwap' ? annotation.label : ''}
        </text>
      )}
      <title>{`${annotation.label} — ${annotation.explanation}`}</title>
    </g>
  );
}

function SubPane({
  pane,
  index,
  width,
  scales,
  annotations,
  focusedId,
  onFocus,
}: {
  pane: 'rsi' | 'macd';
  index: number;
  width: number;
  scales: Scales;
  annotations: ChartAnnotation[];
  focusedId: string | null;
  onFocus: (id: string | null) => void;
}) {
  const scale = scales.sub[pane];
  if (!scale) return null;
  const top = PRICE_PANE_HEIGHT + index * SUB_PANE_HEIGHT;

  return (
    <g>
      <line
        x1={PADDING.left}
        x2={width - PADDING.right}
        y1={top}
        y2={top}
        stroke="currentColor"
        className="text-border"
        strokeWidth={0.5}
      />
      <text x={PADDING.left + 2} y={top + 12} fontSize={9} className="fill-current text-faint">
        {pane.toUpperCase()}
      </text>

      {/* RSI's 30/70 bands are the reference the reading is judged against. */}
      {pane === 'rsi' &&
        [30, 70].map((level) => (
          <line
            key={level}
            x1={PADDING.left}
            x2={width - PADDING.right}
            y1={scale.y(level)}
            y2={scale.y(level)}
            stroke="currentColor"
            className="text-border"
            strokeWidth={0.5}
            strokeDasharray="3 3"
          />
        ))}
      {pane === 'macd' && (
        <line
          x1={PADDING.left}
          x2={width - PADDING.right}
          y1={scale.y(0)}
          y2={scale.y(0)}
          stroke="currentColor"
          className="text-border"
          strokeWidth={0.5}
        />
      )}

      {annotations.map((annotation) => (
        <g
          key={annotation.id}
          onMouseEnter={() => onFocus(annotation.id)}
          onMouseLeave={() => onFocus(null)}
          className="cursor-pointer"
        >
          <path
            d={annotation.points
              .map((p, i) => `${i === 0 ? 'M' : 'L'} ${scales.x(p.time)} ${scale.y(p.price)}`)
              .join(' ')}
            fill="none"
            stroke={annotation.style.color}
            strokeWidth={focusedId === annotation.id ? annotation.style.width + 1 : annotation.style.width}
          />
          <title>{`${annotation.label} — ${annotation.explanation}`}</title>
        </g>
      ))}
    </g>
  );
}
