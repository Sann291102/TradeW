'use client';

import type { GraphEdgeDto, GraphNodeDto, NodeKind } from './graph';

/**
 * The layout engine behind both graph pages.
 *
 * ## Why this is hand-written and not a library
 *
 * The console has no graph dependency and this adds none. What is needed is
 * narrow and specific: a force simulation that (a) is DETERMINISTIC across
 * snapshot refreshes, (b) can be constrained into columns for the neural
 * projection without becoming a second engine, and (c) never stops moving
 * entirely. A general-purpose library gives none of those for free and costs
 * a dependency in an operator console that has to keep working.
 *
 * ## Determinism is the load-bearing property
 *
 * The graph refreshes every thirty seconds. If layout were seeded randomly,
 * every refresh would rearrange the whole canvas under the operator's cursor
 * and the thing they were looking at would be somewhere else. So initial
 * positions are derived from a hash of the node id: the same node lands in the
 * same place on every build, on every reload, in every browser. Nodes that
 * survive a refresh keep the position they had settled into; only genuinely
 * new nodes are seeded.
 *
 * ## Two projections, one simulation
 *
 * `force` — free layout with domain-cluster gravity. The investigative view:
 * structure finds its own shape and clusters separate on their own.
 *
 * `layered` — the same forces, plus a strong horizontal constraint that pins
 * each node to the column matching its place in the real signal path
 * (sources → routes → controllers → services → agents → perceptors → layers →
 * outputs). That is what produces the dense left-to-right neural topology
 * while the node set stays exactly the same graph.
 *
 * ## Performance
 *
 * Repulsion is the O(n²) term, so it is computed against a spatial grid: each
 * node is only pushed by nodes in its own and adjacent cells. At the console's
 * ceiling of 900 nodes that is roughly linear in practice, and the whole step
 * runs inside one animation frame with room to spare.
 */

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Render radius in world units. Also the collision radius. */
  radius: number;
  /** Heavier nodes move less — a service should not be flung around by a leaf. */
  mass: number;
  /** Pinned by a drag, or by the operator. Forces do not move a pinned node. */
  pinned: boolean;
  /** Column index in `layered` mode; -1 when the node has no place in a path. */
  column: number;
  domain: string;
}

export interface LayoutOptions {
  mode: 'force' | 'layered';
  /** World-space size the layout targets. Not the canvas size — the camera
   *  maps between them, so zooming does not re-run the simulation. */
  width: number;
  height: number;
}

/** Physics constants. Named, because a magic number in a force loop is
 *  unmaintainable by anyone who did not write it. */
const REPULSION = 2_600;
const SPRING = 0.014;
/** Rest length of a link, before edge strength shortens it. */
const SPRING_LENGTH = 78;
const CENTER_PULL = 0.0016;
const CLUSTER_PULL = 0.010;
const COLUMN_PULL = 0.06;
const DAMPING = 0.84;
const MAX_VELOCITY = 14;
/**
 * The floor under alpha.
 *
 * A simulation that cools to zero produces a dead picture; a living network is
 * part of what this view is saying. But drift must be small enough that labels
 * stay readable and a node the operator is aiming at does not move out from
 * under the cursor. This value is the compromise: visible breathing, no chase.
 */
const ALPHA_FLOOR = 0.012;
const ALPHA_DECAY = 0.02;

/** Cell size for the repulsion grid. Roughly the distance past which the
 *  inverse-square force stops mattering at this scale. */
const GRID_CELL = 110;

/**
 * Column assignment for the layered (neural) projection.
 *
 * This is the REAL signal path through TradeW, read left to right:
 *
 *   external data → routes → controllers → services/modules → agents & models
 *   → perceptors → neural layers → concepts & knowledge → decisions & outcomes
 *
 * A kind that has no place in a signal path gets -1 and is laid out by the
 * free forces alongside the columns, rather than being forced into a column
 * where it would assert a position in the pipeline that it does not have.
 */
const COLUMN_OF: Partial<Record<NodeKind, number>> = {
  source: 0,
  instrument: 0,
  entity: 0,
  route: 1,
  controller: 2,
  module: 3,
  service: 3,
  app: 3,
  package: 3,
  agent: 4,
  model: 4,
  signal: 5,
  perceptor: 5,
  layer: 6,
  episode: 7,
  concept: 7,
  memory: 7,
  proposal: 8,
  experiment: 8,
  decision: 8,
  outcome: 9,
  observation: 9,
  error: 9,
};

