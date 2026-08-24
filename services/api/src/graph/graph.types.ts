/**
 * The system graph — one vocabulary, two projections.
 *
 * The Knowledge Graph page and the Perceptrons & Neural Network page in the
 * admin console are not two visualisations of two datasets. They are two
 * *projections of this one model*: the Knowledge Graph draws the standing
 * structure (what is connected to what), the Neural Network draws the same
 * structure carrying traffic (what is moving through it right now). Anything
 * that appears on one is addressable on the other by the same node id.
 *
 * ## The rule this file exists to enforce
 *
 * Every node and every edge must originate in something the platform actually
 * persisted or actually declared. There are exactly three admissible origins,
 * recorded on every node as `source`:
 *
 *  · `code`     — read out of the running Nest container (modules, controllers,
 *                 routes, the guards on them), the Prisma DMMF (tables and
 *                 their real relations), the workspace manifest (apps, services,
 *                 packages) or `agents/<system>/definitions.json`.
 *  · `database` — a row in Postgres. Concepts, memories, percepts, episodes,
 *                 proposals, synapses, observations, intents, outcomes, audit
 *                 events, instruments, research companies, telemetry.
 *  · `vault`    — a markdown file under `knowledge/` and the links inside it.
 *
 * There is deliberately no fourth origin, and in particular no "synthetic" or
 * "demo" one. A graph that pads itself to look busy is worse than an empty
 * graph, because an empty graph tells an operator something true.
 *
 * ## Visual semantics are data, not decoration
 *
 * The console renders each of these fields to a specific visual property, and
 * the mapping is published to the UI by `GET /admin/graph/meta` so a legend can
 * never drift from the renderer:
 *
 *   importance  0..1 → node RADIUS and label priority under semantic zoom
 *   activity    0..1 → node HALO and pulse rate; edge animation
 *   confidence  0..1 → node/edge OPACITY; below `weakBelow` an edge is DASHED
 *   strength    0..1 → edge WIDTH
 *   direction         → arrowhead (`directed` edges only)
 *   state             → edge colour: `normal` | `contradiction` | `warning`
 *   glyphs            → small counters/status badges on the node rim
 *   cluster           → the combo a node collapses into when zoomed out
 *
 * Nothing else may be encoded visually. If a renderer wants to say something
 * new, it gets a field here first.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The top-level clusters. These are the combos the graph collapses into at the
 * furthest zoom-out, and the domain filter in the console is exactly this list.
 *
 * Chosen so that every node kind below belongs to exactly one of them — a node
 * that could sit in two domains is a sign the kind is doing two jobs.
 */
export const GRAPH_DOMAINS = [
  'application', // apps, services, packages, modules, controllers, routes
  'cognition', // perceptors, neural layers, episodes, proposals, synapse targets
  'knowledge', // concepts, memories, vault notes, learning events
  'market', // instruments, entity-graph nodes, external data sources
  'research', // research companies, statements, strategies, indicators
  'execution', // execution profiles, intents, outcomes, orders
  'security', // audit events, security findings, operator accounts
  'infrastructure', // databases/tables, leased background jobs, deployments
  'ai', // agents, LLM models/providers, Claude interactions
] as const;
export type GraphDomain = (typeof GRAPH_DOMAINS)[number];

/**
 * What a node *is*. The console's node-type filter is this list, grouped by
 * domain via `NODE_KIND_DOMAIN` below.
 *
 * Each kind names its backing store in the comment beside it. A kind with no
 * backing store cannot be added.
 */
