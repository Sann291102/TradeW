'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DOMAIN_COLOR,
  EDGE_STATE_COLOR,
  domainColor,
  nodeColor,
  type GraphEdgeDto,
  type GraphEvent,
  type GraphNodeDto,
  type GraphSlice,
} from '@/lib/graph';
import {
  Camera,
  GraphLayout,
  LAYER_COLUMNS,
  MAX_ZOOM,
  MIN_ZOOM,
  cameraSettled,
  easeCamera,
  fitCamera,
  focusCamera,
  screenToWorld,
  tierForZoom,
} from '@/lib/graphLayout';

/**
 * The investigative graph canvas — one renderer, two projections.
 *
 * ## Why canvas and not SVG
 *
 * The previous knowledge graph was SVG with a hundred and fifty nodes and it
 * was already the slowest thing on the page: every node is a DOM subtree, and
 * a force simulation writes to all of them sixty times a second. This canvas
 * draws nine hundred nodes and several thousand edges in one pass with no DOM
 * churn at all. Hit-testing moves into `GraphLayout` (which already knows
 * where everything is) rather than being the browser's job.
 *
 * ## Everything drawn means something
 *
 * The visual contract is published by `GET /admin/graph/meta` and this file is
 * its only implementation. Nothing here picks a colour, a width or an
 * animation for looks:
 *
 *   radius       ← importance          halo        ← activity
 *   fill tone    ← status              rim glyphs  ← real counters
 *   opacity      ← confidence          edge width  ← strength
 *   dashes       ← weak confidence     arrowhead   ← directed relation
 *   edge colour  ← contradiction / warning state
 *   pulse        ← a real backend event, never a timer
 *
 * If a renderer wants to say something new it gets a data field first.
 *
 * ## Progressive disclosure
 *
 * Labels and node visibility are gated on the camera's semantic-zoom tier, so
 * the far view is domains and hubs, and evidence-level detail only appears
 * once someone has zoomed in far enough to read it. Selection and hover always
 * override the gate: what the operator is pointing at is always labelled.
 */

export interface GraphCanvasHandle {
  fit: () => void;
  reset: () => void;
  focus: (id: string) => void;
}

interface Props {
  slice: GraphSlice | null;
  mode: 'force' | 'layered';
  /** Ids the operator has selected. Multi-select is a set, not a single id. */
  selected: string[];
  onSelectionChange: (ids: string[]) => void;
  /** Double-click / expand button — load this node's neighbours. */
  onExpand: (id: string) => void;
  /** Alt-click — drop everything only reachable through this node. */
  onCollapse: (id: string) => void;
  /** Live events; each drives one pulse along its real nodes and edges. */
  events: GraphEvent[];
  /** Node ids with un-loaded neighbours, for the "+" expansion glyph. */
  truncated: string[];
  /** Set by the page's search box; the camera glides to it. */
  focusId: string | null;
  /** Paused: freeze pulses. The simulation keeps its slow drift so the canvas
   *  does not look broken, but nothing new lights up. */
  paused: boolean;
  className?: string;
  onReady?: (handle: GraphCanvasHandle) => void;
}

/** World size the layout targets. The camera maps this onto any viewport. */
const WORLD = { width: 2_400, height: 1_500 };

/** How long a pulse takes to travel one edge, and how long a node flash lasts. */
const PULSE_MS = 1_400;
const FLASH_MS = 1_800;

/** Ceiling on concurrent pulses. A burst of traffic must not become a burst of
 *  animation work — beyond this the oldest are dropped, which is invisible
 *  because they were about to expire anyway. */
const MAX_PULSES = 160;

interface Pulse {
  id: string;
  edgeId?: string;
  nodeId?: string;
  start: number;
  intensity: number;
  error: boolean;
}