export const LAYER_COLUMNS = [
  'Sources',
  'Routes',
  'Controllers',
  'Services',
  'Agents',
  'Perception',
  'Neural layers',
  'Association',
  'Proposals',
  'Outcomes',
];

export function columnOf(kind: NodeKind): number {
  return COLUMN_OF[kind] ?? -1;
}

/**
 * Node radius in world units.
 *
 * Radius encodes IMPORTANCE and nothing else — that is the published contract
 * in `GET /admin/graph/meta`, and the renderer must not quietly add a second
 * meaning. The square root keeps AREA roughly proportional to importance,
 * which is how people actually read circle size; a linear radius makes a 0.8
 * node look four times a 0.4 one.
 */
export function radiusOf(node: GraphNodeDto): number {
  return 4 + Math.sqrt(node.importance) * 13;
}

/**
 * A stable pseudo-random number in [0, 1) derived from a string.
 *
 * FNV-1a, because it is four lines, has no dependency, and spreads short
 * similar strings (`route:GET /a`, `route:GET /b`) into different buckets —
 * which a naive char-sum does not, and which would stack every route in one
 * spot on first paint.
 */
export function hash01(text: string, salt = 0): number {
  let hash = 2_166_136_261 ^ salt;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return ((hash >>> 0) % 100_000) / 100_000;
}

/**
 * Where a domain's cluster sits in world space.
 *
 * Fixed angles around a ring rather than computed from the data, so the market
 * cluster is in the same place tomorrow as today. An operator who has learned
 * "security is bottom-right" should keep being right.
 */
const DOMAIN_ANGLE: Record<string, number> = {
  application: 0,
  ai: 0.7,
  cognition: 1.4,
  knowledge: 2.1,
  research: 2.8,
  market: 3.5,
  execution: 4.2,
  security: 4.9,
  infrastructure: 5.6,
};

export function clusterCenter(domain: string, width: number, height: number): { x: number; y: number } {
  const angle = DOMAIN_ANGLE[domain] ?? 0;
  const rx = width * 0.31;
  const ry = height * 0.31;
  return { x: width / 2 + Math.cos(angle) * rx, y: height / 2 + Math.sin(angle) * ry };
}

export class GraphLayout {
  readonly nodes = new Map<string, LayoutNode>();
  private links: Array<{ a: LayoutNode; b: LayoutNode; length: number; k: number }> = [];
  private alpha = 1;
  private options: LayoutOptions;

  constructor(options: LayoutOptions) {
    this.options = options;
  }

  setOptions(options: Partial<LayoutOptions>): void {
    const modeChanged = options.mode !== undefined && options.mode !== this.options.mode;
    this.options = { ...this.options, ...options };
    // A projection switch is a real rearrangement and needs the energy to do
    // it; a resize is not, and reheating on every window drag would make the
    // graph writhe while the operator is trying to make the panel bigger.
    if (modeChanged) this.reheat(0.9);
  }

  /**
   * Reconcile the simulation with a new slice.
   *
   * Nodes that are already here KEEP their position and velocity — this is
   * what makes a thirty-second refresh invisible. Nodes that are gone are
   * dropped. Nodes that are new are seeded deterministically, near their
   * cluster (or column), so they arrive somewhere sensible rather than
   * shooting in from a corner.
   */
  sync(nodes: GraphNodeDto[], edges: GraphEdgeDto[]): void {
    const { width, height, mode } = this.options;
    const incoming = new Set(nodes.map((node) => node.id));

    for (const id of Array.from(this.nodes.keys())) {
      if (!incoming.has(id)) this.nodes.delete(id);
    }

    let added = 0;
    for (const node of nodes) {
      const radius = radiusOf(node);
      const column = columnOf(node.kind);
      const existing = this.nodes.get(node.id);
      if (existing) {
        existing.radius = radius;
        existing.mass = 1 + node.importance * 3;
        existing.column = column;
        existing.domain = node.domain;
        continue;
      }
      const jitterX = hash01(node.id, 1);
      const jitterY = hash01(node.id, 2);
      let x: number;
      let y: number;
      if (mode === 'layered' && column >= 0) {
        x = this.columnX(column) + (jitterX - 0.5) * 60;
        y = height * 0.12 + jitterY * height * 0.76;
      } else {
        const center = clusterCenter(node.domain, width, height);
        const spread = Math.min(width, height) * 0.16;
        x = center.x + (jitterX - 0.5) * spread;
        y = center.y + (jitterY - 0.5) * spread;
      }
      this.nodes.set(node.id, {
        id: node.id,
        x,
        y,
        vx: 0,
        vy: 0,
        radius,
        mass: 1 + node.importance * 3,
        pinned: false,
        column,
        domain: node.domain,
      });
      added += 1;
    }

    this.links = [];
    for (const edge of edges) {
      const a = this.nodes.get(edge.source);
      const b = this.nodes.get(edge.target);
      if (!a || !b) continue;
      this.links.push({
        a,
        b,
        // A stronger relationship pulls its endpoints closer, so proximity on
        // the canvas means something rather than being an accident of order.
        length: SPRING_LENGTH * (1 - edge.strength * 0.45),
        k: SPRING * (0.4 + edge.strength),
      });
    }

    // Only reheat when the node set actually changed. A refresh that returns
    // the same graph should not shake the canvas.
    if (added > 0) this.reheat(Math.min(0.6, 0.1 + added / 60));
  }