export const NODE_KINDS = [
  // --- application (code) --------------------------------------------------
  'app', // workspace manifest: apps/*
  'service', // workspace manifest: services/*
  'package', // workspace manifest: packages/*
  'module', // Nest DiscoveryService
  'controller', // Nest DiscoveryService
  'route', // Nest route metadata + ApiCallLog traffic
  // --- infrastructure ------------------------------------------------------
  'table', // Prisma DMMF model
  'job', // JobLease row (leader-elected background loop)
  'deployment', // AuditEvent rows of deploy/boot type
  // --- ai ------------------------------------------------------------------
  'agent', // agents/<system>/definitions.json + AiCallLog
  'model', // AiCallLog provider/model pair
  // --- cognition -----------------------------------------------------------
  'perceptor', // cognition registry + PerceptorState
  'layer', // CognitiveNetwork layer snapshot
  'episode', // CognitiveEpisode
  'proposal', // CognitiveProposal
  'signal', // Percept subject — the thing a perceptor perceived
  // --- knowledge -----------------------------------------------------------
  'concept', // ConceptNode
  'memory', // MemoryRecord
  'note', // knowledge/*.md
  'learning', // ConceptObservation / ConceptPromotion
  // --- market --------------------------------------------------------------
  'instrument', // Instrument
  'entity', // GraphNode (entity graph)
  'source', // configured external data provider
  // --- research ------------------------------------------------------------
  'research', // ResearchCompany
  'strategy', // UserStrategy / ExecutionProfile.strategyName
  'indicator', // percept feature names emitted by market perceptors
  // --- execution -----------------------------------------------------------
  'experiment', // ExecutionProfile — a standing, armed hypothesis
  'decision', // ExecutionIntent
  'outcome', // ExecutionOutcome
  'observation', // SentinelObservation
  // --- security ------------------------------------------------------------
  'finding', // AuditEvent of a security-relevant type
  'error', // grouped error signature from ApiCallLog / AiCallLog
  'operator', // OperatorAccount (aggregate — never a named person)
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_KIND_DOMAIN: Record<NodeKind, GraphDomain> = {
  app: 'application',
  service: 'application',
  package: 'application',
  module: 'application',
  controller: 'application',
  route: 'application',
  table: 'infrastructure',
  job: 'infrastructure',
  deployment: 'infrastructure',
  agent: 'ai',
  model: 'ai',
  perceptor: 'cognition',
  layer: 'cognition',
  episode: 'cognition',
  proposal: 'cognition',
  signal: 'cognition',
  concept: 'knowledge',
  memory: 'knowledge',
  note: 'knowledge',
  learning: 'knowledge',
  instrument: 'market',
  entity: 'market',
  source: 'market',
  research: 'research',
  strategy: 'research',
  indicator: 'research',
  experiment: 'execution',
  decision: 'execution',
  outcome: 'execution',
  observation: 'execution',
  finding: 'security',
  error: 'security',
  operator: 'security',
};

/**
 * The relationship vocabulary. Closed on purpose: an edge whose meaning is not
 * in this list cannot be drawn, because the console styles and filters on it.
 *
 * `directed` says whether the edge carries a flow (draw an arrowhead) or merely
 * asserts an association (no arrowhead). `inverse` is what the same edge is
 * called when read from the other end, which is what makes the inspector able
 * to say "consumed by" on one side and "consumes" on the other without storing
 * the edge twice.
 */
export const RELATIONS = {
  depends_on: { directed: true, inverse: 'used_by', label: 'depends on' },
  calls: { directed: true, inverse: 'called_by', label: 'calls' },
  uses: { directed: true, inverse: 'used_by', label: 'uses' },
  used_by: { directed: true, inverse: 'uses', label: 'used by' },
  produces: { directed: true, inverse: 'produced_by', label: 'produces' },
  consumes: { directed: true, inverse: 'consumed_by', label: 'consumes' },
  related_to: { directed: false, inverse: 'related_to', label: 'related to' },
  supports: { directed: true, inverse: 'supported_by', label: 'supports' },
  contradicts: { directed: false, inverse: 'contradicts', label: 'contradicts' },
  derived_from: { directed: true, inverse: 'derives', label: 'derived from' },
  learned_from: { directed: true, inverse: 'taught', label: 'learned from' },
  tested_by: { directed: true, inverse: 'tests', label: 'tested by' },
  validated_by: { directed: true, inverse: 'validates', label: 'validated by' },
  supersedes: { directed: true, inverse: 'superseded_by', label: 'supersedes' },
  part_of: { directed: true, inverse: 'contains', label: 'part of' },
  triggered_by: { directed: true, inverse: 'triggers', label: 'triggered by' },
  implemented_by: { directed: true, inverse: 'implements', label: 'implemented by' },
  exposed_by: { directed: true, inverse: 'exposes', label: 'exposed by' },
  stored_in: { directed: true, inverse: 'stores', label: 'stored in' },
  researched_by: { directed: true, inverse: 'researches', label: 'researched by' },
  observed_by: { directed: true, inverse: 'observes', label: 'observed by' },
} as const;

export type RelationType = keyof typeof RELATIONS;
export const RELATION_TYPES = Object.keys(RELATIONS) as RelationType[];

/** Where a node's existence was established. See the file header. */
export type GraphSource = 'code' | 'database' | 'vault';

/**
 * Edge state, which the console renders as colour.
 *
 * `contradiction` is reserved for edges that genuinely assert disagreement —
 * a `contradicts` concept edge, or a relation whose refutations outnumber its
 * supports. `warning` marks an edge whose subject is failing: a route with a
 * live error rate, a quarantined perceptor's feed, an errored agent hop.
 */
export type EdgeState = 'normal' | 'contradiction' | 'warning';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** A small counter or status badge rendered on the node rim. */
export interface NodeGlyph {
  /** Short key the renderer maps to a position/icon: `err`, `req`, `deg`, … */
  key: string;
  /** What is shown. Kept pre-formatted so the browser does no unit guessing. */
  value: string;
  tone: 'good' | 'warn' | 'bad' | 'info' | 'idle';
  /** Tooltip text. */
  title: string;
}

export interface GraphNodeDto {
  /** `<kind>:<stable-key>` — stable across snapshots, so the console can keep
   *  a selection, a pinned position and an expansion across a refresh. */
  id: string;
  kind: NodeKind;
  domain: GraphDomain;
  label: string;
  /** One line, shown under the label in the inspector and in the tooltip. */
  summary?: string;
  source: GraphSource;
  /** Free-form operational state: `healthy` | `degraded` | `failing` | `idle`
   *  | `armed` | `pending` | `deprecated` … Rendered as the node's fill tone. */
  status?: string;

  /** 0..1 — graph importance. Node radius. Blends declared weight with degree
   *  centrality and observed traffic; see `graph.projection.ts`. */
  importance: number;
  /** 0..1 — how recently and how much this node has been doing something.
   *  Halo intensity and pulse rate. 0 for anything with no activity signal. */
  activity: number;
  /** 0..1 — how sure the platform is that this node means what it says.
   *  Opacity. Code-derived nodes are 1: they are read from the running system. */
  confidence: number;

  createdAt?: number;
  updatedAt?: number;
  /** Last time this node was observed doing something (ms epoch). */
  lastSeen?: number;

  /** The combo this node collapses into when the camera zooms out. */
  cluster: string;
  /**
   * Semantic-zoom tier. 0 = always visible (domains and the largest hubs),
   * 1 = visible at medium zoom (apps, services, agents, concepts), 2 = only at
   * close zoom (routes, memories, episodes, evidence). Computed, not authored.
   */
  tier: 0 | 1 | 2;

  glyphs?: NodeGlyph[];
  /** Kind-specific real fields for the inspector. Never contains PII. */
  detail?: Record<string, unknown>;
  /** Degree in the FULL backend graph, not in the loaded neighbourhood — this
   *  is what tells the console a collapsed node still has 400 neighbours. */
  degree: number;
}

export interface GraphEdgeDto {
  id: string;
  source: string;
  target: string;
  relation: RelationType;
  /** 0..1 — edge width. Traffic, dependency weight or learned synapse weight. */
  strength: number;
  /** 0..1 — opacity; under `WEAK_EDGE_BELOW` the edge renders dashed. */
  confidence: number;
  /** 0..1 — animate a travelling pulse along this edge at this rate. */
  activity: number;
  state: EdgeState;
  lastSeen?: number;
  /** How many observations back this edge. Shown in the inspector. */
  observations?: number;
  /** What made this edge exist, in words an operator can check. */
  evidence?: string;
}

/** Below this confidence an edge is drawn dashed — a weak or indirect claim. */
export const WEAK_EDGE_BELOW = 0.35;

export interface GraphClusterDto {
  id: string;
  domain: GraphDomain;
  label: string;
  nodeCount: number;
  edgeCount: number;
  /** Mean activity across members — how alive the cluster is right now. */
  activity: number;
  /** The few highest-importance member ids, so a collapsed combo can still
   *  show what it is made of without shipping every member. */
  exemplars: string[];
}

export interface GraphSlice {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  clusters: GraphClusterDto[];
  /** Totals for the WHOLE backend graph, so the console can say "showing 220
   *  of 4,318" rather than implying the slice is everything. */
  totals: { nodes: number; edges: number; clusters: number };
  /** Node ids present in the slice that have neighbours outside it. Drives the
   *  "+N" expansion glyph. */
  truncated: string[];
  /** ms epoch of the snapshot this slice was cut from. */
  builtAt: number;
  /** Whether the snapshot was served from cache. */
  cached: boolean;
  /** Sources that could not be read this build, named rather than hidden. */
  degraded: string[];
}

// ---------------------------------------------------------------------------
// Query shapes
// ---------------------------------------------------------------------------

export interface GraphFilter {
  domains?: GraphDomain[];
  kinds?: NodeKind[];
  relations?: RelationType[];
  /** Only nodes seen within this many hours. Undefined = no time filter. */
  sinceHours?: number;
  minConfidence?: number;
  minImportance?: number;
  minActivity?: number;
  /** Free-text match over label and summary. */
  q?: string;
  /** Semantic-zoom tier ceiling: 0 shows only hubs, 2 shows everything. */
  maxTier?: 0 | 1 | 2;
  /** Hard cap on returned nodes. The server always applies its own ceiling. */
  limit?: number;
}

/** One hop of a real signal path, as returned by `GET /admin/graph/path`. */
export interface SignalPathStep {
  nodeId: string;
  label: string;
  kind: NodeKind;
  relation: RelationType | null;
  /** What evidences this hop — a request id, a run id, a row count. */
  evidence: string;
  at: number | null;
}

export interface SignalPathDto {
  /** The correlation id the path was reconstructed from, when there was one. */
  requestId: string | null;
  runId: string | null;
  steps: SignalPathStep[];
  startedAt: number | null;
  finishedAt: number | null;
  status: 'ok' | 'error' | 'partial';
}

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------

/**
 * What the console is told when the graph changes underneath it.
 *
 * These are emitted from the events the platform ALREADY produces — the
 * telemetry bus, the vault watcher, the cognition pass — rather than from a
 * new side channel. `nodeIds` names the nodes to light up; `edgeIds` the edges
 * to pulse. Both may be empty when the event is informational.
 */
export const GRAPH_EVENT_KINDS = [
  'route.activity',
  'agent.activity',
  'agent.run',
  'ai.call',
  'knowledge.created',
  'knowledge.updated',
  'knowledge.deleted',
  'relationship.created',
  'relationship.strengthened',
  'relationship.weakened',
  'research.completed',
  'experiment.started',
  'experiment.completed',
  'sentinel.activity',
  'outcome.generated',
  'error.generated',
  'security.event',
  'deployment.event',
  'graph.rebuilt',
] as const;
export type GraphEventKind = (typeof GRAPH_EVENT_KINDS)[number];

export interface GraphEvent {
  id: string;
  kind: GraphEventKind;
  at: number;
  /** Nodes this event touched, most specific first. */
  nodeIds: string[];
  /** Edges to pulse. Ids match `GraphEdgeDto.id`. */
  edgeIds: string[];
  /** One line for the live feed. */
  summary: string;
  domain: GraphDomain;
  /** 0..1 — how hard to pulse. Derived from the underlying signal, never fixed. */
  intensity: number;
  /** `ok` for normal traffic, `error` when the event IS the failure. */
  status: 'ok' | 'error';
}

// ---------------------------------------------------------------------------
// Helpers shared by the projection, the controller and the tests
// ---------------------------------------------------------------------------

/** Build a node id. Never interpolate by hand — ids are joined across sources. */
export function nodeId(kind: NodeKind, key: string): string {
  return `${kind}:${key}`;
}

/** Split a node id back into its parts. Returns null for a malformed id. */
export function parseNodeId(id: string): { kind: NodeKind; key: string } | null {
  const at = id.indexOf(':');
  if (at <= 0) return null;
  const kind = id.slice(0, at) as NodeKind;
  if (!NODE_KINDS.includes(kind)) return null;
  return { kind, key: id.slice(at + 1) };
}

/**
 * Edge ids are derived from their endpoints and relation rather than stored,
 * so the same edge rebuilt from a fresh snapshot keeps its id and the console's
 * in-flight pulse animation survives a refresh.
 */
export function edgeId(source: string, relation: RelationType, target: string): string {
  return `${source}|${relation}|${target}`;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Recency as a 0..1 decay.
 *
 * Used for `activity` everywhere, so "active" means the same thing on a route,
 * a concept and a synapse: something happened, and it happened recently. A
 * half-life rather than a cliff, because a cliff makes a busy node blink out
 * the instant it crosses an arbitrary boundary.
 */
export function recency(at: number | null | undefined, halfLifeMs: number, now = Date.now()): number {
  if (!at) return 0;
  const age = now - at;
  if (age <= 0) return 1;
  return clamp01(Math.pow(0.5, age / halfLifeMs));
}

/** Compress an unbounded count into 0..1 without a hard ceiling. */
export function saturate(value: number, scale: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return clamp01(value / (value + scale));
}
