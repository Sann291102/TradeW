import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { CognitionService } from '../cognition/cognition.service';
import { TopologyService } from './topology.service';
import {
  clamp01,
  edgeId,
  GraphDomain,
  GraphEdgeDto,
  GraphNodeDto,
  NODE_KIND_DOMAIN,
  NodeGlyph,
  NodeKind,
  nodeId,
  recency,
  RelationType,
  saturate,
} from './graph.types';

/**
 * Builds one snapshot of the whole system graph from every real source the
 * platform has, and nothing else.
 *
 * ## The shape of a build
 *
 * Sources are added in dependency order — structure first, then the traffic
 * that flows over it, then the knowledge derived from that traffic — because
 * an edge may only be drawn between nodes that already exist. `link()` is the
 * single chokepoint that enforces it: an edge naming a node nobody added is
 * dropped rather than conjuring a placeholder, which is what stops one bad
 * join from filling the canvas with grey unknowns.
 *
 * ## Every source is optional, and its absence is reported
 *
 * A build runs against a database that may be unreachable, a vault that may
 * not be mounted, and a cognition network that may be switched off. Each
 * source is wrapped in `safe()`: a failure names the source in
 * `snapshot.degraded` and the build continues. The console renders that list.
 * Between "the market cluster is empty because nothing happened" and "the
 * market cluster is empty because the query threw", only the second is a
 * problem — and an operator cannot act on the difference unless it is shown.
 *
 * ## Bounded by construction
 *
 * Every query has a `take`. The backend graph is allowed to be large; a single
 * snapshot is not allowed to be unbounded, because it lives in the API's heap
 * next to order matching. The per-source caps below are the ceiling on that,
 * and the console never receives a whole snapshot anyway — it asks for
 * neighbourhoods (`graph.service.ts`).
 */

/** Per-source row ceilings. Deliberately generous for the things that carry
 *  meaning (concepts, synapses) and tight for the things that are merely
 *  numerous (percepts, audit rows). */
const CAP = {
  routes: 400,
  concepts: 400,
  conceptEdges: 1200,
  memories: 200,
  memoryRelations: 400,
  notes: 400,
  synapses: 900,
  percepts: 300,
  episodes: 60,
  proposals: 80,
  observations: 150,
  intents: 120,
  entities: 250,
  entityEdges: 500,
  instruments: 120,
  research: 80,
  strategies: 80,
  audit: 200,
  aiJoin: 400,
} as const;

/** Half-lives used for `activity`. One per rhythm, named rather than inlined:
 *  a route is busy on a scale of minutes, a concept on a scale of days. */
const HALF_LIFE = {
  traffic: 10 * 60_000, // routes, agents, AI calls
  run: 30 * 60_000, // agent runs, episodes, percepts
  learning: 12 * 3_600_000, // synapses, concept observations
  knowledge: 3 * 86_400_000, // notes, memories, concepts
  slow: 7 * 86_400_000, // instruments, research, tables
} as const;

export interface GraphSnapshot {
  nodes: Map<string, GraphNodeDto>;
  edges: Map<string, GraphEdgeDto>;
  /** node id → neighbour node ids. Undirected: expansion is symmetric. */
  adjacency: Map<string, Set<string>>;
  /** node id → edge ids touching it. */
  incident: Map<string, Set<string>>;
  builtAt: number;
  degraded: string[];
  /** How long the build took, surfaced so a slow source is visible. */
  buildMs: number;
}

@Injectable()
export class GraphProjectionService {
  private readonly logger = new Logger(GraphProjectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly topology: TopologyService,
    private readonly knowledge: KnowledgeService,
    private readonly cognition: CognitionService,
  ) {}

  async build(): Promise<GraphSnapshot> {
    const startedAt = Date.now();
    const ctx = new BuildContext(startedAt);

    // Structure first — everything below links into it.
    await this.safe(ctx, 'workspace', () => this.addWorkspace(ctx));
    this.safe(ctx, 'nest-container', () => this.addNestTopology(ctx));
    this.safe(ctx, 'prisma-schema', () => this.addTables(ctx));
    this.safe(ctx, 'external-sources', () => this.addExternalSources(ctx));
    await this.safe(ctx, 'agents', () => this.addAgents(ctx));
    this.safe(ctx, 'cognition-registry', () => this.addCognitionRegistry(ctx));

    // Traffic over the structure.
    await this.safe(ctx, 'api-traffic', () => this.addRouteTraffic(ctx));
    await this.safe(ctx, 'ai-traffic', () => this.addAiTraffic(ctx));
    await this.safe(ctx, 'agent-runs', () => this.addAgentRuns(ctx));
    await this.safe(ctx, 'background-jobs', () => this.addJobs(ctx));

    // Knowledge derived from that traffic.
    await this.safe(ctx, 'concepts', () => this.addConcepts(ctx));
    await this.safe(ctx, 'memories', () => this.addMemories(ctx));
    this.safe(ctx, 'vault', () => this.addVault(ctx));
    await this.safe(ctx, 'cognition-runtime', () => this.addCognitionRuntime(ctx));
    await this.safe(ctx, 'entity-graph', () => this.addEntityGraph(ctx));
    await this.safe(ctx, 'market', () => this.addMarket(ctx));
    await this.safe(ctx, 'research', () => this.addResearch(ctx));
    await this.safe(ctx, 'execution', () => this.addExecution(ctx));
    await this.safe(ctx, 'sentinel-observations', () => this.addObservations(ctx));
    await this.safe(ctx, 'security', () => this.addSecurity(ctx));

    const snapshot = ctx.finalize();
    snapshot.buildMs = Date.now() - startedAt;
    this.logger.log(
      `graph snapshot: ${snapshot.nodes.size} nodes, ${snapshot.edges.size} edges in ${snapshot.buildMs}ms` +
        (snapshot.degraded.length ? ` (degraded: ${snapshot.degraded.join(', ')})` : ''),
    );
    return snapshot;
  }