  reheat(to = 0.7): void {
    this.alpha = Math.max(this.alpha, to);
  }

  pin(id: string, x: number, y: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
    node.pinned = true;
  }

  release(id: string): void {
    const node = this.nodes.get(id);
    if (node) node.pinned = false;
  }

  /** One integration step. Called once per animation frame. */
  step(): void {
    const { width, height, mode } = this.options;
    this.alpha = Math.max(ALPHA_FLOOR, this.alpha - this.alpha * ALPHA_DECAY);
    const alpha = this.alpha;
    const list = Array.from(this.nodes.values());
    if (list.length === 0) return;

    // --- repulsion, against a spatial grid ---------------------------------
    const grid = new Map<string, LayoutNode[]>();
    for (const node of list) {
      const key = `${Math.floor(node.x / GRID_CELL)},${Math.floor(node.y / GRID_CELL)}`;
      const cell = grid.get(key);
      if (cell) cell.push(node);
      else grid.set(key, [node]);
    }
    for (const node of list) {
      const cx = Math.floor(node.x / GRID_CELL);
      const cy = Math.floor(node.y / GRID_CELL);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const cell = grid.get(`${cx + dx},${cy + dy}`);
          if (!cell) continue;
          for (const other of cell) {
            if (other === node) continue;
            let ox = node.x - other.x;
            let oy = node.y - other.y;
            let d2 = ox * ox + oy * oy;
            if (d2 === 0) {
              // Perfectly coincident nodes have no direction to separate along.
              // Nudge deterministically rather than randomly, so the resulting
              // layout is still reproducible.
              ox = (hash01(node.id, 3) - 0.5) * 0.6;
              oy = (hash01(node.id, 4) - 0.5) * 0.6;
              d2 = ox * ox + oy * oy || 0.01;
            }
            const distance = Math.sqrt(d2);
            // Collision floor: never let two discs overlap so far that the
            // smaller becomes unclickable inside the larger.
            const minimum = node.radius + other.radius + 3;
            const force = (REPULSION * alpha) / d2 + (distance < minimum ? (minimum - distance) * 0.5 : 0);
            node.vx += (ox / distance) * force / node.mass;
            node.vy += (oy / distance) * force / node.mass;
          }
        }
      }
    }

    // --- springs ------------------------------------------------------------
    for (const link of this.links) {
      const dx = link.b.x - link.a.x;
      const dy = link.b.y - link.a.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (distance - link.length) * link.k * alpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      link.a.vx += fx / link.a.mass;
      link.a.vy += fy / link.a.mass;
      link.b.vx -= fx / link.b.mass;
      link.b.vy -= fy / link.b.mass;
    }

    // --- gravity ------------------------------------------------------------
    for (const node of list) {
      if (mode === 'layered' && node.column >= 0) {
        // The column constraint is strong on X and absent on Y: the pipeline
        // order is real and must hold, but vertical position is free so the
        // springs can gather related nodes within a column.
        node.vx += (this.columnX(node.column) - node.x) * COLUMN_PULL;
        node.vy += (height / 2 - node.y) * CENTER_PULL * 3;
      } else {
        const center = clusterCenter(node.domain, width, height);
        node.vx += (center.x - node.x) * CLUSTER_PULL * alpha;
        node.vy += (center.y - node.y) * CLUSTER_PULL * alpha;
        node.vx += (width / 2 - node.x) * CENTER_PULL;
        node.vy += (height / 2 - node.y) * CENTER_PULL;
      }
    }

    // --- integrate ----------------------------------------------------------
    for (const node of list) {
      if (node.pinned) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      const speed = Math.hypot(node.vx, node.vy);
      if (speed > MAX_VELOCITY) {
        node.vx = (node.vx / speed) * MAX_VELOCITY;
        node.vy = (node.vy / speed) * MAX_VELOCITY;
      }
      node.x += node.vx;
      node.y += node.vy;
    }
  }

  private columnX(column: number): number {
    const columns = LAYER_COLUMNS.length;
    const margin = this.options.width * 0.06;
    const usable = this.options.width - margin * 2;
    return margin + (usable * column) / Math.max(columns - 1, 1);
  }

  /** World-space bounds of everything laid out, for "fit graph". */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.nodes.size === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of Array.from(this.nodes.values())) {
      minX = Math.min(minX, node.x - node.radius);
      minY = Math.min(minY, node.y - node.radius);
      maxX = Math.max(maxX, node.x + node.radius);
      maxY = Math.max(maxY, node.y + node.radius);
    }
    return { minX, minY, maxX, maxY };
  }

  /** The node under a world-space point, innermost first. */
  hitTest(x: number, y: number): string | null {
    let best: { id: string; distance: number } | null = null;
    for (const node of Array.from(this.nodes.values())) {
      const distance = Math.hypot(node.x - x, node.y - y);
      // A few pixels of slack, so small nodes are still clickable.
      if (distance > node.radius + 4) continue;
      if (!best || distance < best.distance) best = { id: node.id, distance };
    }
    return best?.id ?? null;
  }

  /** Every node inside a world-space rectangle — the rubber-band selection. */
  within(x1: number, y1: number, x2: number, y2: number): string[] {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);
    const found: string[] = [];
    for (const node of Array.from(this.nodes.values())) {
      if (node.x >= minX && node.x <= maxX && node.y >= minY && node.y <= maxY) found.push(node.id);
    }
    return found;
  }
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.12;
export const MAX_ZOOM = 5;

