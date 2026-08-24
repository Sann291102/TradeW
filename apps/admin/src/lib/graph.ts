'use client';

import { adminApi } from './api';

/**
 * Client for the system graph — the one dataset behind BOTH the Knowledge
 * Graph page and the Perceptrons & Neural Network page.
 *
 * These are not two views of two datasets. They are two projections of the
 * same nodes and edges: the Knowledge Graph draws the standing structure, the
 * Neural Network draws that structure carrying traffic. A node id means the
 * same thing on both, which is why selecting `agent:trap-safety` on one page
 * and opening it on the other lands on the same entity.
 *
 * Wire shapes mirror `services/api/src/graph/graph.types.ts` exactly. When one
 * changes, both change — there is no translation layer here to drift.
 */

// ---------------------------------------------------------------------------
// Vocabulary — mirrors the server's closed lists
// ---------------------------------------------------------------------------

export const GRAPH_DOMAINS = [
  'application',
  'cognition',
  'knowledge',
  'market',
  'research',
  'execution',
  'security',
  'infrastructure',
  'ai',
] as const;
export type GraphDomain = (typeof GRAPH_DOMAINS)[number];

export type NodeKind =
  | 'app' | 'service' | 'package' | 'module' | 'controller' | 'route'
  | 'table' | 'job' | 'deployment'
  | 'agent' | 'model'
  | 'perceptor' | 'layer' | 'episode' | 'proposal' | 'signal'
  | 'concept' | 'memory' | 'note' | 'learning'
  | 'instrument' | 'entity' | 'source'
  | 'research' | 'strategy' | 'indicator'
  | 'experiment' | 'decision' | 'outcome' | 'observation'
  | 'finding' | 'error' | 'operator';

export type RelationType =
  | 'depends_on' | 'calls' | 'uses' | 'used_by' | 'produces' | 'consumes'
  | 'related_to' | 'supports' | 'contradicts' | 'derived_from' | 'learned_from'
  | 'tested_by' | 'validated_by' | 'supersedes' | 'part_of' | 'triggered_by'
  | 'implemented_by' | 'exposed_by' | 'stored_in' | 'researched_by' | 'observed_by';

export type EdgeState = 'normal' | 'contradiction' | 'warning';
export type GraphSource = 'code' | 'database' | 'vault';

export interface NodeGlyph {
  key: string;
  value: string;
  tone: 'good' | 'warn' | 'bad' | 'info' | 'idle';
  title: string;
}

export interface GraphNodeDto {
  id: string;
  kind: NodeKind;
  domain: GraphDomain;
  label: string;
  summary?: string;
  source: GraphSource;
  status?: string;
  importance: number;
  activity: number;
  confidence: number;
  createdAt?: number;
  updatedAt?: number;
  lastSeen?: number;
  cluster: string;
  tier: 0 | 1 | 2;
  glyphs?: NodeGlyph[];
  detail?: Record<string, unknown>;
  degree: number;
}

export interface GraphEdgeDto {
  id: string;
  source: string;
  target: string;
  relation: RelationType;
  strength: number;
  confidence: number;
  activity: number;
  state: EdgeState;
  lastSeen?: number;
  observations?: number;
  evidence?: string;
}

export interface GraphClusterDto {
  id: string;
  domain: GraphDomain;
  label: string;
  nodeCount: number;
  edgeCount: number;
  activity: number;
  exemplars: string[];
}

export interface GraphSlice {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  clusters: GraphClusterDto[];
  totals: { nodes: number; edges: number; clusters: number };
  truncated: string[];
  builtAt: number;
  cached: boolean;
  degraded: string[];
}

export interface GraphMeta {
  builtAt: number;
  buildMs: number;
  refreshMs: number;
  degraded: string[];
  totals: { nodes: number; edges: number };
  domains: Array<{ id: GraphDomain; count: number }>;
  kinds: Array<{ id: NodeKind; domain: GraphDomain; count: number }>;
  relations: Array<{ id: RelationType; label: string; directed: boolean; inverse: string; count: number }>;
  /** The published visual contract — rendered verbatim as the legend, so the
   *  legend can never drift from the renderer. */
  encoding: Array<{ property: string; field: string; meaning: string }>;
  weakEdgeBelow: number;
}

export interface NodeRelationRow {
  relation: RelationType;
  label: string;
  edge: GraphEdgeDto;
  node: GraphNodeDto;
}

export interface NodeDetail {
  node: GraphNodeDto;
  outgoing: NodeRelationRow[];
  incoming: NodeRelationRow[];
  events: Array<{ at: number; label: string; detail?: string; status?: string }>;
  builtAt: number;
}