export function GraphCanvas({
  slice,
  mode,
  selected,
  onSelectionChange,
  onExpand,
  onCollapse,
  events,
  truncated,
  focusId,
  paused,
  className = '',
  onReady,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const layoutRef = useRef(new GraphLayout({ mode, width: WORLD.width, height: WORLD.height }));
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 0.55 });
  const targetCameraRef = useRef<Camera | null>(null);
  const viewportRef = useRef({ width: 800, height: 520 });

  const pulsesRef = useRef<Pulse[]>([]);
  const consumedRef = useRef(new Set<string>());
  const nodeFlashRef = useRef(new Map<string, { at: number; error: boolean }>());

  const [hovered, setHovered] = useState<string | null>(null);
  const [tier, setTier] = useState<0 | 1 | 2>(1);
  const [isFullscreen, setFullscreen] = useState(false);

  // Interaction state lives in refs: it changes every mousemove, and putting it
  // in state would re-render React sixty times a second for a canvas that does
  // not need React to redraw at all.
  const dragRef = useRef<{ kind: 'node' | 'pan' | 'band'; id?: string; startX: number; startY: number; moved: boolean } | null>(null);
  const bandRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // Latest props, read by the animation loop without re-subscribing it.
  const stateRef = useRef({ slice, selected, hovered, tier, truncated, paused });
  stateRef.current = { slice, selected, hovered, tier, truncated, paused };

  const nodeIndex = useMemo(() => {
    const map = new Map<string, GraphNodeDto>();
    for (const node of slice?.nodes ?? []) map.set(node.id, node);
    return map;
  }, [slice]);

  const edgeIndex = useMemo(() => {
    const map = new Map<string, GraphEdgeDto>();
    for (const edge of slice?.edges ?? []) map.set(edge.id, edge);
    return map;
  }, [slice]);

  /** node id → neighbour ids, for hover focus and collapse. */
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of slice?.edges ?? []) {
      if (!map.has(edge.source)) map.set(edge.source, new Set());
      if (!map.has(edge.target)) map.set(edge.target, new Set());
      map.get(edge.source)!.add(edge.target);
      map.get(edge.target)!.add(edge.source);
    }
    return map;
  }, [slice]);

  // ----------------------------------------------------------------- layout

  useEffect(() => {
    layoutRef.current.setOptions({ mode });
  }, [mode]);

  useEffect(() => {
    if (!slice) return;
    layoutRef.current.sync(slice.nodes, slice.edges);
  }, [slice]);

  // ------------------------------------------------------------- live pulses

  useEffect(() => {
    if (paused) return;
    const now = Date.now();
    for (const event of events) {
      if (consumedRef.current.has(event.id)) continue;
      consumedRef.current.add(event.id);
      // Only pulse what is actually on screen. An event about a node the
      // operator has filtered out is real, but drawing it would mean drawing
      // a pulse with no visible source.
      for (const edgeId of event.edgeIds) {
        if (!edgeIndex.has(edgeId)) continue;
        pulsesRef.current.push({ id: `${event.id}:${edgeId}`, edgeId, start: now, intensity: event.intensity, error: event.status === 'error' });
      }
      for (const nodeId of event.nodeIds) {
        if (!nodeIndex.has(nodeId)) continue;
        nodeFlashRef.current.set(nodeId, { at: now, error: event.status === 'error' });
      }
    }
    if (pulsesRef.current.length > MAX_PULSES) {
      pulsesRef.current.splice(0, pulsesRef.current.length - MAX_PULSES);
    }
    // The consumed set is unbounded otherwise; a long-lived console would hold
    // every event id it ever saw.
    if (consumedRef.current.size > 4_000) consumedRef.current = new Set();
  }, [events, paused, edgeIndex, nodeIndex]);

  // ------------------------------------------------------------ camera moves

  const viewport = () => viewportRef.current;

  const fit = useCallback(() => {
    const bounds = layoutRef.current.bounds();
    if (!bounds) return;
    targetCameraRef.current = fitCamera(bounds, viewport());
  }, []);

  const reset = useCallback(() => {
    for (const node of Array.from(layoutRef.current.nodes.values())) node.pinned = false;
    layoutRef.current.reheat(0.9);
    targetCameraRef.current = fitCamera(
      { minX: 0, minY: 0, maxX: WORLD.width, maxY: WORLD.height },
      viewport(),
    );
  }, []);

  const focus = useCallback((id: string) => {
    const node = layoutRef.current.nodes.get(id);
    if (!node) return;
    // Zoom in far enough to cross into the detail tier: focusing on something
    // and not being able to read its label is not focusing on it.
    targetCameraRef.current = focusCamera(node.x, node.y, viewport(), Math.max(cameraRef.current.zoom, 1.25));
  }, []);

  useEffect(() => {
    onReady?.({ fit, reset, focus });
  }, [onReady, fit, reset, focus]);

  useEffect(() => {
    if (focusId) focus(focusId);
  }, [focusId, focus]);

  // First paint: fit once the layout has had a few frames to spread out.
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || !slice || slice.nodes.length === 0) return;
    fittedRef.current = true;
    const timer = setTimeout(fit, 420);
    return () => clearTimeout(timer);
  }, [slice, fit]);

  // ------------------------------------------------------------ the RAF loop

  useEffect(() => {
    let frame = 0;
    let running = true;

    const draw = () => {
      if (!running) return;
      frame = requestAnimationFrame(draw);

      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;

      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }
      viewportRef.current = { width: rect.width, height: rect.height };

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      layoutRef.current.step();

      if (targetCameraRef.current) {
        cameraRef.current = easeCamera(cameraRef.current, targetCameraRef.current);
        if (cameraSettled(cameraRef.current, targetCameraRef.current)) {
          cameraRef.current = targetCameraRef.current;
          targetCameraRef.current = null;
        }
      }

      const nextTier = tierForZoom(cameraRef.current.zoom);
      if (nextTier !== stateRef.current.tier) setTier(nextTier);

      render(ctx, {
        camera: cameraRef.current,
        viewport: viewportRef.current,
        layout: layoutRef.current,
        nodes: nodeIndex,
        edges: edgeIndex,
        neighbours,
        selected: new Set(stateRef.current.selected),
        hovered: stateRef.current.hovered,
        tier: nextTier,
        truncated: new Set(stateRef.current.truncated),
        pulses: pulsesRef.current,
        flashes: nodeFlashRef.current,
        band: bandRef.current,
        mode,
        clusters: stateRef.current.slice?.clusters ?? [],
      });

      // Expire finished animations. Done here rather than on a timer so it
      // costs nothing when the tab is backgrounded and RAF stops firing.
      const now = Date.now();
      if (pulsesRef.current.length) {
        pulsesRef.current = pulsesRef.current.filter((pulse) => now - pulse.start < PULSE_MS);
      }
      if (nodeFlashRef.current.size) {
        for (const [id, flash] of Array.from(nodeFlashRef.current.entries())) {
          if (now - flash.at > FLASH_MS) nodeFlashRef.current.delete(id);
        }
      }
    };

    frame = requestAnimationFrame(draw);
    return () => {
      running = false;
      cancelAnimationFrame(frame);
    };
  }, [nodeIndex, edgeIndex, neighbours, mode]);

  // ------------------------------------------------------------- interaction

  const pointerWorld = (event: { clientX: number; clientY: number }) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return screenToWorld(cameraRef.current, event.clientX - rect.left, event.clientY - rect.top);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    (event.target as Element).setPointerCapture?.(event.pointerId);
    const world = pointerWorld(event);
    const hit = layoutRef.current.hitTest(world.x, world.y);

    if (hit) {
      dragRef.current = { kind: 'node', id: hit, startX: event.clientX, startY: event.clientY, moved: false };
      return;
    }
    // Shift on empty space is a rubber-band selection; plain drag is a pan.
    if (event.shiftKey) {
      bandRef.current = { x1: world.x, y1: world.y, x2: world.x, y2: world.y };
      dragRef.current = { kind: 'band', startX: event.clientX, startY: event.clientY, moved: false };
      return;
    }
    dragRef.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const world = pointerWorld(event);

    if (!drag) {
      const hit = layoutRef.current.hitTest(world.x, world.y);
      if (hit !== hovered) setHovered(hit);
      return;
    }

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;

    if (drag.kind === 'node' && drag.id) {
      layoutRef.current.pin(drag.id, world.x, world.y);
      // A dragged node disturbs its neighbourhood, and a frozen simulation
      // would leave the neighbours where they were as if nothing had moved.
      layoutRef.current.reheat(0.35);
      return;
    }
    if (drag.kind === 'pan') {
      // Cancel any in-flight glide: the operator is steering now.
      targetCameraRef.current = null;
      cameraRef.current = {
        ...cameraRef.current,
        x: cameraRef.current.x - dx / cameraRef.current.zoom,
        y: cameraRef.current.y - dy / cameraRef.current.zoom,
      };
      drag.startX = event.clientX;
      drag.startY = event.clientY;
      return;
    }
    if (drag.kind === 'band' && bandRef.current) {
      bandRef.current = { ...bandRef.current, x2: world.x, y2: world.y };
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;

    if (drag.kind === 'band' && bandRef.current) {
      const band = bandRef.current;
      bandRef.current = null;
      const ids = layoutRef.current.within(band.x1, band.y1, band.x2, band.y2);
      onSelectionChange(ids);
      return;
    }

    if (drag.kind === 'node' && drag.id) {
      if (drag.moved) {
        // A dragged node stays where it was put — that is the point of dragging
        // it. Reset (or a second drag) releases it.
        return;
      }
      if (event.altKey) {
        onCollapse(drag.id);
        return;
      }
      const additive = event.metaKey || event.ctrlKey || event.shiftKey;
      if (additive) {
        const next = selected.includes(drag.id) ? selected.filter((id) => id !== drag.id) : [...selected, drag.id];
        onSelectionChange(next);
      } else {
        onSelectionChange(selected.length === 1 && selected[0] === drag.id ? [] : [drag.id]);
      }
      return;
    }

    // A click on empty space with no drag clears the selection.
    if (drag.kind === 'pan' && !drag.moved) onSelectionChange([]);
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const world = pointerWorld(event);
    const hit = layoutRef.current.hitTest(world.x, world.y);
    if (hit) onExpand(hit);
  };

  /**
   * Wheel zoom, anchored at the cursor.
   *
   * Anchoring matters: zooming toward the viewport centre means the thing the
   * operator is pointing at slides away as they zoom in, and they end up
   * chasing it with the pan.
   */
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const before = screenToWorld(cameraRef.current, screenX, screenY);
    const factor = Math.exp(-event.deltaY * 0.0016);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cameraRef.current.zoom * factor));
    const camera = { ...cameraRef.current, zoom };
    const after = screenToWorld(camera, screenX, screenY);
    targetCameraRef.current = null;
    cameraRef.current = { zoom, x: camera.x + (before.x - after.x), y: camera.y + (before.y - after.y) };
  };

  // ---- pinch zoom --------------------------------------------------------
  // Two-finger pinch on a trackpad arrives as a wheel event with ctrlKey (and
  // the handler above already scales it correctly). On a touch screen it
  // arrives as two touch points, which needs its own handling.
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);

  const onTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 2) return;
    const [a, b] = [event.touches[0], event.touches[1]];
    pinchRef.current = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: cameraRef.current.zoom };
  };

  const onTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 2 || !pinchRef.current) return;
    const [a, b] = [event.touches[0], event.touches[1]];
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || pinchRef.current.distance === 0) return;
    const midX = (a.clientX + b.clientX) / 2 - rect.left;
    const midY = (a.clientY + b.clientY) / 2 - rect.top;
    const before = screenToWorld(cameraRef.current, midX, midY);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchRef.current.zoom * (distance / pinchRef.current.distance)));
    const camera = { ...cameraRef.current, zoom };
    const after = screenToWorld(camera, midX, midY);
    targetCameraRef.current = null;
    cameraRef.current = { zoom, x: camera.x + (before.x - after.x), y: camera.y + (before.y - after.y) };
  };

  const onTouchEnd = () => {
    pinchRef.current = null;
  };

  // ---- fullscreen --------------------------------------------------------

  const toggleFullscreen = useCallback(() => {
    const wrap = wrapRef.current?.parentElement;
    if (!wrap) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.requestFullscreen?.();
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const hoveredNode = hovered ? nodeIndex.get(hovered) : null;

  return (
    <div className={`relative h-full w-full bg-[#0b1220] ${className}`}>
      <div
        ref={wrapRef}
        className="h-full w-full touch-none"
        style={{ cursor: hovered ? 'pointer' : 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          dragRef.current = null;
          bandRef.current = null;
          setHovered(null);
        }}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>

      {/* Camera controls. Kept as real buttons over the canvas rather than
          canvas-drawn, so they are focusable and keyboard-reachable. */}
      <div className="pointer-events-none absolute right-2 top-2 flex flex-col gap-1">
        <CanvasButton title="Fit graph" onClick={fit}>⤢</CanvasButton>
        <CanvasButton title="Reset camera and unpin every node" onClick={reset}>⟳</CanvasButton>
        <CanvasButton title="Zoom in" onClick={() => { targetCameraRef.current = { ...cameraRef.current, zoom: Math.min(MAX_ZOOM, cameraRef.current.zoom * 1.4) }; }}>+</CanvasButton>
        <CanvasButton title="Zoom out" onClick={() => { targetCameraRef.current = { ...cameraRef.current, zoom: Math.max(MIN_ZOOM, cameraRef.current.zoom / 1.4) }; }}>−</CanvasButton>
        <CanvasButton title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}>{isFullscreen ? '⤡' : '⛶'}</CanvasButton>
      </div>

      {/* Semantic-zoom readout — tells the operator WHY detail is missing. */}
      <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-2 rounded-md border border-white/10 bg-black/50 px-2 py-1 text-[10px] text-[#8ea0c4] backdrop-blur">
        <span>zoom {cameraRef.current.zoom.toFixed(2)}×</span>
        <span className="text-white/20">·</span>
        <span>{tier === 0 ? 'domains & hubs' : tier === 1 ? 'services, agents, concepts' : 'full detail'}</span>
        {mode === 'layered' && <><span className="text-white/20">·</span><span>signal columns</span></>}
      </div>

      {hoveredNode && <HoverCard node={hoveredNode} />}
    </div>
  );
}

function CanvasButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="pointer-events-auto h-7 w-7 rounded-md border border-white/10 bg-black/50 text-[13px] leading-none text-[#8ea0c4] backdrop-blur transition-colors hover:border-white/25 hover:text-white"
    >
      {children}
    </button>
  );
}