  /** Run one source; on failure name it in `degraded` and keep building. */
  private safe<T>(ctx: BuildContext, source: string, fn: () => T): T | undefined;
  private safe<T>(ctx: BuildContext, source: string, fn: () => Promise<T>): Promise<T | undefined>;
  private safe(ctx: BuildContext, source: string, fn: () => unknown): unknown {
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.catch((err: unknown) => {
          ctx.degrade(source);
          this.logger.warn(`graph source "${source}" failed: ${String(err)}`);
          return undefined;
        });
      }
      return result;
    } catch (err) {
      ctx.degrade(source);
      this.logger.warn(`graph source "${source}" failed: ${String(err)}`);
      return undefined;
    }
  }

  // ======================================================== application layer

  private async addWorkspace(ctx: BuildContext): Promise<void> {
    const units = await this.topology.workspace();
    for (const unit of units) {
      const kind: NodeKind = unit.kind;
      ctx.node({
        id: nodeId(kind, unit.name),
        kind,
        label: unit.name,
        summary: unit.description,
        source: 'code',
        // A workspace unit is as real as it gets: it is the thing that booted.
        confidence: 1,
        // Apps and services are structural anchors; packages are supporting
        // detail, so they start lower and rise only if things depend on them.
        importance: unit.kind === 'package' ? 0.35 : 0.6,
        activity: 0,
        cluster: `cluster:application`,
        detail: { packageName: unit.packageName, kind: unit.kind, dependsOn: unit.dependsOn },
      });
    }
    // Real dependency edges, read from each package.json.
    for (const unit of units) {
      for (const dep of unit.dependsOn) {
        const target = units.find((candidate) => candidate.name === dep);
        if (!target) continue;
        ctx.link(nodeId(unit.kind, unit.name), 'depends_on', nodeId(target.kind, target.name), {
          strength: 0.6,
          confidence: 1,
          evidence: `${unit.packageName} declares ${target.packageName} in dependencies`,
        });
      }
    }
  }

  private addNestTopology(ctx: BuildContext): void {
    const modules = this.topology.nestModules();
    const controllers = this.topology.controllers();
    const routes = this.topology.routes();

    for (const module of modules) {
      ctx.node({
        id: nodeId('module', module.name),
        kind: 'module',
        label: module.name.replace(/Module$/, ''),
        summary: `${module.controllers.length} controller(s), ${module.providerCount} provider(s)`,
        source: 'code',
        confidence: 1,
        importance: 0.4,
        activity: 0,
        cluster: 'cluster:application',
        detail: { providers: module.providerCount, imports: module.imports },
      });
      ctx.link(nodeId('module', module.name), 'part_of', nodeId('service', module.service), {
        strength: 0.8,
        confidence: 1,
        evidence: 'resolved inside the services/api Nest container',
      });
    }
    for (const module of modules) {
      for (const imported of module.imports) {
        ctx.link(nodeId('module', module.name), 'depends_on', nodeId('module', imported), {
          strength: 0.5,
          confidence: 1,
          evidence: `${module.name} imports ${imported}`,
        });
      }
    }

    for (const controller of controllers) {
      ctx.node({
        id: nodeId('controller', controller.name),
        kind: 'controller',
        label: controller.name.replace(/Controller$/, ''),
        summary: `${controller.basePath} — ${controller.routeCount} route(s)`,
        source: 'code',
        confidence: 1,
        importance: 0.35,
        activity: 0,
        cluster: 'cluster:application',
        detail: { basePath: controller.basePath, routes: controller.routeCount },
      });
      ctx.link(nodeId('controller', controller.name), 'part_of', nodeId('module', controller.module), {
        strength: 0.9,
        confidence: 1,
        evidence: `${controller.module} declares ${controller.name}`,
      });
    }

    for (const route of routes.slice(0, CAP.routes)) {
      const id = routeNodeId(route.method, route.path);
      ctx.node({
        id,
        kind: 'route',
        label: `${route.method} ${route.path}`,
        summary: `${route.controller}.${route.handler}()`,
        source: 'code',
        status: route.auth === 'public' ? 'public' : 'guarded',
        confidence: 1,
        // Routes start small: importance is earned by traffic, not by existing.
        importance: 0.12,
        activity: 0,
        cluster: 'cluster:application',
        detail: {
          method: route.method,
          path: route.path,
          controller: route.controller,
          handler: route.handler,
          module: route.module,
          service: route.service,
          authentication: route.auth,
          authorization: route.capability ?? (route.auth === 'admin' ? 'operator + product admin' : null),
          guards: route.guards,
          // Filled in by addRouteTraffic when telemetry has seen this route.
          requests: 0,
          errors: 0,
        },
        glyphs: route.auth === 'public' ? [{ key: 'open', value: '', tone: 'warn', title: 'No guard — reachable unauthenticated' }] : [],
      });
      ctx.link(id, 'exposed_by', nodeId('controller', route.controller), {
        strength: 0.9,
        confidence: 1,
        evidence: `${route.controller}.${route.handler}() carries ${route.method} ${route.path}`,
      });
      if (route.capability) {
        // The capability is a real gate, and naming it on the graph is how an
        // operator finds every route a plan change would affect.
        ctx.node({
          id: nodeId('strategy', `capability/${route.capability}`),
          kind: 'strategy',
          label: `capability: ${route.capability}`,
          source: 'code',
          confidence: 1,
          importance: 0.3,
          activity: 0,
          cluster: 'cluster:security',
          detail: { capability: route.capability },
        });
        ctx.link(id, 'depends_on', nodeId('strategy', `capability/${route.capability}`), {
          strength: 0.7,
          confidence: 1,
          evidence: `@RequiresCapability('${route.capability}')`,
        });
      }
    }
  }

  private addTables(ctx: BuildContext): void {
    const tables = this.topology.tables();
    const present = new Set(tables.map((table) => table.name));
    for (const table of tables) {
      ctx.node({
        id: nodeId('table', table.name),
        kind: 'table',
        label: table.name,
        summary: `${table.fieldCount} fields, ${table.relations.length} relation(s)`,
        source: 'code',
        confidence: 1,
        importance: 0.2 + saturate(table.relations.length, 6) * 0.3,
        activity: 0,
        cluster: 'cluster:infrastructure',
        detail: { fields: table.fieldCount, keyFields: table.keyFields, relations: table.relations.map((r) => r.to) },
      });
      ctx.link(nodeId('table', table.name), 'part_of', nodeId('package', 'database'), {
        strength: 0.8,
        confidence: 1,
        evidence: 'declared in packages/database/prisma/schema.prisma',
      });
    }
    for (const table of tables) {
      for (const relation of table.relations) {
        if (!present.has(relation.to)) continue;
        // A relation field and its back-reference are the same edge read from
        // two ends; `link` dedupes on (source, relation, target), and the pair
        // is normalised by sorting so both directions collapse into one.
        const [a, b] = [table.name, relation.to].sort();
        ctx.link(nodeId('table', a), 'related_to', nodeId('table', b), {
          strength: relation.list ? 0.5 : 0.35,
          confidence: 1,
          evidence: `Prisma relation ${table.name}.${relation.field} → ${relation.to}`,
        });
      }
    }
  }

  private addExternalSources(ctx: BuildContext): void {
    for (const source of this.topology.externalSources()) {
      ctx.node({
        id: nodeId('source', source.id),
        kind: 'source',
        label: source.label,
        summary: source.configured ? `configured (${source.kind})` : `not configured — ${source.kind} integration is dormant`,
        source: 'code',
        status: source.configured ? 'configured' : 'idle',
        // An unconfigured provider is drawn, faintly, because "this integration
        // exists and is switched off" is itself the operational fact.
        confidence: source.configured ? 1 : 0.4,
        importance: source.configured ? 0.45 : 0.15,
        activity: 0,
        cluster: 'cluster:market',
        detail: { kind: source.kind, configuredVia: source.env, configured: source.configured },
      });
    }
  }

  private async addAgents(ctx: BuildContext): Promise<void> {
    for (const agent of await this.topology.agents()) {
      ctx.node({
        id: nodeId('agent', agent.name),
        kind: 'agent',
        label: agent.name,
        summary: agent.description,
        source: 'code',
        confidence: 1,
        importance: agent.name === 'orchestrator' ? 0.75 : 0.5,
        activity: 0,
        cluster: 'cluster:ai',
        detail: {
          system: agent.system,
          tier: agent.tier,
          guardrails: agent.guardrails,
          allowedTools: agent.allowedTools,
          calls24h: 0,
          costUsd24h: 0,
        },
      });
      // `sentinel` and `tradew-ai` are real services in the workspace, so the
      // agent's home is a link and not a label.
      ctx.link(nodeId('agent', agent.name), 'part_of', nodeId('service', agent.system), {
        strength: 0.8,
        confidence: 1,
        evidence: `agents/${agent.system}/definitions.json`,
      });
    }
  }

  private addCognitionRegistry(ctx: BuildContext): void {
    const snapshot = this.cognition.snapshot();
    const perceptors = this.cognition.perceptors();

    for (const layer of snapshot.layers) {
      ctx.node({
        id: nodeId('layer', layer.id),
        kind: 'layer',
        label: layer.label,
        summary: layer.description,
        source: 'code',
        status: snapshot.enabled ? 'running' : 'idle',
        confidence: 1,
        importance: 0.8,
        activity: snapshot.enabled ? clamp01(saturate(layer.outputs, 40)) : 0,
        cluster: 'cluster:cognition',
        detail: {
          index: layer.index,
          passes: layer.passes,
          inputs: layer.inputs,
          outputs: layer.outputs,
          ratio: layer.ratio,
        },
        glyphs: [{ key: 'out', value: String(layer.outputs), tone: layer.outputs > 0 ? 'good' : 'idle', title: `${layer.outputs} outputs this process` }],
      });
    }
    // The stack is a real pipeline: L1's output IS L2's input.
    const ordered = [...snapshot.layers].sort((a, b) => a.index - b.index);
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      ctx.link(nodeId('layer', ordered[i].id), 'produces', nodeId('layer', ordered[i + 1].id), {
        strength: 0.9,
        confidence: 1,
        activity: snapshot.enabled ? clamp01(saturate(ordered[i].outputs, 40)) : 0,
        evidence: `${ordered[i].outputs} outputs became ${ordered[i + 1].id} inputs`,
      });
    }

    for (const perceptor of perceptors) {
      const health = perceptor.health;
      const lastAt = health?.lastPerceptAt ? new Date(health.lastPerceptAt).getTime() : null;
      ctx.node({
        id: nodeId('perceptor', perceptor.id),
        kind: 'perceptor',
        label: perceptor.label,
        summary: perceptor.description,
        source: 'code',
        status: perceptor.enabled ? (health?.status ?? 'healthy') : 'disabled',
        confidence: 1,
        importance: 0.3 + saturate(health?.totalPercepts ?? 0, 200) * 0.4,
        activity: recency(lastAt, HALF_LIFE.run, ctx.now),
        lastSeen: lastAt ?? undefined,
        cluster: 'cluster:cognition',
        detail: {
          domain: perceptor.domain,
          cadence: perceptor.cadence,
          expectedIntervalMs: perceptor.expectedIntervalMs,
          emits: perceptor.emits,
          enabled: perceptor.enabled,
          status: health?.status ?? null,
          totalPercepts: health?.totalPercepts ?? 0,
          meanSalience: health?.meanSalience ?? 0,
          consecutiveFailures: health?.consecutiveFailures ?? 0,
          lastError: health?.lastError ?? null,
        },
        glyphs: [
          { key: 'n', value: String(health?.totalPercepts ?? 0), tone: 'info', title: 'percepts observed' },
          ...(health?.consecutiveFailures
            ? [{ key: 'fail', value: String(health.consecutiveFailures), tone: 'bad' as const, title: `${health.consecutiveFailures} consecutive failures` }]
            : []),
        ],
      });
      // Every percept a perceptor emits enters the network at L1.
      const l1 = ordered[0];
      if (l1) {
        ctx.link(nodeId('perceptor', perceptor.id), 'produces', nodeId('layer', l1.id), {
          strength: 0.4 + saturate(health?.totalPercepts ?? 0, 200) * 0.5,
          confidence: perceptor.enabled ? 1 : 0.3,
          activity: recency(lastAt, HALF_LIFE.run, ctx.now),
          state: health?.status === 'failing' || health?.status === 'quarantined' ? 'warning' : 'normal',
          lastSeen: lastAt ?? undefined,
          observations: health?.totalPercepts ?? 0,
          evidence: `${health?.totalPercepts ?? 0} percepts recorded by ${perceptor.id}`,
        });
      }
    }
  }

  // ============================================================ runtime traffic

  /**
   * Route traffic: request counts, error counts, latency and last activity,
   * grouped over `ApiCallLog` by the same route template the interceptor logs.
   *
   * This is what turns the route layer from a directory listing into a heat
   * map — and it is also the join that makes a route node comparable to an
   * agent node, since both end up with a real `activity` derived from when
   * they last did something.
   */
  private async addRouteTraffic(ctx: BuildContext): Promise<void> {
    const since = new Date(ctx.now - 24 * 3_600_000);
    const rows = await this.prisma.apiCallLog.groupBy({
      by: ['method', 'path'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _avg: { durationMs: true },
      _max: { createdAt: true },
      orderBy: { _count: { path: 'desc' } },
      take: CAP.routes,
    });
    const errorRows = await this.prisma.apiCallLog.groupBy({
      by: ['method', 'path'],
      where: { createdAt: { gte: since }, statusCode: { gte: 400 } },
      _count: { _all: true },
      orderBy: { _count: { path: 'desc' } },
      take: CAP.routes,
    });
    const errorsBy = new Map(errorRows.map((row) => [`${row.method} ${row.path}`, row._count._all]));

    for (const row of rows) {
      const id = routeNodeId(row.method, row.path);
      const requests = row._count._all;
      const errors = errorsBy.get(`${row.method} ${row.path}`) ?? 0;
      const lastAt = row._max.createdAt ? row._max.createdAt.getTime() : null;
      const errorRate = requests ? errors / requests : 0;

      const existing = ctx.get(id);
      if (!existing) {
        // Traffic for a route this build of the code does not declare. That is
        // a real and interesting thing — a route that was removed, or one
        // served by a different replica — so it is kept, marked as coming from
        // the database rather than from code, and never silently dropped.
        ctx.node({
          id,
          kind: 'route',
          label: `${row.method} ${row.path}`,
          summary: 'observed in telemetry; not declared by this build',
          source: 'database',
          status: 'retired',
          confidence: 0.5,
          importance: 0.1,
          activity: recency(lastAt, HALF_LIFE.traffic, ctx.now),
          lastSeen: lastAt ?? undefined,
          cluster: 'cluster:application',
          detail: { method: row.method, path: row.path, requests, errors },
        });
        continue;
      }

      existing.activity = recency(lastAt, HALF_LIFE.traffic, ctx.now);
      existing.lastSeen = lastAt ?? undefined;
      existing.importance = clamp01(existing.importance + saturate(requests, 120) * 0.6);
      existing.status = errorRate > 0.2 ? 'failing' : errorRate > 0.02 ? 'degraded' : 'healthy';
      Object.assign(existing.detail ?? {}, {
        requests,
        errors,
        errorRate: Number(errorRate.toFixed(4)),
        avgLatencyMs: row._avg.durationMs ? Math.round(row._avg.durationMs) : null,
        window: '24h',
      });
      existing.glyphs = [
        ...(existing.glyphs ?? []),
        { key: 'req', value: compact(requests), tone: 'info', title: `${requests} requests in 24h` },
        ...(errors > 0 ? [{ key: 'err', value: compact(errors), tone: errorRate > 0.02 ? ('bad' as const) : ('warn' as const), title: `${errors} errors in 24h` }] : []),
      ];

      // An erroring route is a real error node — grouped by route, because a
      // list of 4,000 individual failures is not something anyone investigates.
      if (errors > 0) {
        const errId = nodeId('error', `${row.method} ${row.path}`);
        ctx.node({
          id: errId,
          kind: 'error',
          label: `${errors} error(s) · ${row.path}`,
          summary: `${(errorRate * 100).toFixed(1)}% of ${requests} requests failed in 24h`,
          source: 'database',
          status: errorRate > 0.2 ? 'failing' : 'degraded',
          confidence: 1,
          importance: 0.2 + saturate(errors, 25) * 0.5,
          activity: recency(lastAt, HALF_LIFE.traffic, ctx.now),
          lastSeen: lastAt ?? undefined,
          cluster: 'cluster:security',
          detail: { method: row.method, path: row.path, errors, requests, errorRate },
        });
        ctx.link(errId, 'observed_by', id, {
          strength: clamp01(errorRate * 2),
          confidence: 1,
          activity: recency(lastAt, HALF_LIFE.traffic, ctx.now),
          state: 'warning',
          observations: errors,
          evidence: `${errors} ApiCallLog rows with status ≥ 400 in 24h`,
        });
      }
    }
  }

  /**
   * AI traffic, and the join that makes the signal path real.
   *
   * `AiCallLog.requestId` correlates back to the `ApiCallLog` row that caused
   * the call, which is the only place in this platform where "an HTTP request
   * reached this agent" is recorded as fact rather than inferred from a naming
   * convention. Reconstructing that join here is what lets the console draw
   *
   *     POST /sentinel/observe → SentinelController → orchestrator → market-technical
   *
   * from evidence instead of from a diagram someone drew once.
   */
  private async addAiTraffic(ctx: BuildContext): Promise<void> {
    const since = new Date(ctx.now - 24 * 3_600_000);

    const byAgent = await this.prisma.aiCallLog.groupBy({
      by: ['system', 'agent', 'provider', 'model'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { costUsd: true, promptTokens: true, completionTokens: true },
      _avg: { latencyMs: true },
      _max: { createdAt: true },
      orderBy: { _count: { agent: 'desc' } },
      take: 200,
    });

    for (const row of byAgent) {
      const agentId = nodeId('agent', row.agent);
      const lastAt = row._max.createdAt?.getTime() ?? null;
      const activity = recency(lastAt, HALF_LIFE.traffic, ctx.now);

      if (!ctx.get(agentId)) {
        // An agent that ran but is not in definitions.json — a real drift, and
        // one worth seeing rather than hiding.
        ctx.node({
          id: agentId,
          kind: 'agent',
          label: row.agent,
          summary: 'observed in AI telemetry; not present in the agent definitions',
          source: 'database',
          status: 'undeclared',
          confidence: 0.6,
          importance: 0.3,
          activity,
          lastSeen: lastAt ?? undefined,
          cluster: 'cluster:ai',
          detail: { system: row.system },
        });
      }
      const agent = ctx.get(agentId)!;
      agent.activity = Math.max(agent.activity, activity);
      agent.lastSeen = maxTime(agent.lastSeen, lastAt);
      agent.importance = clamp01(agent.importance + saturate(row._count._all, 80) * 0.3);
      const detail = (agent.detail ??= {});
      detail.calls24h = (Number(detail.calls24h) || 0) + row._count._all;
      detail.costUsd24h = Number((((Number(detail.costUsd24h) || 0) + (row._sum.costUsd ?? 0))).toFixed(4));
      detail.promptTokens24h = (Number(detail.promptTokens24h) || 0) + (row._sum.promptTokens ?? 0);
      detail.completionTokens24h = (Number(detail.completionTokens24h) || 0) + (row._sum.completionTokens ?? 0);
      detail.avgLatencyMs = row._avg.latencyMs ? Math.round(row._avg.latencyMs) : detail.avgLatencyMs ?? null;
      agent.glyphs = [{ key: 'calls', value: compact(Number(detail.calls24h)), tone: 'info', title: `${detail.calls24h} LLM calls in 24h` }];

      // The model the agent actually reached for — a real `uses` edge, and the
      // node that makes "which surfaces would a provider outage take down"
      // answerable by looking at one node's neighbourhood.
      const modelId = nodeId('model', `${row.provider}/${row.model}`);
      ctx.node({
        id: modelId,
        kind: 'model',
        label: row.model,
        summary: `${row.provider} · ${compact(row._count._all)} calls in 24h`,
        source: 'database',
        confidence: 1,
        importance: 0.25 + saturate(row._count._all, 150) * 0.4,
        activity,
        lastSeen: lastAt ?? undefined,
        cluster: 'cluster:ai',
        detail: {
          provider: row.provider,
          model: row.model,
          calls24h: row._count._all,
          costUsd24h: Number((row._sum.costUsd ?? 0).toFixed(4)),
          avgLatencyMs: row._avg.latencyMs ? Math.round(row._avg.latencyMs) : null,
        },
      });
      ctx.link(agentId, 'uses', modelId, {
        strength: saturate(row._count._all, 60),
        confidence: 1,
        activity,
        lastSeen: lastAt ?? undefined,
        observations: row._count._all,
        evidence: `${row._count._all} AiCallLog rows in 24h`,
      });

      // The provider is an external source already on the graph when it is
      // configured; link the model to it so an outage traces outward.
      const providerId = nodeId('source', row.provider.toLowerCase());
      if (ctx.get(providerId)) {
        ctx.link(modelId, 'depends_on', providerId, {
          strength: 0.8,
          confidence: 1,
          activity,
          evidence: `AiCallLog.provider = ${row.provider}`,
        });
      }
    }

    // ---- the request → agent join -----------------------------------------
    const correlated = await this.prisma.aiCallLog.findMany({
      where: { createdAt: { gte: since }, requestId: { not: null } },
      select: { requestId: true, agent: true, system: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: CAP.aiJoin,
    });
    const requestIds = [...new Set(correlated.map((row) => row.requestId).filter((id): id is string => Boolean(id)))];
    if (requestIds.length === 0) return;

    const apiRows = await this.prisma.apiCallLog.findMany({
      where: { requestId: { in: requestIds.slice(0, CAP.aiJoin) } },
      select: { requestId: true, method: true, path: true, createdAt: true },
      take: CAP.aiJoin,
    });
    const routeOf = new Map(apiRows.map((row) => [row.requestId, row]));

    // Aggregate the join so a busy route and a busy agent produce ONE edge
    // whose strength is the count, not 400 identical edges.
    const pairs = new Map<string, { route: string; agent: string; count: number; lastAt: number }>();
    for (const call of correlated) {
      const api = call.requestId ? routeOf.get(call.requestId) : undefined;
      if (!api) continue;
      const routeId = routeNodeId(api.method, api.path);
      const agentId = nodeId('agent', call.agent);
      if (!ctx.get(routeId) || !ctx.get(agentId)) continue;
      const key = `${routeId}→${agentId}`;
      const entry = pairs.get(key) ?? { route: routeId, agent: agentId, count: 0, lastAt: 0 };
      entry.count += 1;
      entry.lastAt = Math.max(entry.lastAt, call.createdAt.getTime());
      pairs.set(key, entry);
    }
    for (const pair of pairs.values()) {
      ctx.link(pair.agent, 'triggered_by', pair.route, {
        strength: saturate(pair.count, 20),
        confidence: 1,
        activity: recency(pair.lastAt, HALF_LIFE.traffic, ctx.now),
        lastSeen: pair.lastAt,
        observations: pair.count,
        evidence: `${pair.count} AI calls correlated to this route by requestId`,
      });
    }
  }

  /**
   * Agent-to-agent topology, from the transitions the orchestrator actually
   * recorded. `AgentActivity.peer` is directional by design (see the model's
   * own comment), so `sending` rows give a real `calls` edge with a direction.
   */
  private async addAgentRuns(ctx: BuildContext): Promise<void> {
    const since = new Date(ctx.now - 24 * 3_600_000);
    const hops = await this.prisma.agentActivity.groupBy({
      by: ['agent', 'peer', 'system'],
      where: { createdAt: { gte: since }, peer: { not: null }, state: 'sending' },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _count: { agent: 'desc' } },
      take: 200,
    });
    for (const hop of hops) {
      if (!hop.peer) continue;
      const from = nodeId('agent', hop.agent);
      const to = nodeId('agent', hop.peer);
      for (const [id, name] of [
        [from, hop.agent],
        [to, hop.peer],
      ] as const) {
        if (ctx.get(id)) continue;
        ctx.node({
          id,
          kind: 'agent',
          label: name,
          summary: 'seen in agent activity; not present in the agent definitions',
          source: 'database',
          status: 'undeclared',
          confidence: 0.6,
          importance: 0.25,
          activity: 0,
          cluster: 'cluster:ai',
          detail: { system: hop.system },
        });
      }
      const lastAt = hop._max.createdAt?.getTime() ?? null;
      ctx.link(from, 'calls', to, {
        strength: saturate(hop._count._all, 40),
        confidence: 1,
        activity: recency(lastAt, HALF_LIFE.run, ctx.now),
        lastSeen: lastAt ?? undefined,
        observations: hop._count._all,
        evidence: `${hop._count._all} 'sending' transitions in 24h`,
      });
    }

    const errored = await this.prisma.agentActivity.groupBy({
      by: ['agent'],
      where: { createdAt: { gte: since }, state: 'error' },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _count: { agent: 'desc' } },
      take: 50,
    });
    for (const row of errored) {
      const agent = ctx.get(nodeId('agent', row.agent));
      if (!agent) continue;
      agent.status = 'degraded';
      agent.glyphs = [...(agent.glyphs ?? []), { key: 'err', value: compact(row._count._all), tone: 'bad', title: `${row._count._all} error transitions in 24h` }];
      (agent.detail ??= {}).errors24h = row._count._all;
    }
  }

  private async addJobs(ctx: BuildContext): Promise<void> {
    const leases = await this.prisma.jobLease.findMany({ take: 50, orderBy: { renewedAt: 'desc' } });
    for (const lease of leases) {
      const held = lease.expiresAt.getTime() > ctx.now;
      ctx.node({
        id: nodeId('job', lease.name),
        kind: 'job',
        label: lease.name,
        summary: held ? 'lease held — this loop is running somewhere' : 'lease expired — no instance holds this loop',
        source: 'database',
        status: held ? 'running' : 'idle',
        confidence: 1,
        importance: 0.4,
        activity: recency(lease.renewedAt.getTime(), HALF_LIFE.traffic, ctx.now),
        lastSeen: lease.renewedAt.getTime(),
        cluster: 'cluster:infrastructure',
        detail: {
          holder: lease.holder,
          expiresAt: lease.expiresAt.toISOString(),
          renewedAt: lease.renewedAt.toISOString(),
          acquiredAt: lease.acquiredAt.toISOString(),
          held,
        },
      });
      ctx.link(nodeId('job', lease.name), 'part_of', nodeId('service', 'api'), {
        strength: 0.6,
        confidence: 1,
        evidence: 'leader-elected loop registered in services/api',
      });
    }
  }

  // ============================================================ knowledge layer

  /**
   * The concept ontology — the reasoning graph Sentinel actually reasons over.
   *
   * `ConceptEdge.relation` is already a closed vocabulary upstream (see
   * `brain/ontology/relations.ts`), so it is MAPPED into this graph's
   * vocabulary rather than passed through: an unmapped relation would be an
   * edge the console cannot style or filter, which is the same as an edge
   * nobody can read.
   *
   * Learned weight beats the canonical prior when one exists, because the
   * canonical value is what an author guessed and the learned value is what
   * observation produced.
   */
  private async addConcepts(ctx: BuildContext): Promise<void> {
    const concepts = await this.prisma.conceptNode.findMany({
      orderBy: [{ observationCount: 'desc' }, { confidence: 'desc' }],
      take: CAP.concepts,
      select: {
        id: true, conceptId: true, domain: true, name: true, status: true, maturity: true,
        confidence: true, summary: true, origin: true, tags: true, supersedes: true, supersededBy: true,
        observationCount: true, lastObservedAt: true, createdAt: true, updatedAt: true,
      },
    });
    const bySlug = new Map(concepts.map((concept) => [concept.conceptId, concept]));
    const byRowId = new Map(concepts.map((concept) => [concept.id, concept]));

    for (const concept of concepts) {
      const lastAt = concept.lastObservedAt?.getTime() ?? null;
      ctx.node({
        id: nodeId('concept', concept.conceptId),
        kind: 'concept',
        label: concept.name,
        summary: concept.summary,
        source: 'database',
        status: concept.status === 'canonical' ? (concept.maturity ?? 'established') : concept.status,
        confidence: clamp01(concept.confidence),
        importance: 0.25 + saturate(concept.observationCount, 12) * 0.55,
        activity: recency(lastAt, HALF_LIFE.learning, ctx.now),
        lastSeen: lastAt ?? undefined,
        createdAt: concept.createdAt.getTime(),
        updatedAt: concept.updatedAt.getTime(),
        cluster: `cluster:knowledge`,
        detail: {
          conceptId: concept.conceptId,
          conceptDomain: concept.domain,
          status: concept.status,
          maturity: concept.maturity,
          origin: concept.origin,
          tags: concept.tags,
          observations: concept.observationCount,
        },
        glyphs: [
          ...(concept.observationCount ? [{ key: 'obs', value: compact(concept.observationCount), tone: 'good' as const, title: `${concept.observationCount} observations` }] : []),
          ...(concept.origin === 'learned' ? [{ key: 'new', value: '', tone: 'info' as const, title: 'proposed at runtime, not authored' }] : []),
        ],
      });

      // `supersedes` is a plain slug reference upstream (deliberately not a FK),
      // so it resolves here only when the successor has actually been authored.
      if (concept.supersedes && bySlug.has(concept.supersedes)) {
        ctx.link(nodeId('concept', concept.conceptId), 'supersedes', nodeId('concept', concept.supersedes), {
          strength: 0.8,
          confidence: 0.9,
          evidence: 'ConceptNode.supersedes',
        });
      }
    }

    const edges = await this.prisma.conceptEdge.findMany({
      orderBy: [{ supportCount: 'desc' }],
      take: CAP.conceptEdges,
      select: {
        fromId: true, toId: true, relation: true, weight: true, learnedWeight: true,
        supportCount: true, refuteCount: true, lastObservedAt: true, confidence: true,
        origin: true, status: true, note: true,
      },
    });
    for (const edge of edges) {
      const from = byRowId.get(edge.fromId);
      const to = byRowId.get(edge.toId);
      if (!from || !to) continue; // one end fell outside the cap — not an error
      const relation = mapConceptRelation(edge.relation);
      const weight = edge.learnedWeight ?? edge.weight;
      const lastAt = edge.lastObservedAt?.getTime() ?? null;
      const contradicted = edge.refuteCount > edge.supportCount && edge.refuteCount > 0;
      ctx.link(nodeId('concept', from.conceptId), relation, nodeId('concept', to.conceptId), {
        strength: clamp01(weight),
        confidence: clamp01(edge.confidence),
        activity: recency(lastAt, HALF_LIFE.learning, ctx.now),
        lastSeen: lastAt ?? undefined,
        state: relation === 'contradicts' || contradicted ? 'contradiction' : 'normal',
        observations: edge.supportCount + edge.refuteCount,
        evidence:
          edge.supportCount + edge.refuteCount > 0
            ? `${edge.supportCount} supporting / ${edge.refuteCount} refuting observations`
            : `${edge.origin} prior (${edge.relation}), no runtime observations yet`,
      });
    }

    // Learning events — the append-only log of the ontology meeting reality.
    const observations = await this.prisma.conceptObservation.findMany({
      orderBy: { observedAt: 'desc' },
      take: CAP.observations,
      select: { id: true, conceptId: true, outcome: true, strength: true, symbol: true, observedAt: true },
    });
    for (const observation of observations) {
      const concept = byRowId.get(observation.conceptId);
      if (!concept) continue;
      const id = nodeId('learning', observation.id);
      ctx.node({
        id,
        kind: 'learning',
        label: `${observation.outcome} · ${concept.name}`,
        summary: observation.symbol ? `observed on ${observation.symbol}` : 'observed without a symbol',
        source: 'database',
        status: observation.outcome,
        confidence: clamp01(observation.strength),
        importance: 0.12,
        activity: recency(observation.observedAt.getTime(), HALF_LIFE.learning, ctx.now),
        lastSeen: observation.observedAt.getTime(),
        createdAt: observation.observedAt.getTime(),
        cluster: 'cluster:knowledge',
        detail: { outcome: observation.outcome, strength: observation.strength, symbol: observation.symbol },
      });
      ctx.link(nodeId('concept', concept.conceptId), 'learned_from', id, {
        strength: clamp01(observation.strength),
        confidence: 0.9,
        activity: recency(observation.observedAt.getTime(), HALF_LIFE.learning, ctx.now),
        lastSeen: observation.observedAt.getTime(),
        state: observation.outcome === 'refuted' ? 'contradiction' : 'normal',
        evidence: `ConceptObservation ${observation.outcome}`,
      });
      if (observation.symbol) {
        const symbolId = nodeId('entity', observation.symbol);
        if (ctx.get(symbolId)) {
          ctx.link(id, 'observed_by', symbolId, { strength: 0.3, confidence: 0.8, evidence: 'observation carried this symbol' });
        }
      }
    }
  }

  private async addMemories(ctx: BuildContext): Promise<void> {
    const memories = await this.prisma.memoryRecord.findMany({
      orderBy: { createdAt: 'desc' },
      take: CAP.memories,
      select: {
        id: true, summary: true, sourceKind: true, sourceProvider: true, confidence: true,
        tags: true, namespace: true, createdAt: true, updatedAt: true, staleAfter: true,
      },
    });
    const known = new Set(memories.map((memory) => memory.id));
    for (const memory of memories) {
      const stale = memory.staleAfter ? memory.staleAfter.getTime() < ctx.now : false;
      ctx.node({
        id: nodeId('memory', memory.id),
        kind: 'memory',
        label: memory.summary.slice(0, 90),
        summary: `${memory.sourceKind}${memory.sourceProvider ? ` · ${memory.sourceProvider}` : ''}`,
        source: 'database',
        status: stale ? 'stale' : 'active',
        confidence: clamp01(memory.confidence),
        importance: 0.15,
        activity: recency(memory.updatedAt.getTime(), HALF_LIFE.knowledge, ctx.now),
        lastSeen: memory.updatedAt.getTime(),
        createdAt: memory.createdAt.getTime(),
        updatedAt: memory.updatedAt.getTime(),
        cluster: 'cluster:knowledge',
        detail: {
          sourceKind: memory.sourceKind,
          sourceProvider: memory.sourceProvider,
          namespace: memory.namespace,
          tags: memory.tags,
          stale,
        },
      });
    }

    const relations = await this.prisma.memoryRelation.findMany({
      where: { fromId: { in: [...known] } },
      take: CAP.memoryRelations,
      select: { fromId: true, toId: true, relation: true, createdAt: true },
    });
    for (const relation of relations) {
      if (!known.has(relation.toId)) continue;
      ctx.link(nodeId('memory', relation.fromId), mapMemoryRelation(relation.relation), nodeId('memory', relation.toId), {
        strength: 0.5,
        confidence: 0.7,
        lastSeen: relation.createdAt.getTime(),
        evidence: `MemoryRelation "${relation.relation}"`,
      });
    }
  }

  /**
   * The engineering vault — the same markdown link graph the old Knowledge
   * Graph page drew on its own, now one cluster inside the whole picture
   * instead of the entire picture.
   */
  private addVault(ctx: BuildContext): void {
    if (!this.knowledge.isStarted) return; // the workspace toggle is off
    const vault = this.knowledge.graph();
    const nodes = vault.nodes.slice(0, CAP.notes);
    const kept = new Set(nodes.map((node) => node.id));
    const recentByPath = new Map(this.knowledge.recent(CAP.notes).map((item) => [item.path, item]));

    for (const node of nodes) {
      const meta = recentByPath.get(node.id);
      ctx.node({
        id: nodeId('note', node.id),
        kind: 'note',
        label: node.label,
        summary: node.group,
        source: 'vault',
        confidence: 1,
        importance: 0.15 + saturate(node.degree, 6) * 0.45,
        activity: recency(meta?.modified ?? null, HALF_LIFE.knowledge, ctx.now),
        lastSeen: meta?.modified,
        createdAt: meta?.created,
        updatedAt: meta?.modified,
        cluster: 'cluster:knowledge',
        detail: { path: node.id, folder: node.group, links: node.degree, tags: meta?.tags ?? [] },
      });
    }
    for (const edge of vault.edges) {
      if (!kept.has(edge.source) || !kept.has(edge.target)) continue;
      ctx.link(nodeId('note', edge.source), 'related_to', nodeId('note', edge.target), {
        strength: 0.4,
        confidence: 0.9,
        evidence: 'markdown link in the vault',
      });
    }
  }

  /**
   * The cognition runtime: episodes, the percepts that fed them, the proposals
   * they produced, and the learned synapses that connect the whole thing.
   *
   * Synapses are the densest and most valuable edges on the graph, because
   * their endpoints are already namespaced (`percept:…`, `concept:…`,
   * `agent:…`) in exactly the way this graph's ids are. Resolving them is a
   * lookup rather than a guess.
   */
  private async addCognitionRuntime(ctx: BuildContext): Promise<void> {
    const since = new Date(ctx.now - 24 * 3_600_000);

    const episodes = await this.prisma.cognitiveEpisode.findMany({
      where: { startedAt: { gte: since } },
      orderBy: { startedAt: 'desc' },
      take: CAP.episodes,
      select: {
        episodeId: true, domain: true, trigger: true, status: true, perceptCount: true,
        promotedCount: true, proposalCount: true, reward: true, startedAt: true, finishedAt: true,
      },
    });
    for (const episode of episodes) {
      ctx.node({
        id: nodeId('episode', episode.episodeId),
        kind: 'episode',
        label: `${episode.trigger} · ${episode.domain ?? 'all'}`,
        summary: `${episode.perceptCount} percepts → ${episode.promotedCount} promoted → ${episode.proposalCount} proposals`,
        source: 'database',
        status: episode.status,
        // An unscored episode is a claim with no verdict yet, and the graph
        // says so by holding its confidence below a scored one's.
        confidence: episode.reward === null ? 0.5 : clamp01(episode.reward),
        importance: 0.15 + saturate(episode.perceptCount, 20) * 0.3,
        activity: recency(episode.startedAt.getTime(), HALF_LIFE.run, ctx.now),
        lastSeen: episode.startedAt.getTime(),
        createdAt: episode.startedAt.getTime(),
        cluster: 'cluster:cognition',
        detail: {
          trigger: episode.trigger,
          domain: episode.domain,
          status: episode.status,
          percepts: episode.perceptCount,
          promoted: episode.promotedCount,
          proposals: episode.proposalCount,
          reward: episode.reward,
          durationMs: episode.finishedAt ? episode.finishedAt.getTime() - episode.startedAt.getTime() : null,
        },
      });
    }
    const episodeIds = new Set(episodes.map((episode) => episode.episodeId));

    const proposals = await this.prisma.cognitiveProposal.findMany({
      orderBy: { createdAt: 'desc' },
      take: CAP.proposals,
      select: { id: true, episodeId: true, domain: true, kind: true, title: true, confidence: true, status: true, createdAt: true },
    });
    for (const proposal of proposals) {
      const id = nodeId('proposal', proposal.id);
      ctx.node({
        id,
        kind: 'proposal',
        label: proposal.title,
        summary: `${proposal.kind} · ${proposal.domain}`,
        source: 'database',
        status: proposal.status,
        confidence: clamp01(proposal.confidence),
        importance: 0.3 + (proposal.status === 'pending' ? 0.2 : 0),
        activity: recency(proposal.createdAt.getTime(), HALF_LIFE.run, ctx.now),
        lastSeen: proposal.createdAt.getTime(),
        createdAt: proposal.createdAt.getTime(),
        cluster: 'cluster:cognition',
        detail: { kind: proposal.kind, domain: proposal.domain, status: proposal.status },
      });
      if (episodeIds.has(proposal.episodeId)) {
        ctx.link(id, 'derived_from', nodeId('episode', proposal.episodeId), {
          strength: clamp01(proposal.confidence),
          confidence: clamp01(proposal.confidence),
          lastSeen: proposal.createdAt.getTime(),
          evidence: 'CognitiveProposal.episodeId',
        });
      }
    }

    // Percept subjects become `signal` nodes — the actual things the network
    // perceived, aggregated by subject so a hot subject is one node.
    const percepts = await this.prisma.percept.groupBy({
      by: ['perceptorId', 'domain', 'kind', 'subjectType', 'subjectId'],
      where: { observedAt: { gte: since } },
      _count: { _all: true },
      _avg: { salience: true, confidence: true },
      _max: { observedAt: true },
      orderBy: { _count: { subjectId: 'desc' } },
      take: CAP.percepts,
    });
    for (const percept of percepts) {
      const id = nodeId('signal', `${percept.subjectType}/${percept.subjectId}`);
      const lastAt = percept._max.observedAt?.getTime() ?? null;
      const existing = ctx.get(id);
      const count = percept._count._all;
      if (existing) {
        existing.importance = clamp01(existing.importance + saturate(count, 20) * 0.2);
        existing.activity = Math.max(existing.activity, recency(lastAt, HALF_LIFE.run, ctx.now));
        existing.lastSeen = maxTime(existing.lastSeen, lastAt);
      } else {
        ctx.node({
          id,
          kind: 'signal',
          label: percept.subjectId,
          summary: `${percept.subjectType} · ${percept.kind}`,
          source: 'database',
          confidence: clamp01(percept._avg.confidence ?? 0.5),
          importance: 0.1 + saturate(count, 20) * 0.35,
          activity: recency(lastAt, HALF_LIFE.run, ctx.now),
          lastSeen: lastAt ?? undefined,
          cluster: 'cluster:cognition',
          detail: {
            subjectType: percept.subjectType,
            subjectId: percept.subjectId,
            perceptDomain: percept.domain,
            occurrences: count,
            meanSalience: Number((percept._avg.salience ?? 0).toFixed(3)),
          },
          glyphs: [{ key: 'n', value: compact(count), tone: 'info', title: `${count} percepts in 24h` }],
        });
      }
      const perceptorId = nodeId('perceptor', percept.perceptorId);
      if (ctx.get(perceptorId)) {
        ctx.link(perceptorId, 'observed_by', id, {
          strength: saturate(count, 15),
          confidence: clamp01(percept._avg.confidence ?? 0.5),
          activity: recency(lastAt, HALF_LIFE.run, ctx.now),
          lastSeen: lastAt ?? undefined,
          observations: count,
          evidence: `${count} percepts of ${percept.kind} in 24h`,
        });
      }
    }

    // ---- learned synapses --------------------------------------------------
    const synapses = await this.prisma.neuralSynapse.findMany({
      orderBy: [{ weight: 'desc' }],
      take: CAP.synapses,
      select: {
        layer: true, source: true, target: true, weight: true, activations: true,
        reinforcements: true, meanReward: true, lastActivatedAt: true,
      },
    });
    for (const synapse of synapses) {
      const from = this.resolveSynapseEndpoint(ctx, synapse.source);
      const to = this.resolveSynapseEndpoint(ctx, synapse.target);
      if (!from || !to || from === to) continue;
      const lastAt = synapse.lastActivatedAt?.getTime() ?? null;
      ctx.link(from, 'learned_from', to, {
        strength: clamp01(synapse.weight),
        // A synapse no outcome has ever scored is a guess, and the graph must
        // not present a guess at the same opacity as a proven association.
        confidence: synapse.reinforcements > 0 ? clamp01(0.5 + synapse.meanReward * 0.5) : 0.3,
        activity: recency(lastAt, HALF_LIFE.learning, ctx.now),
        lastSeen: lastAt ?? undefined,
        observations: synapse.activations,
        state: synapse.reinforcements > 0 && synapse.meanReward < 0.3 ? 'contradiction' : 'normal',
        evidence:
          synapse.reinforcements > 0
            ? `${synapse.layer}: weight ${synapse.weight.toFixed(2)} from ${synapse.reinforcements} scored outcome(s)`
            : `${synapse.layer}: weight ${synapse.weight.toFixed(2)}, never scored`,
      });
    }
  }

  /**
   * Resolve a synapse endpoint string onto a node that already exists.
   *
   * The network's own namespaces (`concept:`, `agent:`, `percept:`) are the
   * same names this graph uses, so most endpoints resolve directly. A
   * `percept:<perceptorId>/<kind>` endpoint resolves to its PERCEPTOR — the
   * signature is a feature of that sensor, and collapsing it there is what
   * makes the neural view show sensors wired to concepts rather than a fog of
   * one-off signature nodes. An endpoint that resolves to nothing is dropped;
   * inventing a node for it would be exactly the fabrication this file forbids.
   */
  private resolveSynapseEndpoint(ctx: BuildContext, endpoint: string): string | null {
    const at = endpoint.indexOf(':');
    if (at <= 0) return null;
    const namespace = endpoint.slice(0, at);
    const rest = endpoint.slice(at + 1);

    if (namespace === 'concept') {
      const id = nodeId('concept', rest);
      return ctx.get(id) ? id : null;
    }
    if (namespace === 'agent') {
      const id = nodeId('agent', rest);
      return ctx.get(id) ? id : null;
    }
    if (namespace === 'percept') {
      const perceptorId = rest.split('/')[0];
      const id = nodeId('perceptor', perceptorId);
      return ctx.get(id) ? id : null;
    }
    if (namespace === 'episode') {
      const id = nodeId('episode', rest);
      return ctx.get(id) ? id : null;
    }
    // The entity graph's own namespaces (`symbol:`, `sector:`, `pattern:` …).
    const entityId = nodeId('entity', endpoint);
    return ctx.get(entityId) ? entityId : null;
  }

  // ============================================================== market layer

  private async addEntityGraph(ctx: BuildContext): Promise<void> {
    const nodes = await this.prisma.graphNode.findMany({
      orderBy: { updatedAt: 'desc' },
      take: CAP.entities,
      select: { id: true, entityType: true, entityId: true, label: true, createdAt: true, updatedAt: true },
    });
    const byRowId = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      ctx.node({
        id: nodeId('entity', node.entityId),
        kind: 'entity',
        label: node.label ?? node.entityId,
        summary: node.entityType,
        source: 'database',
        confidence: 0.9,
        importance: 0.2,
        activity: recency(node.updatedAt.getTime(), HALF_LIFE.knowledge, ctx.now),
        lastSeen: node.updatedAt.getTime(),
        createdAt: node.createdAt.getTime(),
        updatedAt: node.updatedAt.getTime(),
        cluster: 'cluster:market',
        detail: { entityType: node.entityType, entityId: node.entityId },
      });
    }

    const edges = await this.prisma.graphEdge.findMany({
      orderBy: { weight: 'desc' },
      take: CAP.entityEdges,
      select: { fromId: true, toId: true, relation: true, weight: true, createdAt: true },
    });
    for (const edge of edges) {
      const from = byRowId.get(edge.fromId);
      const to = byRowId.get(edge.toId);
      if (!from || !to) continue;
      ctx.link(nodeId('entity', from.entityId), mapEntityRelation(edge.relation), nodeId('entity', to.entityId), {
        strength: clamp01(edge.weight),
        confidence: 0.75,
        lastSeen: edge.createdAt.getTime(),
        evidence: `GraphEdge "${edge.relation}" (weight ${edge.weight.toFixed(2)})`,
      });
    }
  }

  private async addMarket(ctx: BuildContext): Promise<void> {
    // Only instruments the platform is actually carrying data for. An inactive
    // row in a 90,000-row instrument master is not a market entity this system
    // has any relationship with.
    const instruments = await this.prisma.instrument.findMany({
      where: { active: true },
      orderBy: { updatedAt: 'desc' },
      take: CAP.instruments,
      select: { id: true, symbol: true, displayName: true, type: true, exchange: true, underlying: true, updatedAt: true },
    });
    for (const instrument of instruments) {
      const id = nodeId('instrument', instrument.symbol);
      ctx.node({
        id,
        kind: 'instrument',
        label: instrument.symbol,
        summary: `${instrument.displayName} · ${instrument.exchange}`,
        source: 'database',
        confidence: 1,
        importance: 0.2,
        activity: recency(instrument.updatedAt.getTime(), HALF_LIFE.slow, ctx.now),
        lastSeen: instrument.updatedAt.getTime(),
        updatedAt: instrument.updatedAt.getTime(),
        cluster: 'cluster:market',
        detail: { symbol: instrument.symbol, type: instrument.type, exchange: instrument.exchange, underlying: instrument.underlying },
      });
      // An option's underlying is a real structural relationship, not a naming
      // coincidence — it is the column the instrument master carries.
      if (instrument.underlying) {
        const underlyingId = nodeId('instrument', instrument.underlying);
        if (ctx.get(underlyingId)) {
          ctx.link(id, 'derived_from', underlyingId, { strength: 0.7, confidence: 1, evidence: 'Instrument.underlying' });
        }
      }
      // Bridge to the entity graph, where one exists for the same symbol.
      const entityId = nodeId('entity', instrument.symbol);
      if (ctx.get(entityId)) {
        ctx.link(id, 'related_to', entityId, { strength: 0.5, confidence: 0.9, evidence: 'same symbol in the entity graph' });
      }
    }

    const news = await this.prisma.newsEvent.groupBy({
      by: ['source'],
      where: { publishedAt: { gte: new Date(ctx.now - 7 * 86_400_000) } },
      _count: { _all: true },
      _max: { publishedAt: true },
      orderBy: { _count: { source: 'desc' } },
      take: 20,
    });
    for (const row of news) {
      const id = nodeId('source', `news/${row.source}`);
      ctx.node({
        id,
        kind: 'source',
        label: row.source,
        summary: `${row._count._all} news events in 7d`,
        source: 'database',
        status: 'configured',
        confidence: 1,
        importance: 0.2 + saturate(row._count._all, 40) * 0.3,
        activity: recency(row._max.publishedAt?.getTime() ?? null, HALF_LIFE.knowledge, ctx.now),
        lastSeen: row._max.publishedAt?.getTime(),
        cluster: 'cluster:market',
        detail: { kind: 'news', events7d: row._count._all },
      });
    }
  }

  private async addResearch(ctx: BuildContext): Promise<void> {
    const companies = await this.prisma.researchCompany.findMany({
      orderBy: { fetchedAt: 'desc' },
      take: CAP.research,
      select: { id: true, symbol: true, name: true, exchange: true, sector: true, industry: true, source: true, fetchedAt: true, updatedAt: true },
    });
    for (const company of companies) {
      const id = nodeId('research', company.symbol);
      ctx.node({
        id,
        kind: 'research',
        label: company.name,
        summary: `${company.symbol} · ${company.sector ?? 'sector unknown'}`,
        source: 'database',
        confidence: 1,
        importance: 0.25,
        activity: recency(company.fetchedAt.getTime(), HALF_LIFE.slow, ctx.now),
        lastSeen: company.fetchedAt.getTime(),
        updatedAt: company.updatedAt.getTime(),
        cluster: 'cluster:research',
        detail: {
          symbol: company.symbol,
          exchange: company.exchange,
          sector: company.sector,
          industry: company.industry,
          vendor: company.source,
          fetchedAt: company.fetchedAt.toISOString(),
        },
      });
      const instrumentId = nodeId('instrument', company.symbol);
      if (ctx.get(instrumentId)) {
        ctx.link(instrumentId, 'researched_by', id, { strength: 0.6, confidence: 1, evidence: 'ResearchCompany for the same symbol' });
      }
      const sourceId = nodeId('source', company.source.toLowerCase());
      if (ctx.get(sourceId)) {
        ctx.link(id, 'derived_from', sourceId, { strength: 0.5, confidence: 1, evidence: `ResearchCompany.source = ${company.source}` });
      }
    }

    // Strategies users actually authored. Grouped by name: the graph shows
    // which strategies exist and how widely they are used, never whose they are.
    const strategies = await this.prisma.userStrategy.groupBy({
      by: ['name', 'status', 'inputType'],
      _count: { _all: true },
      _max: { updatedAt: true },
      orderBy: { _count: { name: 'desc' } },
      take: CAP.strategies,
    });
    for (const strategy of strategies) {
      ctx.node({
        id: nodeId('strategy', strategy.name),
        kind: 'strategy',
        label: strategy.name,
        summary: `${strategy._count._all} author(s) · ${strategy.inputType}`,
        source: 'database',
        status: strategy.status,
        confidence: 0.9,
        importance: 0.2 + saturate(strategy._count._all, 5) * 0.3,
        activity: recency(strategy._max.updatedAt?.getTime() ?? null, HALF_LIFE.knowledge, ctx.now),
        lastSeen: strategy._max.updatedAt?.getTime(),
        cluster: 'cluster:research',
        detail: { status: strategy.status, inputType: strategy.inputType, authors: strategy._count._all },
      });
    }
  }

  /**
   * The execution loop — the only place this platform runs an experiment with
   * a real, scored outcome.
   *
   * A profile is a standing hypothesis ("this agent, on this symbol, under
   * this policy"); an intent is one decision it made; an outcome is the
   * verdict. `validated_by` is therefore literal here, not a metaphor.
   */
  private async addExecution(ctx: BuildContext): Promise<void> {
    const profiles = await this.prisma.executionProfile.findMany({
      take: 60,
      select: {
        id: true, name: true, agent: true, symbol: true, strategyName: true, environment: true,
        enabled: true, accountScope: true, minConfidence: true, createdAt: true, updatedAt: true,
        _count: { select: { intents: true } },
      },
    });
    for (const profile of profiles) {
      const id = nodeId('experiment', profile.id);
      ctx.node({
        id,
        kind: 'experiment',
        label: profile.name,
        summary: `${profile.agent} on ${profile.symbol} · ${profile.environment}`,
        source: 'database',
        status: profile.enabled ? 'armed' : 'disarmed',
        confidence: 1,
        importance: profile.enabled ? 0.6 : 0.3,
        activity: recency(profile.updatedAt.getTime(), HALF_LIFE.run, ctx.now),
        lastSeen: profile.updatedAt.getTime(),
        createdAt: profile.createdAt.getTime(),
        updatedAt: profile.updatedAt.getTime(),
        cluster: 'cluster:execution',
        detail: {
          agent: profile.agent,
          symbol: profile.symbol,
          strategy: profile.strategyName,
          environment: profile.environment,
          accountScope: profile.accountScope,
          minConfidence: profile.minConfidence,
          enabled: profile.enabled,
          intents: profile._count.intents,
        },
        glyphs: profile.enabled ? [{ key: 'armed', value: '', tone: 'warn', title: 'Armed — this profile may place orders' }] : [],
      });
      const agentId = nodeId('agent', profile.agent);
      if (ctx.get(agentId)) {
        ctx.link(id, 'implemented_by', agentId, { strength: 0.8, confidence: 1, evidence: 'ExecutionProfile.agent' });
      }
      const instrumentId = nodeId('instrument', profile.symbol);
      if (ctx.get(instrumentId)) {
        ctx.link(id, 'uses', instrumentId, { strength: 0.6, confidence: 1, evidence: 'ExecutionProfile.symbol' });
      }
      if (profile.strategyName && ctx.get(nodeId('strategy', profile.strategyName))) {
        ctx.link(id, 'uses', nodeId('strategy', profile.strategyName), { strength: 0.6, confidence: 1, evidence: 'ExecutionProfile.strategyName' });
      }
    }

    const intents = await this.prisma.executionIntent.findMany({
      orderBy: { decidedAt: 'desc' },
      take: CAP.intents,
      select: {
        id: true, profileId: true, agent: true, symbol: true, contractSymbol: true, bias: true,
        status: true, confidence: true, decidedAt: true, rejectReason: true, sentinelRunId: true,
        outcome: { select: { id: true, result: true, realizedPnl: true, exitReason: true, holdingSeconds: true, exitAt: true } },
      },
    });
    for (const intent of intents) {
      const id = nodeId('decision', intent.id);
      ctx.node({
        id,
        kind: 'decision',
        label: `${intent.bias} ${intent.contractSymbol}`,
        summary: intent.rejectReason ? `rejected — ${intent.rejectReason}` : `${intent.status} · confidence ${intent.confidence}`,
        source: 'database',
        status: intent.status,
        confidence: clamp01(intent.confidence / 100),
        importance: 0.2,
        activity: recency(intent.decidedAt.getTime(), HALF_LIFE.run, ctx.now),
        lastSeen: intent.decidedAt.getTime(),
        createdAt: intent.decidedAt.getTime(),
        cluster: 'cluster:execution',
        detail: {
          agent: intent.agent,
          symbol: intent.symbol,
          contract: intent.contractSymbol,
          bias: intent.bias,
          status: intent.status,
          confidence: intent.confidence,
          rejectReason: intent.rejectReason,
          sentinelRunId: intent.sentinelRunId,
        },
      });
      if (ctx.get(nodeId('experiment', intent.profileId))) {
        ctx.link(nodeId('experiment', intent.profileId), 'produces', id, {
          strength: 0.6,
          confidence: 1,
          activity: recency(intent.decidedAt.getTime(), HALF_LIFE.run, ctx.now),
          lastSeen: intent.decidedAt.getTime(),
          evidence: 'ExecutionIntent.profileId',
        });
      }

      if (intent.outcome) {
        const outcomeId = nodeId('outcome', intent.outcome.id);
        const pnl = Number(intent.outcome.realizedPnl);
        ctx.node({
          id: outcomeId,
          kind: 'outcome',
          label: `${intent.outcome.result} · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
          summary: intent.outcome.exitReason,
          source: 'database',
          status: intent.outcome.result,
          confidence: 1,
          importance: 0.25,
          activity: recency(intent.outcome.exitAt?.getTime() ?? null, HALF_LIFE.run, ctx.now),
          lastSeen: intent.outcome.exitAt?.getTime(),
          cluster: 'cluster:execution',
          detail: {
            result: intent.outcome.result,
            realizedPnl: pnl,
            exitReason: intent.outcome.exitReason,
            holdingSeconds: intent.outcome.holdingSeconds,
          },
        });
        ctx.link(id, 'validated_by', outcomeId, {
          strength: 0.9,
          confidence: 1,
          // A losing outcome is the graph's own contradiction signal: the
          // decision claimed one thing and reality answered another.
          state: intent.outcome.result === 'loss' ? 'contradiction' : 'normal',
          lastSeen: intent.outcome.exitAt?.getTime(),
          evidence: `ExecutionOutcome ${intent.outcome.result}`,
        });
      }
    }
  }

  private async addObservations(ctx: BuildContext): Promise<void> {
    const rows = await this.prisma.sentinelObservation.groupBy({
      by: ['agent', 'category', 'symbol'],
      where: { createdAt: { gte: new Date(ctx.now - 7 * 86_400_000) } },
      _count: { _all: true },
      _avg: { confidence: true },
      _max: { createdAt: true },
      orderBy: { _count: { agent: 'desc' } },
      take: CAP.observations,
    });
    for (const row of rows) {
      const key = `${row.agent}/${row.category}${row.symbol ? `/${row.symbol}` : ''}`;
      const id = nodeId('observation', key);
      const lastAt = row._max.createdAt?.getTime() ?? null;
      ctx.node({
        id,
        kind: 'observation',
        label: `${row.category}${row.symbol ? ` · ${row.symbol}` : ''}`,
        summary: `${row._count._all} observation(s) by ${row.agent} in 7d`,
        source: 'database',
        confidence: clamp01(row._avg.confidence ?? 0.5),
        importance: 0.15 + saturate(row._count._all, 20) * 0.3,
        activity: recency(lastAt, HALF_LIFE.run, ctx.now),
        lastSeen: lastAt ?? undefined,
        cluster: 'cluster:execution',
        detail: { agent: row.agent, category: row.category, symbol: row.symbol, count7d: row._count._all },
      });
      const agentId = nodeId('agent', row.agent);
      if (ctx.get(agentId)) {
        ctx.link(agentId, 'produces', id, {
          strength: saturate(row._count._all, 15),
          confidence: clamp01(row._avg.confidence ?? 0.5),
          activity: recency(lastAt, HALF_LIFE.run, ctx.now),
          lastSeen: lastAt ?? undefined,
          observations: row._count._all,
          evidence: `${row._count._all} SentinelObservation rows in 7d`,
        });
      }
      if (row.symbol && ctx.get(nodeId('instrument', row.symbol))) {
        ctx.link(id, 'observed_by', nodeId('instrument', row.symbol), { strength: 0.4, confidence: 0.9, evidence: 'SentinelObservation.symbol' });
      }
    }
  }

  /**
   * The security surface: audited events, and the operators who can cause them.
   *
   * Grouped by event type, never per person. This graph is rendered on a screen
   * that gets screenshotted into tickets; a node per operator with their email
   * on it would put an identity into every one of those screenshots for no
   * analytical gain. The count is the finding; the identity lives in the audit
   * table, behind the audit page, which is the right place to look it up.
   */
  private async addSecurity(ctx: BuildContext): Promise<void> {
    const since = new Date(ctx.now - 7 * 86_400_000);
    const events = await this.prisma.auditEvent.groupBy({
      by: ['eventType'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _count: { eventType: 'desc' } },
      take: CAP.audit,
    });
    for (const event of events) {
      const security = isSecurityEvent(event.eventType);
      const deployment = isDeploymentEvent(event.eventType);
      const kind: NodeKind = deployment ? 'deployment' : 'finding';
      const lastAt = event._max.createdAt?.getTime() ?? null;
      ctx.node({
        id: nodeId(kind, event.eventType),
        kind,
        label: event.eventType,
        summary: `${event._count._all} event(s) in 7d`,
        source: 'database',
        status: security ? 'security' : 'audit',
        confidence: 1,
        importance: (security ? 0.35 : 0.15) + saturate(event._count._all, 30) * 0.3,
        activity: recency(lastAt, HALF_LIFE.run, ctx.now),
        lastSeen: lastAt ?? undefined,
        cluster: deployment ? 'cluster:infrastructure' : 'cluster:security',
        detail: { eventType: event.eventType, count7d: event._count._all, securityRelevant: security },
        glyphs: [{ key: 'n', value: compact(event._count._all), tone: security ? 'warn' : 'info', title: `${event._count._all} in 7d` }],
      });
    }

    const operators = await this.prisma.operatorAccount.count();
    if (operators > 0) {
      ctx.node({
        id: nodeId('operator', 'console'),
        kind: 'operator',
        label: `${operators} operator account(s)`,
        summary: 'the admin console identity store — no person is named on this graph',
        source: 'database',
        confidence: 1,
        importance: 0.4,
        activity: 0,
        cluster: 'cluster:security',
        detail: { accounts: operators },
      });
      // Every operator-gated route is reachable by exactly this population.
      for (const route of this.topology.routes()) {
        if (route.auth !== 'admin' && route.auth !== 'operator') continue;
        const routeId = routeNodeId(route.method, route.path);
        if (!ctx.get(routeId)) continue;
        ctx.link(nodeId('operator', 'console'), 'uses', routeId, {
          strength: 0.25,
          confidence: 1,
          evidence: `guarded by ${route.guards.join(' + ')}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BuildContext — the one place nodes and edges are created
// ---------------------------------------------------------------------------

interface NodeInput extends Omit<GraphNodeDto, 'domain' | 'tier' | 'degree'> {
  domain?: GraphDomain;
}

interface LinkOptions {
  strength?: number;
  confidence?: number;
  activity?: number;
  state?: GraphEdgeDto['state'];
  lastSeen?: number;
  observations?: number;
  evidence?: string;
}

/**
 * Accumulates one snapshot.
 *
 * Two invariants live here rather than in the twenty call sites above:
 *
 *  1. **An edge cannot invent a node.** `link` silently drops an edge whose
 *     endpoints are not both present. Sources are ordered so this only ever
 *     drops edges into data that fell outside a cap.
 *  2. **A node is written once, then merged.** Two sources legitimately
 *     describe the same node (a route from code and its traffic from
 *     telemetry). The first write establishes it; later writes may raise
 *     importance and activity but never lower confidence below what a more
 *     authoritative source already claimed.
 */
class BuildContext {
  readonly nodes = new Map<string, GraphNodeDto>();
  readonly edges = new Map<string, GraphEdgeDto>();
  readonly degraded: string[] = [];

  constructor(readonly now: number) {}

  degrade(source: string): void {
    if (!this.degraded.includes(source)) this.degraded.push(source);
  }

  get(id: string): GraphNodeDto | undefined {
    return this.nodes.get(id);
  }

  node(input: NodeInput): GraphNodeDto {
    const existing = this.nodes.get(input.id);
    if (existing) {
      existing.importance = Math.max(existing.importance, input.importance);
      existing.activity = Math.max(existing.activity, input.activity);
      existing.lastSeen = maxTime(existing.lastSeen, input.lastSeen ?? null);
      if (input.summary && !existing.summary) existing.summary = input.summary;
      if (input.detail) existing.detail = { ...(existing.detail ?? {}), ...input.detail };
      if (input.glyphs?.length) existing.glyphs = [...(existing.glyphs ?? []), ...input.glyphs];
      return existing;
    }
    const created: GraphNodeDto = {
      ...input,
      domain: input.domain ?? NODE_KIND_DOMAIN[input.kind],
      importance: clamp01(input.importance),
      activity: clamp01(input.activity),
      confidence: clamp01(input.confidence),
      // Both computed in finalize() once the whole graph is known.
      tier: 2,
      degree: 0,
    };
    this.nodes.set(input.id, created);
    return created;
  }

  link(source: string, relation: RelationType, target: string, options: LinkOptions = {}): GraphEdgeDto | null {
    if (source === target) return null;
    if (!this.nodes.has(source) || !this.nodes.has(target)) return null;
    const id = edgeId(source, relation, target);
    const existing = this.edges.get(id);
    if (existing) {
      existing.strength = Math.max(existing.strength, clamp01(options.strength ?? 0.4));
      existing.activity = Math.max(existing.activity, clamp01(options.activity ?? 0));
      existing.lastSeen = maxTime(existing.lastSeen, options.lastSeen ?? null);
      if (options.observations) existing.observations = (existing.observations ?? 0) + options.observations;
      if (options.state && options.state !== 'normal') existing.state = options.state;
      return existing;
    }
    const edge: GraphEdgeDto = {
      id,
      source,
      target,
      relation,
      strength: clamp01(options.strength ?? 0.4),
      confidence: clamp01(options.confidence ?? 0.7),
      activity: clamp01(options.activity ?? 0),
      state: options.state ?? 'normal',
      lastSeen: options.lastSeen,
      observations: options.observations,
      evidence: options.evidence,
    };
    this.edges.set(id, edge);
    return edge;
  }

  /**
   * Close the snapshot: compute degree, fold degree into importance, assign
   * semantic-zoom tiers and build the adjacency indexes the console's
   * neighbourhood queries walk.
   *
   * Importance is deliberately a BLEND rather than pure centrality. Pure
   * centrality makes `service:api` the biggest node on every graph forever,
   * which is true and useless; pure declared weight ignores that a route
   * serving 40,000 requests matters more than one serving four. The blend
   * keeps both facts visible.
   */
  finalize(): GraphSnapshot {
    const adjacency = new Map<string, Set<string>>();
    const incident = new Map<string, Set<string>>();
    for (const id of this.nodes.keys()) {
      adjacency.set(id, new Set());
      incident.set(id, new Set());
    }
    for (const edge of this.edges.values()) {
      adjacency.get(edge.source)!.add(edge.target);
      adjacency.get(edge.target)!.add(edge.source);
      incident.get(edge.source)!.add(edge.id);
      incident.get(edge.target)!.add(edge.id);
    }

    for (const node of this.nodes.values()) {
      node.degree = adjacency.get(node.id)?.size ?? 0;
      const centrality = saturate(node.degree, 12);
      node.importance = clamp01(node.importance * 0.7 + centrality * 0.3);
      node.tier = tierOf(node);
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      adjacency,
      incident,
      builtAt: this.now,
      degraded: this.degraded,
      buildMs: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// pure helpers — exported for the unit tests
// ---------------------------------------------------------------------------

/** Route node ids embed the method so `GET /x` and `POST /x` stay distinct. */
export function routeNodeId(method: string, path: string): string {
  return nodeId('route', `${method} ${path}`);
}

/**
 * Semantic-zoom tier.
 *
 * Tier 0 is what survives the furthest zoom-out, so it is reserved for the
 * structural spine (apps, services, neural layers) and for anything that has
 * become a genuine hub. Tier 2 is evidence-level detail — individual episodes,
 * memories, learning events — which is exactly what should NOT be drawn until
 * someone has zoomed in far enough to read it.
 */
export function tierOf(node: GraphNodeDto): 0 | 1 | 2 {
  const spine: NodeKind[] = ['app', 'service', 'layer'];
  if (spine.includes(node.kind)) return 0;
  if (node.importance >= 0.7 || node.degree >= 24) return 0;

  const mid: NodeKind[] = ['package', 'module', 'agent', 'perceptor', 'concept', 'model', 'source', 'experiment', 'job', 'operator'];
  if (mid.includes(node.kind)) return 1;
  if (node.importance >= 0.45 || node.degree >= 8) return 1;

  return 2;
}

/** Map the ontology's relation vocabulary onto this graph's. */
export function mapConceptRelation(relation: string): RelationType {
  switch (relation) {
    case 'supports':
    case 'confirms':
    case 'implies':
      return 'supports';
    case 'contradicts':
    case 'invalidates':
    case 'negates':
      return 'contradicts';
    case 'part_of':
    case 'subtype_of':
    case 'belongs_to':
      return 'part_of';
    case 'derived_from':
    case 'refines':
      return 'derived_from';
    case 'precedes':
    case 'causes':
    case 'leads_to':
      return 'produces';
    case 'requires':
    case 'depends_on':
      return 'depends_on';
    case 'measured_by':
    case 'observed_by':
      return 'observed_by';
    case 'supersedes':
    case 'replaces':
      return 'supersedes';
    default:
      return 'related_to';
  }
}

export function mapMemoryRelation(relation: string): RelationType {
  switch (relation) {
    case 'derived_from':
    case 'summarises':
    case 'summarizes':
      return 'derived_from';
    case 'supports':
      return 'supports';
    case 'contradicts':
      return 'contradicts';
    case 'supersedes':
      return 'supersedes';
    default:
      return 'related_to';
  }
}

export function mapEntityRelation(relation: string): RelationType {
  switch (relation) {
    case 'mentions':
    case 'co_occurs_with':
      return 'related_to';
    case 'belongs_to_sector':
    case 'belongs_to':
      return 'part_of';
    case 'derived_from':
      return 'derived_from';
    case 'supports':
      return 'supports';
    case 'contradicts':
      return 'contradicts';
    default:
      return 'related_to';
  }
}

/**
 * Which audit event types are security decisions rather than ordinary product
 * events. Substring matching on purpose: the audit vocabulary grows, and a new
 * `admin.*` or `*.revoked` event should land in the security cluster the day it
 * is first written rather than the day someone remembers to add it here.
 */
export function isSecurityEvent(eventType: string): boolean {
  return /admin|operator|auth|login|logout|token|credential|permission|grant|revoke|lock|otp|password|security/i.test(eventType);
}

export function isDeploymentEvent(eventType: string): boolean {
  return /deploy|boot|startup|shutdown|migration|release/i.test(eventType);
}

/** 1,240 → `1.2k`. Glyphs have room for four characters, not seven. */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function maxTime(a: number | undefined, b: number | null): number | undefined {
  if (a === undefined) return b ?? undefined;
  if (b === null) return a;
  return Math.max(a, b);
}