export interface SignalPathStep {
  nodeId: string;
  label: string;
  kind: NodeKind;
  relation: RelationType | null;
  evidence: string;
  at: number | null;
}

export interface SignalPath {
  requestId: string | null;
  runId: string | null;
  steps: SignalPathStep[];
  startedAt: number | null;
  finishedAt: number | null;
  status: 'ok' | 'error' | 'partial';
}

export type GraphEventKind =
  | 'route.activity' | 'agent.activity' | 'agent.run' | 'ai.call'
  | 'knowledge.created' | 'knowledge.updated' | 'knowledge.deleted'
  | 'relationship.created' | 'relationship.strengthened' | 'relationship.weakened'
  | 'research.completed' | 'experiment.started' | 'experiment.completed'
  | 'sentinel.activity' | 'outcome.generated' | 'error.generated'
  | 'security.event' | 'deployment.event' | 'graph.rebuilt';

export interface GraphEvent {
  id: string;
  kind: GraphEventKind;
  at: number;
  nodeIds: string[];
  edgeIds: string[];
  summary: string;
  domain: GraphDomain;
  intensity: number;
  status: 'ok' | 'error';
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface GraphFilter {
  domains?: GraphDomain[];
  kinds?: NodeKind[];
  relations?: RelationType[];
  sinceHours?: number;
  minConfidence?: number;
  minImportance?: number;
  minActivity?: number;
  q?: string;
  maxTier?: 0 | 1 | 2;
  limit?: number;
}

/** Serialise a filter for the query string. Empty values are omitted so the
 *  URL stays readable and the cache key stays stable. */
export function filterQuery(filter: GraphFilter): string {
  const params = new URLSearchParams();
  if (filter.domains?.length) params.set('domains', filter.domains.join(','));
  if (filter.kinds?.length) params.set('kinds', filter.kinds.join(','));
  if (filter.relations?.length) params.set('relations', filter.relations.join(','));
  if (filter.sinceHours !== undefined) params.set('sinceHours', String(filter.sinceHours));
  if (filter.minConfidence) params.set('minConfidence', String(filter.minConfidence));
  if (filter.minImportance) params.set('minImportance', String(filter.minImportance));
  if (filter.minActivity) params.set('minActivity', String(filter.minActivity));
  if (filter.q) params.set('q', filter.q);
  if (filter.maxTier !== undefined) params.set('maxTier', String(filter.maxTier));
  if (filter.limit) params.set('limit', String(filter.limit));
  return params.toString();
}

export const systemGraph = {
  meta: () => adminApi<GraphMeta>('/graph/meta'),
  overview: (filter: GraphFilter = {}) => adminApi<GraphSlice>(`/graph/overview?${filterQuery(filter)}`),
  nodes: (filter: GraphFilter = {}) => adminApi<GraphSlice>(`/graph/nodes?${filterQuery(filter)}`),
  neighborhood: (ids: string[], depth = 1, filter: GraphFilter = {}) =>
    adminApi<GraphSlice>(`/graph/neighborhood?ids=${encodeURIComponent(ids.join(','))}&depth=${depth}&${filterQuery(filter)}`),
  search: (q: string, limit = 25, filter: GraphFilter = {}) =>
    adminApi<GraphNodeDto[]>(`/graph/search?q=${encodeURIComponent(q)}&limit=${limit}&${filterQuery(filter)}`),
  node: (id: string) => adminApi<NodeDetail>(`/graph/node?id=${encodeURIComponent(id)}`),
  clusters: (filter: GraphFilter = {}) => adminApi<GraphClusterDto[]>(`/graph/clusters?${filterQuery(filter)}`),
  path: (params: { requestId?: string; runId?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.requestId) query.set('requestId', params.requestId);
    if (params.runId) query.set('runId', params.runId);
    return adminApi<SignalPath | null>(`/graph/path?${query.toString()}`);
  },
  events: (limit = 40) => adminApi<GraphEvent[]>(`/graph/events?limit=${limit}`),
};

/**
 * Subscribe to the live graph stream.
 *
 * One stream serves both pages. `EventSource` sends cookies automatically for
 * same-origin requests; the Route Handler at `/api/stream/graph` checks the
 * session and forwards the operator credentials server-side, so the token
 * never touches the browser.
 */
export function subscribeToGraph(
  onEvent: (event: GraphEvent) => void,
  handlers: { onOpen?: () => void; onError?: () => void } = {},
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const source = new EventSource('/api/stream/graph');
  source.onopen = () => handlers.onOpen?.();
  source.addEventListener('graph', (event) => {
    try {
      onEvent(JSON.parse((event as MessageEvent).data) as GraphEvent);
    } catch {
      /* a malformed frame must not tear down the stream */
    }
  });
  source.onerror = () => handlers.onError?.();
  return () => source.close();
}

// ---------------------------------------------------------------------------
// The palette — one colour per domain, used by both pages
// ---------------------------------------------------------------------------

/**
 * Domain colours.
 *
 * Fixed hex rather than CSS custom properties because the graph renders to a
 * `<canvas>`, and canvas has no cascade: `var(--teal)` resolves to the literal
 * string on a 2D context. These are the dark-theme token values from
 * `packages/ui/src/styles/tokens.css`, which is the theme the console runs in.
 *
 * Green and red are deliberately absent from this list. The design system
 * reserves them for market direction and for failure state, and a domain that
 * happened to be drawn green would read as "up" on a trading platform.
 */
export const DOMAIN_COLOR: Record<GraphDomain, string> = {
  application: '#38bdf8', // sky — the request-serving surface
  cognition: '#a78bfa', // violet — the perceptor network
  knowledge: '#14b8a6', // teal — concepts, memories, notes
  market: '#f0a53c', // amber — instruments and entities
  research: '#e879b9', // rose — fundamentals and strategies
  execution: '#fbbf24', // gold — decisions that can move money
  security: '#f87171', // red — findings and errors, deliberately alarming
  infrastructure: '#94a3b8', // slate — tables, jobs, deployments
  ai: '#818cf8', // indigo — agents and models
};

/** Node fill tone by operational status. Absent status → the domain colour. */
export const STATUS_TONE: Record<string, string> = {
  healthy: '#2dd4bf',
  running: '#2dd4bf',
  armed: '#fbbf24',
  degraded: '#f0a53c',
  stale: '#f0a53c',
  warn: '#f0a53c',
  failing: '#ef5350',
  quarantined: '#ef5350',
  error: '#ef5350',
  disabled: '#64748b',
  disarmed: '#64748b',
  idle: '#64748b',
  retired: '#64748b',
  deprecated: '#64748b',
  undeclared: '#f0a53c',
};

/** Edge colour by state. `normal` is resolved from the source node's domain. */
export const EDGE_STATE_COLOR: Record<EdgeState, string | null> = {
  normal: null,
  contradiction: '#ef5350',
  warning: '#f0a53c',
};

export function domainColor(domain: GraphDomain): string {
  return DOMAIN_COLOR[domain] ?? '#8ea0c4';
}

/** The colour a node is actually painted: status wins when it says something. */
export function nodeColor(node: GraphNodeDto): string {
  if (node.status && STATUS_TONE[node.status]) return STATUS_TONE[node.status];
  return domainColor(node.domain);
}

/** A short human label for a node kind, for filter chips and the inspector. */
export const KIND_LABEL: Record<NodeKind, string> = {
  app: 'App',
  service: 'Service',
  package: 'Package',
  module: 'Module',
  controller: 'Controller',
  route: 'Route',
  table: 'Table',
  job: 'Background job',
  deployment: 'Deployment',
  agent: 'Agent',
  model: 'LLM model',
  perceptor: 'Perceptor',
  layer: 'Neural layer',
  episode: 'Episode',
  proposal: 'Proposal',
  signal: 'Signal',
  concept: 'Concept',
  memory: 'Memory',
  note: 'Note',
  learning: 'Learning event',
  instrument: 'Instrument',
  entity: 'Market entity',
  source: 'Data source',
  research: 'Research',
  strategy: 'Strategy',
  indicator: 'Indicator',
  experiment: 'Experiment',
  decision: 'Decision',
  outcome: 'Outcome',
  observation: 'Observation',
  finding: 'Security finding',
  error: 'Error',
  operator: 'Operator',
};

/**
 * The node kinds each page's default view starts from.
 *
 * Both pages can reach every kind — the filters are the same filters. What
 * differs is where each STARTS: the Knowledge Graph opens on structure and
 * knowledge, the Neural Network opens on the signal-carrying path. Neither is
 * a separate dataset, and switching a filter takes you from one to the other.
 */
export const KNOWLEDGE_VIEW_KINDS: NodeKind[] = [
  'app', 'service', 'package', 'module', 'controller', 'route',
  'concept', 'memory', 'note', 'learning',
  'table', 'job', 'deployment',
  'research', 'strategy', 'instrument', 'entity', 'source',
  'experiment', 'decision', 'outcome', 'observation',
  'agent', 'model', 'finding', 'error', 'operator',
  'perceptor', 'layer', 'proposal', 'episode', 'signal',
];

export const NEURAL_VIEW_KINDS: NodeKind[] = [
  'route', 'controller', 'service', 'agent', 'model',
  'perceptor', 'layer', 'signal', 'episode', 'proposal',
  'concept', 'source', 'experiment', 'decision', 'outcome', 'observation', 'error',
];