/**
 * Semantic-zoom tier from camera zoom.
 *
 * The thresholds are the whole progressive-disclosure contract in three lines:
 * far out you get the spine, mid you get services/agents/concepts, close you
 * get routes, memories and evidence. Labels follow the same tiers, which is
 * what stops the canvas from ever rendering four hundred labels at once.
 */
export function tierForZoom(zoom: number): 0 | 1 | 2 {
  if (zoom < 0.45) return 0;
  if (zoom < 1.05) return 1;
  return 2;
}

export function worldToScreen(camera: Camera, x: number, y: number): { x: number; y: number } {
  return { x: (x - camera.x) * camera.zoom, y: (y - camera.y) * camera.zoom };
}

export function screenToWorld(camera: Camera, x: number, y: number): { x: number; y: number } {
  return { x: x / camera.zoom + camera.x, y: y / camera.zoom + camera.y };
}

/** Camera that fits `bounds` into a viewport, with a margin. */
export function fitCamera(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  viewport: { width: number; height: number },
  padding = 60,
): Camera {
  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, Math.min((viewport.width - padding * 2) / width, (viewport.height - padding * 2) / height)),
  );
  return {
    zoom,
    x: bounds.minX + width / 2 - viewport.width / (2 * zoom),
    y: bounds.minY + height / 2 - viewport.height / (2 * zoom),
  };
}

/** Camera centred on one world point at a given zoom — the search-to-focus move. */
export function focusCamera(x: number, y: number, viewport: { width: number; height: number }, zoom: number): Camera {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  return { zoom: clamped, x: x - viewport.width / (2 * clamped), y: y - viewport.height / (2 * clamped) };
}

/**
 * Ease a camera toward a target.
 *
 * Smoothing rather than jumping, because a cut teleports the operator and they
 * have to re-find what they were looking at. `factor` is per-frame, so this is
 * frame-rate dependent by design — a slower machine gets a slower, not a
 * jerkier, glide.
 */
export function easeCamera(from: Camera, to: Camera, factor = 0.16): Camera {
  return {
    x: from.x + (to.x - from.x) * factor,
    y: from.y + (to.y - from.y) * factor,
    zoom: from.zoom + (to.zoom - from.zoom) * factor,
  };
}

export function cameraSettled(a: Camera, b: Camera): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.zoom - b.zoom) < 0.002;
}
