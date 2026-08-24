import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GraphProjectionService, GraphSnapshot, routeNodeId } from './graph.projection';
import {
  clamp01,
  GRAPH_DOMAINS,
  GraphClusterDto,
  GraphDomain,
  GraphEdgeDto,
  GraphFilter,
  GraphNodeDto,
  GraphSlice,
  NODE_KIND_DOMAIN,
  NODE_KINDS,
  NodeKind,
  nodeId,
  parseNodeId,
  RELATION_TYPES,
  RELATIONS,
  RelationType,
  SignalPathDto,
  SignalPathStep,
  WEAK_EDGE_BELOW,
} from './graph.types';

/**
 * Queries over the system graph — and the reason the browser never receives
 * the whole thing.
 *
 * ## The performance contract
 *
 * The backend graph is allowed to grow to whatever the platform's history
 * makes it. The viewport is not. Every read on this service returns a SLICE
 * with an explicit ceiling, and every slice carries `totals` and `truncated`
 * so the console can say "220 of 4,318, this node has 41 more neighbours"
 * rather than quietly presenting a fragment as the whole.
 *
 * Four mechanisms, in the order they bite:
 *
 *  1. **Semantic zoom (`maxTier`).** The furthest zoom-out asks for tier 0 and
 *     gets the structural spine and the genuine hubs — tens of nodes, not
 *     thousands. Detail is fetched only when the camera has earned it.
 *  2. **Neighbourhood loading.** `neighborhood()` walks outward from one node
 *     by breadth, never loading a component the operator has not looked at.
 *  3. **Filtering, server-side.** Domain, kind, relation, time, confidence,
 *     importance and activity are applied before serialisation, so a filtered
 *     view costs less on the wire, not more work in the browser.
 *  4. **Aggregation.** `clusters()` collapses a domain into one combo with a
 *     member count, which is what makes "show me everything" answerable at all.
 *
 * ## The snapshot cache
 *
 * One snapshot serves every reader for `REFRESH_MS`. It is rebuilt in the
 * background on the first request after it goes stale, and readers during a
 * rebuild get the previous snapshot rather than blocking — a graph that is
 * thirty seconds old is a far better answer than a request that takes four
 * seconds to produce a fresh one. `builtAt` is on every response so the console
 * can show the snapshot's real age instead of implying it is live.
 */

const REFRESH_MS = Number(process.env.GRAPH_REFRESH_MS ?? 30_000);

/** Hard ceilings. A caller may ask for less; it may never ask for more. */
const MAX_SLICE_NODES = 900;
const DEFAULT_SLICE_NODES = 260;
const MAX_EXPAND_DEGREE = 3;

@Injectable()
export class GraphService implements OnModuleDestroy {
  private readonly logger = new Logger(GraphService.name);

  private snapshot: GraphSnapshot | null = null;
  private building: Promise<GraphSnapshot> | null = null;
  private destroyed = false;

