import { describe, expect, it } from 'vitest';
import {
  clearDrawingsByTag,
  drawingsWithTag,
  normalizeZone,
  replaceDrawingsByTag,
  resolveLineSegment,
  resolveZoneRect,
  type ChartDrawing,
  type DrawingViewport,
  type LineDrawing,
  type ZoneDrawing,
} from './drawings';

/**
 * The geometry is asserted rather than eyeballed because every failure mode
 * here produces a *plausible* picture. A zone clamped to the wrong edge, a
 * trendline whose extension quietly changed slope, an off-screen rectangle
 * painted at x=0 — all of them render as a confident annotation stating a
 * price level that was never detected. On a chart a trader reads before
 * risking money, "looks about right" is not a check.
 */

const PANE_WIDTH = 1000;

/** A viewport with 1 bar = 10px starting at t=100, and price 100 at y=0
 *  falling 1px per unit (so higher price = smaller y, as on a real chart). */
function view(overrides: Partial<DrawingViewport> = {}): DrawingViewport {
  return {
    timeToX: (t) => (t >= 100 && t <= 200 ? (t - 100) * 10 : null),
    priceToY: (p) => (p >= 0 && p <= 100 ? 100 - p : null),
    paneWidth: PANE_WIDTH,
    ...overrides,
  };
}

function zone(over: Partial<ZoneDrawing> = {}): ZoneDrawing {
  return {
    kind: 'zone',
    id: 'z1',
    tag: 'fvg',
    direction: 'bullish',
    top: 60,
    bottom: 40,
    startTime: 110,
    endTime: 150,
    ...over,
  };
}

function line(over: Partial<LineDrawing> = {}): LineDrawing {
  return {
    kind: 'line',
    id: 'l1',
    tag: 'trendline',
    direction: 'neutral',
    from: { time: 110, price: 40 },
    to: { time: 130, price: 60 },
    ...over,
  };
}

describe('tag-scoped edits', () => {
  const mixed: ChartDrawing[] = [zone({ id: 'a', tag: 'fvg' }), line({ id: 'b', tag: 'trendline' }), zone({ id: 'c', tag: 'fvg' })];

  it('clears only the named tag', () => {
    expect(clearDrawingsByTag(mixed, 'fvg').map((d) => d.id)).toEqual(['b']);
  });

  it('selects only the named tag', () => {
    expect(drawingsWithTag(mixed, 'fvg').map((d) => d.id)).toEqual(['a', 'c']);
  });

  it('replaces a tag wholesale, leaving a hand-drawn trendline untouched', () => {
    const next = replaceDrawingsByTag(mixed, 'fvg', [zone({ id: 'd', tag: 'fvg' })]);
    expect(next.map((d) => d.id)).toEqual(['b', 'd']);
  });

  it('drops a zone that was mitigated since the last detection run', () => {
    // The reason replace is not a merge: 'a' and 'c' must be able to vanish.
    expect(replaceDrawingsByTag(mixed, 'fvg', [])).toHaveLength(1);
  });

  it('refuses replacements carrying a foreign tag', () => {
    expect(() => replaceDrawingsByTag(mixed, 'fvg', [zone({ tag: 'user' })])).toThrow(/must carry tag/);
  });
});

describe('normalizeZone', () => {
  it('swaps inverted bounds so height is never negative', () => {
    const n = normalizeZone(zone({ top: 40, bottom: 60 }));
    expect(n.top).toBe(60);
    expect(n.bottom).toBe(40);
  });

  it('leaves a well-formed zone identical', () => {
    const z = zone();
    expect(normalizeZone(z)).toBe(z);
  });
});

describe('resolveZoneRect', () => {
  it('places a fully visible zone', () => {
    expect(resolveZoneRect(zone(), view())).toEqual({ x1: 100, y1: 40, x2: 500, y2: 60 });
  });

  it('extends an open zone (endTime null) to the right edge', () => {
    const r = resolveZoneRect(zone({ endTime: null }), view());
    expect(r?.x2).toBe(PANE_WIDTH);
  });

  it('extends to the right edge when endTime is not a bar in this series', () => {
    // A 15m zone shown on a 1D chart. Collapsing it to a sliver would read as
    // "detection found nothing" rather than "this bound is off this series".
    const r = resolveZoneRect(zone({ endTime: 9_999 }), view());
    expect(r?.x2).toBe(PANE_WIDTH);
  });

  it('clips to the left edge when the start has scrolled out of the series', () => {
    const r = resolveZoneRect(zone({ startTime: 1 }), view());
    expect(r?.x1).toBe(0);
  });

  it('refuses to draw when a price bound is off the scale', () => {
    // Fatal, unlike a missing time: the band would state a level nobody found.
    expect(resolveZoneRect(zone({ top: 500 }), view())).toBeNull();
    expect(resolveZoneRect(zone({ bottom: -5 }), view())).toBeNull();
  });

  it('skips a zone entirely to the left of the pane', () => {
    const shifted = view({ timeToX: (t) => (t - 100) * 10 - 600 });
    expect(resolveZoneRect(zone(), shifted)).toBeNull();
  });

  it('skips a zone entirely to the right of the pane', () => {
    const shifted = view({ timeToX: (t) => (t - 100) * 10 + 1200 });
    expect(resolveZoneRect(zone(), shifted)).toBeNull();
  });

  it('normalizes inverted bounds before placing them', () => {
    expect(resolveZoneRect(zone({ top: 40, bottom: 60 }), view())).toEqual(
      resolveZoneRect(zone({ top: 60, bottom: 40 }), view()),
    );
  });
});

describe('resolveLineSegment', () => {
  it('places a two-point segment', () => {
    expect(resolveLineSegment(line(), view())).toEqual({ x1: 100, y1: 60, x2: 300, y2: 40 });
  });

  it('refuses to draw when either endpoint is unplaceable', () => {
    // Stricter than a zone on purpose — clamping an endpoint would change the
    // slope, and a trendline's whole claim is its slope.
    expect(resolveLineSegment(line({ from: { time: 1, price: 40 } }), view())).toBeNull();
    expect(resolveLineSegment(line({ to: { time: 130, price: 900 } }), view())).toBeNull();
  });

  it('extends right along the real slope, not toward a guessed price', () => {
    // Slope is -0.1 y per x (price rising). From x=300,y=40 to x=1000 that is
    // 700 * -0.1 = -70, so y=-30. The extension must follow the measured line.
    const r = resolveLineSegment(line({ extendRight: true }), view());
    expect(r).toEqual({ x1: 100, y1: 60, x2: 1000, y2: -30 });
  });

  it('does not extend a segment that already reaches past the right edge', () => {
    const wide = view({ timeToX: (t) => (t - 100) * 60 });
    const r = resolveLineSegment(line({ extendRight: true }), wide);
    expect(r?.x2).toBe(1800);
  });
});