/**
 * Hover inspection.
 *
 * Deliberately a summary, not the inspector: everything here is already on the
 * node, and a hover card that tried to show relationships would cover the
 * graph the operator is hovering over. Selecting opens the full inspector.
 */
function HoverCard({ node }: { node: GraphNodeDto }) {
  return (
    <div className="pointer-events-none absolute left-2 top-2 max-w-[300px] rounded-lg border border-white/10 bg-black/75 p-2.5 backdrop-blur">
      <div className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: nodeColor(node) }} />
        <span className="truncate text-[12px] font-medium text-white">{node.label}</span>
      </div>
      {node.summary && <div className="mt-0.5 line-clamp-2 text-[10.5px] text-[#8ea0c4]">{node.summary}</div>}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[9.5px] text-[#64769c]">
        <span>{node.kind}</span>
        <span>{node.domain}</span>
        <span>imp {node.importance.toFixed(2)}</span>
        <span>act {node.activity.toFixed(2)}</span>
        <span>conf {node.confidence.toFixed(2)}</span>
        <span>deg {node.degree}</span>
      </div>
      {node.glyphs?.length ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {node.glyphs.map((glyph, index) => (
            <span key={`${glyph.key}-${index}`} title={glyph.title} className="rounded bg-white/[0.06] px-1 py-px text-[9px] text-[#c6d0e2]">
              {glyph.key}{glyph.value ? ` ${glyph.value}` : ''}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-1 text-[9.5px] text-[#64769c]">click to inspect · double-click to expand · alt-click to collapse</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface RenderState {
  camera: Camera;
  viewport: { width: number; height: number };
  layout: GraphLayout;
  nodes: Map<string, GraphNodeDto>;
  edges: Map<string, GraphEdgeDto>;
  neighbours: Map<string, Set<string>>;
  selected: Set<string>;
  hovered: string | null;
  tier: 0 | 1 | 2;
  truncated: Set<string>;
  pulses: Pulse[];
  flashes: Map<string, { at: number; error: boolean }>;
  band: { x1: number; y1: number; x2: number; y2: number } | null;
  mode: 'force' | 'layered';
  clusters: Array<{ id: string; domain: string; label: string; nodeCount: number; activity: number }>;
}

const WEAK_BELOW = 0.35;

function render(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { camera, viewport, layout, nodes, edges, selected, hovered, tier, mode } = state;
  const now = Date.now();

  ctx.clearRect(0, 0, viewport.width, viewport.height);
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  ctx.save();
  ctx.translate(-camera.x * camera.zoom, -camera.y * camera.zoom);
  ctx.scale(camera.zoom, camera.zoom);

  if (mode === 'layered') drawColumns(ctx, camera, viewport);
  else drawClusterFields(ctx, state);

  // The focus set: what the operator is pointing at, plus its neighbours.
  // Everything else dims. This is the single most useful investigative
  // affordance on the canvas and it costs one set intersection.
  const focus = new Set<string>();
  const anchors = hovered ? [hovered].concat(Array.from(selected)) : Array.from(selected);
  for (const anchor of anchors) {
    focus.add(anchor);
    const adjacent = state.neighbours.get(anchor);
    if (adjacent) for (const neighbour of Array.from(adjacent)) focus.add(neighbour);
  }
  const dimming = focus.size > 0;

  // ---- edges -------------------------------------------------------------
  for (const edge of Array.from(edges.values())) {
    const a = layout.nodes.get(edge.source);
    const b = layout.nodes.get(edge.target);
    if (!a || !b) continue;

    const source = nodes.get(edge.source);
    if (!source) continue;
    const lit = dimming && focus.has(edge.source) && focus.has(edge.target);
    const alpha = (dimming && !lit ? 0.06 : 0.15 + edge.confidence * 0.5) * (lit ? 1.6 : 1);

    const stateColor = EDGE_STATE_COLOR[edge.state];
    ctx.strokeStyle = withAlpha(stateColor ?? domainColor(source.domain as never), Math.min(alpha, 0.9));
    ctx.lineWidth = Math.max(0.4, 0.5 + edge.strength * 2.6) / Math.max(camera.zoom, 0.35);
    // Dashes carry the "weak or indirect" meaning. Scaled by zoom so the
    // pattern reads the same at every camera distance.
    if (edge.confidence < WEAK_BELOW) ctx.setLineDash([5 / camera.zoom, 4 / camera.zoom]);
    else ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrowheads only once close enough to see them, and only on edges in
    // focus when something is focused — otherwise a dense graph becomes a
    // field of triangles.
    if (camera.zoom > 0.7 && (!dimming || lit) && edge.strength > 0.2) {
      drawArrow(ctx, a, b, b.radius, ctx.strokeStyle as string, camera.zoom);
    }

    // A standing hum on an edge that is genuinely carrying traffic, distinct
    // from the discrete pulses that individual events produce.
    if (edge.activity > 0.25 && !state.pulses.length && (!dimming || lit)) {
      const t = ((now / 2_400) + hashPhase(edge.id)) % 1;
      drawTravellingDot(ctx, a, b, t, withAlpha(stateColor ?? domainColor(source.domain as never), edge.activity * 0.7), 1.6 / camera.zoom);
    }
  }

  // ---- event pulses ------------------------------------------------------
  for (const pulse of state.pulses) {
    if (!pulse.edgeId) continue;
    const edge = edges.get(pulse.edgeId);
    if (!edge) continue;
    const a = layout.nodes.get(edge.source);
    const b = layout.nodes.get(edge.target);
    if (!a || !b) continue;
    const t = (now - pulse.start) / PULSE_MS;
    if (t < 0 || t > 1) continue;
    const color = pulse.error ? '#ef5350' : '#67e8f9';
    // A trailing comet rather than a dot: direction is legible at a glance,
    // which is the whole reason for animating the edge at all.
    drawTravellingDot(ctx, a, b, Math.max(0, t - 0.06), withAlpha(color, 0.25 * (1 - t)), 2.2 / camera.zoom);
    drawTravellingDot(ctx, a, b, t, withAlpha(color, 0.9 * (1 - t * 0.6)), (2 + pulse.intensity * 2.4) / camera.zoom);
  }

  // ---- nodes -------------------------------------------------------------
  for (const node of Array.from(nodes.values())) {
    const position = layout.nodes.get(node.id);
    if (!position) continue;
    // Semantic zoom: below the camera's tier a node is not drawn at all,
    // unless it is selected or hovered — the operator's target never vanishes.
    if (node.tier > tier && !selected.has(node.id) && hovered !== node.id && !focus.has(node.id)) continue;

    // Cull offscreen. Cheap, and at close zoom it is most of the graph.
    const screenX = (position.x - camera.x) * camera.zoom;
    const screenY = (position.y - camera.y) * camera.zoom;
    const margin = (position.radius + 40) * camera.zoom;
    if (screenX < -margin || screenY < -margin || screenX > viewport.width + margin || screenY > viewport.height + margin) continue;

    const lit = !dimming || focus.has(node.id);
    const color = nodeColor(node);
    const flash = state.flashes.get(node.id);
    const opacity = (dimming && !lit ? 0.15 : 1) * (0.35 + node.confidence * 0.65);

    // Halo — activity. Also the live flash, which is the same channel turned
    // up: a node that just did something IS a node with maximum activity.
    const flashAmount = flash ? Math.max(0, 1 - (now - flash.at) / FLASH_MS) : 0;
    const halo = Math.max(node.activity, flashAmount);
    if (halo > 0.05 && lit) {
      const breathe = 1 + Math.sin(now / 900 + hashPhase(node.id) * 6.28) * 0.12;
      ctx.beginPath();
      ctx.arc(position.x, position.y, position.radius * (1.9 + halo * 1.4) * breathe, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(flashAmount > 0.05 ? (flash?.error ? '#ef5350' : '#67e8f9') : color, 0.05 + halo * 0.22);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(position.x, position.y, position.radius, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(color, opacity * 0.32);
    ctx.fill();
    ctx.lineWidth = (selected.has(node.id) ? 2.4 : 1.2) / camera.zoom;
    ctx.strokeStyle = selected.has(node.id) ? '#ffffff' : withAlpha(color, opacity);
    ctx.stroke();

    // Solid core, so a low-confidence node still reads as a node.
    ctx.beginPath();
    ctx.arc(position.x, position.y, position.radius * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(color, opacity);
    ctx.fill();

    // "+" on a node whose neighbours are not loaded — the expansion affordance.
    if (state.truncated.has(node.id) && camera.zoom > 0.55 && lit) {
      ctx.fillStyle = withAlpha('#e2e8f0', 0.75);
      ctx.font = `${9 / camera.zoom}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('+', position.x + position.radius * 0.95, position.y - position.radius * 0.75);
    }

    // Glyphs: real counters, on the rim, only close enough to read.
    if (camera.zoom > 1.1 && lit && node.glyphs?.length) {
      drawGlyphs(ctx, position.x, position.y, position.radius, node.glyphs, camera.zoom);
    }

    // Labels follow the same tier gate as the nodes, plus the focus override.
    const labelled = node.tier < tier || selected.has(node.id) || hovered === node.id || (dimming && focus.has(node.id)) || node.importance > 0.62;
    if (labelled && camera.zoom > 0.28) {
      ctx.font = `${Math.min(13, 11 / camera.zoom)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = withAlpha('#e2e8f0', dimming && !lit ? 0.2 : 0.92);
      const text = node.label.length > 34 ? `${node.label.slice(0, 34)}…` : node.label;
      ctx.fillText(text, position.x + position.radius + 4 / camera.zoom, position.y + 3.5 / camera.zoom);
    }
  }

  // ---- rubber band -------------------------------------------------------
  if (state.band) {
    const { x1, y1, x2, y2 } = state.band;
    ctx.strokeStyle = 'rgba(103, 232, 249, 0.8)';
    ctx.fillStyle = 'rgba(103, 232, 249, 0.08)';
    ctx.lineWidth = 1 / camera.zoom;
    ctx.setLineDash([4 / camera.zoom, 3 / camera.zoom]);
    ctx.beginPath();
    ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

/**
 * Cluster fields — the combo affordance in the free layout.
 *
 * A soft radial wash behind each domain rather than a convex hull: hulls of a
 * force layout jitter every frame as members cross each other, and the
 * flickering outline is more distracting than the grouping is useful. The wash
 * says "these belong together" without claiming a precise boundary that the
 * layout does not actually have.
 */
function drawClusterFields(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const centroids = new Map<string, { x: number; y: number; count: number; activity: number }>();
  for (const node of Array.from(state.nodes.values())) {
    const position = state.layout.nodes.get(node.id);
    if (!position) continue;
    const entry = centroids.get(node.domain) ?? { x: 0, y: 0, count: 0, activity: 0 };
    entry.x += position.x;
    entry.y += position.y;
    entry.activity += node.activity;
    entry.count += 1;
    centroids.set(node.domain, entry);
  }

  for (const [domain, entry] of Array.from(centroids.entries())) {
    if (entry.count < 2) continue;
    const x = entry.x / entry.count;
    const y = entry.y / entry.count;
    const radius = 90 + Math.sqrt(entry.count) * 34;
    const color = DOMAIN_COLOR[domain as keyof typeof DOMAIN_COLOR] ?? '#8ea0c4';
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, withAlpha(color, 0.075 + (entry.activity / entry.count) * 0.05));
    gradient.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    // The combo's own label, only at the zoom where individual labels are gone.
    if (state.camera.zoom < 0.6) {
      ctx.fillStyle = withAlpha(color, 0.7);
      ctx.font = `${Math.min(30, 15 / state.camera.zoom)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(`${domain} · ${entry.count}`, x, y - radius * 0.62);
    }
  }
}

/** Column guides for the layered (neural) projection. */
function drawColumns(ctx: CanvasRenderingContext2D, camera: Camera, viewport: { width: number; height: number }): void {
  const margin = WORLD.width * 0.06;
  const usable = WORLD.width - margin * 2;
  ctx.textAlign = 'center';
  for (let index = 0; index < LAYER_COLUMNS.length; index += 1) {
    const x = margin + (usable * index) / (LAYER_COLUMNS.length - 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1 / camera.zoom;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, WORLD.height);
    ctx.stroke();

    if (camera.zoom > 0.22) {
      ctx.fillStyle = 'rgba(142,160,196,0.42)';
      ctx.font = `${Math.min(26, 12 / camera.zoom)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.fillText(LAYER_COLUMNS[index], x, 26 / camera.zoom);
    }
  }
}

function drawGlyphs(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  glyphs: Array<{ key: string; value: string; tone: string }>,
  zoom: number,
): void {
  const tone: Record<string, string> = { good: '#2dd4bf', warn: '#f0a53c', bad: '#ef5350', info: '#8ea0c4', idle: '#64748b' };
  const size = 5 / zoom;
  let angle = -Math.PI / 4;
  for (const glyph of glyphs.slice(0, 3)) {
    const gx = x + Math.cos(angle) * (radius + size * 1.4);
    const gy = y + Math.sin(angle) * (radius + size * 1.4);
    ctx.beginPath();
    ctx.arc(gx, gy, size, 0, Math.PI * 2);
    ctx.fillStyle = tone[glyph.tone] ?? '#8ea0c4';
    ctx.fill();
    if (glyph.value) {
      ctx.fillStyle = '#0b1220';
      ctx.font = `${6 / zoom}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(glyph.value.slice(0, 4), gx, gy + 2 / zoom);
    }
    angle += Math.PI / 5;
  }
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  targetRadius: number,
  color: string,
  zoom: number,
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy) || 1;
  const ux = dx / distance;
  const uy = dy / distance;
  // Land the head on the target's rim, not in its middle.
  const tipX = b.x - ux * (targetRadius + 1.5);
  const tipY = b.y - uy * (targetRadius + 1.5);
  const size = 5 / Math.max(zoom, 0.4);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ux * size + -uy * size * 0.45, tipY - uy * size + ux * size * 0.45);
  ctx.lineTo(tipX - ux * size + uy * size * 0.45, tipY - uy * size + -ux * size * 0.45);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawTravellingDot(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  t: number,
  color: string,
  radius: number,
): void {
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** Deterministic phase offset, so ambient animations do not march in lockstep. */
function hashPhase(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return (hash % 1000) / 1000;
}

/** Apply an alpha to a `#rrggbb` colour. The palette is all hex (canvas has no
 *  cascade, so CSS custom properties are unavailable here). */
export function withAlpha(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  if (!hex.startsWith('#') || hex.length !== 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamped.toFixed(3)})`;
}