  constructor(
    private readonly projection: GraphProjectionService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleDestroy(): void {
    this.destroyed = true;
  }

  // -------------------------------------------------------------- the cache

  /**
   * The current snapshot, rebuilding it if it is stale.
   *
   * `force` is what the SSE hub uses after a structural event (a concept
   * created, a relationship formed): those change the graph's shape rather
   * than its numbers, and waiting out the refresh window would show an
   * operator an edge that the live feed already told them about.
   */
  async current(force = false): Promise<GraphSnapshot> {
    const stale = !this.snapshot || Date.now() - this.snapshot.builtAt > REFRESH_MS;
    if (!stale && !force) return this.snapshot!;

    // A rebuild already in flight is the rebuild this caller wants.
    if (this.building) {
      // …unless we already hold a usable snapshot, in which case serve it and
      // let the rebuild land for the next reader. This is the property that
      // keeps a burst of console requests off the database.
      if (this.snapshot && !force) return this.snapshot;
      return this.building;
    }

    this.building = this.projection
      .build()
      .then((built) => {
        this.snapshot = built;
        return built;
      })
      .catch((err: unknown) => {
        this.logger.error(`graph build failed: ${String(err)}`);
        // A failed rebuild must not destroy a working snapshot. If there is
        // none, return an empty one that names the failure rather than throwing
        // — the console renders "degraded", which is the truth.
        return (
          this.snapshot ?? {
            nodes: new Map(),
            edges: new Map(),
            adjacency: new Map(),
            incident: new Map(),
            builtAt: Date.now(),
            degraded: ['build'],
            buildMs: 0,
          }
        );
      })
      .finally(() => {
        this.building = null;
      });

    return this.building;
  }

  /** Drop the cached snapshot so the next read rebuilds. */
  invalidate(): void {
    if (this.destroyed) return;
    this.snapshot = null;
  }

  /** Whether a node id exists in the current snapshot, without forcing a build. */
  knows(id: string): boolean {
    return this.snapshot?.nodes.has(id) ?? false;
  }

  // ------------------------------------------------------------------ reads

  /**
   * What the graph IS — the legend, the vocabulary and the counts.
   *
   * Served rather than hardcoded in the console so the published meaning of
   * every visual property comes from the same module that computes it. A
   * legend that can drift from the renderer is a legend that will.
   */
  async meta() {
    const snapshot = await this.current();
    const byKind = new Map<NodeKind, number>();
    const byDomain = new Map<GraphDomain, number>();
    const byRelation = new Map<RelationType, number>();
    for (const node of snapshot.nodes.values()) {
      byKind.set(node.kind, (byKind.get(node.kind) ?? 0) + 1);
      byDomain.set(node.domain, (byDomain.get(node.domain) ?? 0) + 1);
    }
    for (const edge of snapshot.edges.values()) {
      byRelation.set(edge.relation, (byRelation.get(edge.relation) ?? 0) + 1);
    }

    return {
      builtAt: snapshot.builtAt,
      buildMs: snapshot.buildMs,
      refreshMs: REFRESH_MS,
      degraded: snapshot.degraded,
      totals: { nodes: snapshot.nodes.size, edges: snapshot.edges.size },
      domains: GRAPH_DOMAINS.map((domain) => ({ id: domain, count: byDomain.get(domain) ?? 0 })),
      kinds: NODE_KINDS.map((kind) => ({ id: kind, domain: NODE_KIND_DOMAIN[kind], count: byKind.get(kind) ?? 0 })),
      relations: RELATION_TYPES.map((relation) => ({
        id: relation,
        label: RELATIONS[relation].label,
        directed: RELATIONS[relation].directed,
        inverse: RELATIONS[relation].inverse,
        count: byRelation.get(relation) ?? 0,
      })),
      /**
       * The published visual contract. The console reads this to draw its
       * legend, so the two can never disagree about what a thick edge means.
       */
      encoding: [
        { property: 'node radius', field: 'importance', meaning: 'graph importance — declared weight blended with degree centrality and observed traffic' },
        { property: 'node halo + pulse', field: 'activity', meaning: 'recency-weighted activity; 0 means nothing has happened' },
        { property: 'node opacity', field: 'confidence', meaning: 'how sure the platform is this node means what it says' },
        { property: 'node fill tone', field: 'status', meaning: 'operational state: healthy, degraded, failing, idle, armed, pending' },
        { property: 'node rim glyphs', field: 'glyphs', meaning: 'real counters: requests, errors, observations, LLM calls' },
        { property: 'edge width', field: 'strength', meaning: 'relationship strength — traffic volume, dependency weight or learned synapse weight' },
        { property: 'edge opacity', field: 'confidence', meaning: 'evidential confidence in the relationship' },
        { property: 'edge dashes', field: `confidence < ${WEAK_EDGE_BELOW}`, meaning: 'weak or indirect association — an unscored synapse, an unobserved prior' },
        { property: 'edge arrowhead', field: 'relation.directed', meaning: 'data or request flow direction' },
        { property: 'edge animation', field: 'activity', meaning: 'a travelling pulse, only while the underlying relationship is carrying traffic' },
        { property: 'edge colour', field: 'state', meaning: 'red = contradiction (a refuted relation, a losing decision); amber = warning (an erroring route or sensor)' },
        { property: 'combo', field: 'cluster', meaning: 'the domain a node collapses into at low zoom' },
        { property: 'visibility', field: 'tier', meaning: 'semantic zoom: 0 = spine and hubs, 1 = services/agents/concepts, 2 = evidence detail' },
      ],
      weakEdgeBelow: WEAK_EDGE_BELOW,
    };
  }

  /**
   * The furthest zoom-out: one combo per domain, plus the graph's true hubs.
   *
   * This is the first paint. It is deliberately tiny — a few dozen nodes — so
   * the console has something meaningful on screen before it has decided what
   * the operator is investigating.
   */
  async overview(filter: GraphFilter = {}): Promise<GraphSlice> {
    const snapshot = await this.current();
    const limit = Math.min(filter.limit ?? 120, MAX_SLICE_NODES);
    const candidates = [...snapshot.nodes.values()]
      .filter((node) => this.matches(node, { ...filter, maxTier: filter.maxTier ?? 0 }))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
    return this.slice(snapshot, candidates, filter);
  }

  /** A filtered slice of the graph, highest-importance first. */
  async query(filter: GraphFilter = {}): Promise<GraphSlice> {
    const snapshot = await this.current();
    const limit = Math.min(filter.limit ?? DEFAULT_SLICE_NODES, MAX_SLICE_NODES);
    const nodes = [...snapshot.nodes.values()]
      .filter((node) => this.matches(node, filter))
      .sort((a, b) => b.importance - a.importance || b.activity - a.activity)
      .slice(0, limit);
    return this.slice(snapshot, nodes, filter);
  }

  /**
   * Expand outward from one or more nodes.
   *
   * Breadth-first with a per-ring budget rather than a single global cap: a
   * hub with 400 neighbours would otherwise consume the whole budget at depth
   * 1 and the operator would never see the second ring they asked for. Within
   * a ring, neighbours are taken by importance, so what arrives first is what
   * is worth looking at first.
   */
  async neighborhood(seeds: string[], depth = 1, filter: GraphFilter = {}): Promise<GraphSlice> {
    const snapshot = await this.current();
    const hops = Math.max(1, Math.min(depth, MAX_EXPAND_DEGREE));
    const budget = Math.min(filter.limit ?? DEFAULT_SLICE_NODES, MAX_SLICE_NODES);

    const chosen = new Map<string, GraphNodeDto>();
    for (const seed of seeds) {
      const node = snapshot.nodes.get(seed);
      // Seeds are always included even if they fail the filter: the operator
      // selected them, and dropping the thing under investigation because a
      // slider moved is the single most confusing thing this view could do.
      if (node) chosen.set(seed, node);
    }
    if (chosen.size === 0) return this.slice(snapshot, [], filter);

    let frontier = [...chosen.keys()];
    for (let hop = 0; hop < hops && chosen.size < budget; hop += 1) {
      const ring = new Map<string, GraphNodeDto>();
      for (const id of frontier) {
        for (const neighbour of snapshot.adjacency.get(id) ?? []) {
          if (chosen.has(neighbour) || ring.has(neighbour)) continue;
          const node = snapshot.nodes.get(neighbour);
          if (!node || !this.matches(node, { ...filter, maxTier: undefined })) continue;
          if (!this.edgeAllowed(snapshot, id, neighbour, filter)) continue;
          ring.set(neighbour, node);
        }
      }
      const room = budget - chosen.size;
      const take = [...ring.values()].sort((a, b) => b.importance - a.importance).slice(0, room);
      for (const node of take) chosen.set(node.id, node);
      frontier = take.map((node) => node.id);
      if (frontier.length === 0) break;
    }

    return this.slice(snapshot, [...chosen.values()], filter);
  }

  /** Search-to-focus. Ranked so an exact label match always wins. */
  async search(q: string, limit = 25, filter: GraphFilter = {}): Promise<GraphNodeDto[]> {
    const snapshot = await this.current();
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const scored: Array<{ node: GraphNodeDto; score: number }> = [];
    for (const node of snapshot.nodes.values()) {
      if (!this.matches(node, { ...filter, q: undefined, maxTier: undefined })) continue;
      const label = node.label.toLowerCase();
      const summary = (node.summary ?? '').toLowerCase();
      let score = 0;
      if (label === needle) score = 1000;
      else if (label.startsWith(needle)) score = 500;
      else if (label.includes(needle)) score = 250;
      else if (node.id.toLowerCase().includes(needle)) score = 120;
      else if (summary.includes(needle)) score = 60;
      if (score === 0) continue;
      scored.push({ node, score: score + node.importance * 40 + node.degree });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(limit, 100))
      .map((entry) => entry.node);
  }

  /**
   * Everything the inspector shows about one node, with its relationships
   * split by direction and named from THIS node's point of view.
   *
   * The inverse labels come from the relation vocabulary, which is what lets
   * one stored edge read correctly at both ends: `route ← exposed_by ←
   * controller` shows as "exposes" on the controller and "exposed by" on the
   * route, with no second row in the graph.
   */
  async node(id: string) {
    const snapshot = await this.current();
    const node = snapshot.nodes.get(id);
    if (!node) return null;

    const outgoing: Array<{ relation: RelationType; label: string; edge: GraphEdgeDto; node: GraphNodeDto }> = [];
    const incoming: Array<{ relation: RelationType; label: string; edge: GraphEdgeDto; node: GraphNodeDto }> = [];
    for (const edgeKey of snapshot.incident.get(id) ?? []) {
      const edge = snapshot.edges.get(edgeKey);
      if (!edge) continue;
      if (edge.source === id) {
        const other = snapshot.nodes.get(edge.target);
        if (other) outgoing.push({ relation: edge.relation, label: RELATIONS[edge.relation].label, edge, node: other });
      } else {
        const other = snapshot.nodes.get(edge.source);
        if (other) incoming.push({ relation: edge.relation, label: RELATIONS[edge.relation].inverse.replace(/_/g, ' '), edge, node: other });
      }
    }
    const byStrength = (a: { edge: GraphEdgeDto }, b: { edge: GraphEdgeDto }) => b.edge.strength - a.edge.strength;

    return {
      node,
      outgoing: outgoing.sort(byStrength).slice(0, 60),
      incoming: incoming.sort(byStrength).slice(0, 60),
      /** Recent real events touching this node, when the kind has an event log. */
      events: await this.recentEvents(node),
      builtAt: snapshot.builtAt,
    };
  }

  /**
   * Domain combos: what a collapsed cluster contains, without shipping it.
   */
  async clusters(filter: GraphFilter = {}): Promise<GraphClusterDto[]> {
    const snapshot = await this.current();
    return this.buildClusters(snapshot, [...snapshot.nodes.values()].filter((node) => this.matches(node, filter)));
  }

  /**
   * Reconstruct a real signal path from a correlation id.
   *
   * This is the endpoint behind "show me how this request actually moved
   * through the system". It reads the two telemetry tables that share
   * `requestId` — the HTTP row and the LLM rows it caused — plus the agent
   * transitions of any run that carried the same id, and returns them as
   * ordered hops onto nodes the graph already has. Nothing is inferred: a hop
   * appears because a row exists saying it happened.
   */
  async path(params: { requestId?: string; runId?: string }): Promise<SignalPathDto> {
    const snapshot = await this.current();
    const steps: SignalPathStep[] = [];
    let requestId = params.requestId ?? null;
    let startedAt: number | null = null;
    let finishedAt: number | null = null;
    let status: SignalPathDto['status'] = 'ok';

    if (params.runId && !requestId) {
      const run = await this.prisma.agentRun.findUnique({
        where: { runId: params.runId },
        select: { requestId: true },
      });
      requestId = run?.requestId ?? null;
    }

    if (requestId) {
      const api = await this.prisma.apiCallLog.findFirst({
        where: { requestId },
        orderBy: { createdAt: 'asc' },
        select: { method: true, path: true, statusCode: true, durationMs: true, createdAt: true, error: true },
      });
      if (api) {
        startedAt = api.createdAt.getTime();
        finishedAt = api.createdAt.getTime() + api.durationMs;
        if (api.statusCode >= 400) status = 'error';
        const routeId = routeNodeId(api.method, api.path);
        const routeNode = snapshot.nodes.get(routeId);
        steps.push({
          nodeId: routeId,
          label: `${api.method} ${api.path}`,
          kind: 'route',
          relation: null,
          evidence: `ApiCallLog ${api.statusCode} in ${api.durationMs}ms`,
          at: api.createdAt.getTime(),
        });
        // The controller that served it, from the code topology rather than a
        // second log line — this hop is structure, and structure is known.
        const controller = routeNode?.detail?.controller;
        if (typeof controller === 'string' && snapshot.nodes.has(nodeId('controller', controller))) {
          steps.push({
            nodeId: nodeId('controller', controller),
            label: controller,
            kind: 'controller',
            relation: 'exposed_by',
            evidence: `${controller}.${String(routeNode?.detail?.handler ?? '?')}() declares this route`,
            at: api.createdAt.getTime(),
          });
        }
      }
    }

    if (requestId) {
      const calls = await this.prisma.aiCallLog.findMany({
        where: { requestId },
        orderBy: { createdAt: 'asc' },
        take: 40,
        select: { agent: true, system: true, provider: true, model: true, latencyMs: true, status: true, createdAt: true },
      });
      for (const call of calls) {
        if (call.status !== 'ok') status = status === 'error' ? 'error' : 'partial';
        finishedAt = Math.max(finishedAt ?? 0, call.createdAt.getTime() + call.latencyMs) || finishedAt;
        steps.push({
          nodeId: nodeId('agent', call.agent),
          label: call.agent,
          kind: 'agent',
          relation: 'triggered_by',
          evidence: `${call.provider}/${call.model} · ${call.latencyMs}ms · ${call.status}`,
          at: call.createdAt.getTime(),
        });
      }

      const runs = await this.prisma.agentRun.findMany({
        where: { requestId },
        orderBy: { startedAt: 'asc' },
        take: 5,
        select: { runId: true },
      });
      for (const run of runs) {
        const transitions = await this.prisma.agentActivity.findMany({
          where: { runId: run.runId, state: 'sending' },
          orderBy: { createdAt: 'asc' },
          take: 30,
          select: { agent: true, peer: true, detail: true, createdAt: true },
        });
        for (const transition of transitions) {
          if (!transition.peer) continue;
          steps.push({
            nodeId: nodeId('agent', transition.peer),
            label: transition.peer,
            kind: 'agent',
            relation: 'calls',
            evidence: transition.detail ?? `${transition.agent} → ${transition.peer}`,
            at: transition.createdAt.getTime(),
          });
        }
      }
    }

    if (params.runId) {
      const intents = await this.prisma.executionIntent.findMany({
        where: { sentinelRunId: params.runId },
        orderBy: { decidedAt: 'asc' },
        take: 10,
        select: { id: true, contractSymbol: true, bias: true, status: true, decidedAt: true, outcome: { select: { id: true, result: true } } },
      });
      for (const intent of intents) {
        steps.push({
          nodeId: nodeId('decision', intent.id),
          label: `${intent.bias} ${intent.contractSymbol}`,
          kind: 'decision',
          relation: 'produces',
          evidence: `ExecutionIntent ${intent.status}`,
          at: intent.decidedAt.getTime(),
        });
        if (intent.outcome) {
          steps.push({
            nodeId: nodeId('outcome', intent.outcome.id),
            label: intent.outcome.result,
            kind: 'outcome',
            relation: 'validated_by',
            evidence: `ExecutionOutcome ${intent.outcome.result}`,
            at: null,
          });
        }
      }
    }

    // Consecutive duplicates happen legitimately (an agent called twice in a
    // row); collapsing them keeps the path readable without losing a hop.
    const collapsed = steps.filter((step, index) => index === 0 || step.nodeId !== steps[index - 1].nodeId);

    return {
      requestId,
      runId: params.runId ?? null,
      steps: collapsed,
      startedAt,
      finishedAt,
      status: collapsed.length === 0 ? 'partial' : status,
    };
  }

  /**
   * The most recent real request that produced a multi-hop path.
   *
   * The console uses this to demonstrate a live signal path without an
   * operator having to find a correlation id by hand. It picks the newest
   * `AiCallLog` row that carries a `requestId`, because that row is by
   * definition part of a path with at least a route and an agent in it.
   */
  async latestPath(): Promise<SignalPathDto | null> {
    const call = await this.prisma.aiCallLog.findFirst({
      where: { requestId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { requestId: true },
    });
    if (!call?.requestId) return null;
    return this.path({ requestId: call.requestId });
  }

  // ------------------------------------------------------------ slice + filter

  /**
   * Turn a chosen node set into a wire slice: its induced edges, the clusters
   * it touches, the totals it is a fragment of, and which of its nodes have
   * neighbours the caller has not been sent.
   */
  private slice(snapshot: GraphSnapshot, nodes: GraphNodeDto[], filter: GraphFilter): GraphSlice {
    const present = new Set(nodes.map((node) => node.id));
    const relations = filter.relations?.length ? new Set(filter.relations) : null;

    const edges: GraphEdgeDto[] = [];
    for (const edge of snapshot.edges.values()) {
      if (!present.has(edge.source) || !present.has(edge.target)) continue;
      if (relations && !relations.has(edge.relation)) continue;
      if (filter.minConfidence !== undefined && edge.confidence < filter.minConfidence) continue;
      if (filter.sinceHours !== undefined && edge.lastSeen !== undefined) {
        if (edge.lastSeen < Date.now() - filter.sinceHours * 3_600_000) continue;
      }
      edges.push(edge);
    }

    const truncated: string[] = [];
    for (const node of nodes) {
      const neighbours = snapshot.adjacency.get(node.id);
      if (!neighbours) continue;
      let hidden = 0;
      for (const neighbour of neighbours) if (!present.has(neighbour)) hidden += 1;
      if (hidden > 0) truncated.push(node.id);
    }

    return {
      nodes,
      edges,
      clusters: this.buildClusters(snapshot, nodes),
      totals: { nodes: snapshot.nodes.size, edges: snapshot.edges.size, clusters: GRAPH_DOMAINS.length },
      truncated,
      builtAt: snapshot.builtAt,
      cached: true,
      degraded: snapshot.degraded,
    };
  }

  private buildClusters(snapshot: GraphSnapshot, nodes: GraphNodeDto[]): GraphClusterDto[] {
    const byDomain = new Map<GraphDomain, GraphNodeDto[]>();
    for (const node of nodes) {
      const list = byDomain.get(node.domain) ?? [];
      list.push(node);
      byDomain.set(node.domain, list);
    }

    // Edge counts are computed over the FULL snapshot, not the slice: a
    // collapsed combo should report how connected the cluster really is, not
    // how much of it happens to be loaded.
    const edgeCount = new Map<GraphDomain, number>();
    for (const edge of snapshot.edges.values()) {
      const source = snapshot.nodes.get(edge.source);
      const target = snapshot.nodes.get(edge.target);
      if (!source || !target || source.domain !== target.domain) continue;
      edgeCount.set(source.domain, (edgeCount.get(source.domain) ?? 0) + 1);
    }
    const totalByDomain = new Map<GraphDomain, number>();
    for (const node of snapshot.nodes.values()) {
      totalByDomain.set(node.domain, (totalByDomain.get(node.domain) ?? 0) + 1);
    }

    return [...byDomain.entries()]
      .map(([domain, members]) => ({
        id: `cluster:${domain}`,
        domain,
        label: domain,
        nodeCount: totalByDomain.get(domain) ?? members.length,
        edgeCount: edgeCount.get(domain) ?? 0,
        activity: clamp01(members.reduce((sum, node) => sum + node.activity, 0) / Math.max(members.length, 1)),
        exemplars: members
          .slice()
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 5)
          .map((node) => node.id),
      }))
      .sort((a, b) => b.nodeCount - a.nodeCount);
  }

  private matches(node: GraphNodeDto, filter: GraphFilter): boolean {
    if (filter.domains?.length && !filter.domains.includes(node.domain)) return false;
    if (filter.kinds?.length && !filter.kinds.includes(node.kind)) return false;
    if (filter.maxTier !== undefined && node.tier > filter.maxTier) return false;
    if (filter.minConfidence !== undefined && node.confidence < filter.minConfidence) return false;
    if (filter.minImportance !== undefined && node.importance < filter.minImportance) return false;
    if (filter.minActivity !== undefined && node.activity < filter.minActivity) return false;
    if (filter.sinceHours !== undefined) {
      const cutoff = Date.now() - filter.sinceHours * 3_600_000;
      const seen = node.lastSeen ?? node.updatedAt ?? node.createdAt;
      // A node with no timestamp at all is structure (a module, a table). Time
      // filtering asks "what has been active lately", and structure has always
      // been there, so it is kept rather than being filtered into invisibility.
      if (seen !== undefined && seen < cutoff) return false;
    }
    if (filter.q) {
      const needle = filter.q.toLowerCase();
      if (!node.label.toLowerCase().includes(needle) && !(node.summary ?? '').toLowerCase().includes(needle)) return false;
    }
    return true;
  }

  /** Is there at least one edge between these two that the filter admits? */
  private edgeAllowed(snapshot: GraphSnapshot, a: string, b: string, filter: GraphFilter): boolean {
    if (!filter.relations?.length) return true;
    const allowed = new Set(filter.relations);
    for (const edgeKey of snapshot.incident.get(a) ?? []) {
      const edge = snapshot.edges.get(edgeKey);
      if (!edge) continue;
      if ((edge.source === a && edge.target === b) || (edge.source === b && edge.target === a)) {
        if (allowed.has(edge.relation)) return true;
      }
    }
    return false;
  }

  /**
   * Recent real events for one node, for the inspector's history panel.
   *
   * Only kinds with an actual event log get rows. Everything else returns an
   * empty list, which the console renders as "no event history for this kind"
   * rather than as an empty timeline that implies silence.
   */
  private async recentEvents(node: GraphNodeDto): Promise<Array<{ at: number; label: string; detail?: string; status?: string }>> {
    const parsed = parseNodeId(node.id);
    if (!parsed) return [];
    try {
      switch (parsed.kind) {
        case 'route': {
          const [method, ...rest] = parsed.key.split(' ');
          const path = rest.join(' ');
          const rows = await this.prisma.apiCallLog.findMany({
            where: { method, path },
            orderBy: { createdAt: 'desc' },
            take: 12,
            select: { statusCode: true, durationMs: true, createdAt: true, error: true, requestId: true },
          });
          return rows.map((row) => ({
            at: row.createdAt.getTime(),
            label: `${row.statusCode} · ${row.durationMs}ms`,
            detail: row.error ?? row.requestId,
            status: row.statusCode >= 500 ? 'error' : row.statusCode >= 400 ? 'warn' : 'ok',
          }));
        }
        case 'agent': {
          const rows = await this.prisma.aiCallLog.findMany({
            where: { agent: parsed.key },
            orderBy: { createdAt: 'desc' },
            take: 12,
            select: { provider: true, model: true, latencyMs: true, status: true, createdAt: true, error: true, requestId: true },
          });
          return rows.map((row) => ({
            at: row.createdAt.getTime(),
            label: `${row.provider}/${row.model} · ${row.latencyMs}ms`,
            detail: row.error ?? row.requestId ?? undefined,
            status: row.status === 'ok' ? 'ok' : 'error',
          }));
        }
        case 'perceptor': {
          const rows = await this.prisma.percept.findMany({
            where: { perceptorId: parsed.key },
            orderBy: { observedAt: 'desc' },
            take: 12,
            select: { summary: true, salience: true, observedAt: true, kind: true },
          });
          return rows.map((row) => ({
            at: row.observedAt.getTime(),
            label: row.summary || row.kind,
            detail: `salience ${row.salience.toFixed(2)}`,
            status: 'ok',
          }));
        }
        case 'concept': {
          const concept = await this.prisma.conceptNode.findUnique({ where: { conceptId: parsed.key }, select: { id: true } });
          if (!concept) return [];
          const rows = await this.prisma.conceptObservation.findMany({
            where: { conceptId: concept.id },
            orderBy: { observedAt: 'desc' },
            take: 12,
            select: { outcome: true, strength: true, symbol: true, observedAt: true },
          });
          return rows.map((row) => ({
            at: row.observedAt.getTime(),
            label: `${row.outcome}${row.symbol ? ` · ${row.symbol}` : ''}`,
            detail: `strength ${row.strength.toFixed(2)}`,
            status: row.outcome === 'refuted' ? 'warn' : 'ok',
          }));
        }
        case 'experiment': {
          const rows = await this.prisma.executionIntent.findMany({
            where: { profileId: parsed.key },
            orderBy: { decidedAt: 'desc' },
            take: 12,
            select: { contractSymbol: true, bias: true, status: true, decidedAt: true, rejectReason: true },
          });
          return rows.map((row) => ({
            at: row.decidedAt.getTime(),
            label: `${row.bias} ${row.contractSymbol}`,
            detail: row.rejectReason ?? row.status,
            status: row.rejectReason ? 'warn' : 'ok',
          }));
        }
        case 'finding':
        case 'deployment': {
          const rows = await this.prisma.auditEvent.findMany({
            where: { eventType: parsed.key },
            orderBy: { createdAt: 'desc' },
            take: 12,
            select: { createdAt: true, ip: true, eventType: true },
          });
          // No user id, no email, no user agent — see addSecurity's note.
          return rows.map((row) => ({ at: row.createdAt.getTime(), label: row.eventType, detail: row.ip ?? undefined, status: 'ok' }));
        }
        default:
          return [];
      }
    } catch (err) {
      this.logger.debug(`event history unavailable for ${node.id}: ${String(err)}`);
      return [];
    }
  }
}
