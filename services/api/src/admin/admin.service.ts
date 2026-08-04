import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Every read behind the admin portal.
 *
 * Rules this service holds to, because an operations console that violates them
 * becomes actively harmful:
 *
 * · **Read-only.** Nothing here mutates platform state. The portal observes;
 *   the two write actions it does offer (granting admin, resolving a stuck
 *   order) live behind their own explicit endpoints and are audit-logged.
 *
 * · **Bounded.** Every list takes a `limit`, clamped server-side. An unbounded
 *   `findMany` against `ApiCallLog` would, on a busy day, be the single most
 *   expensive query the platform runs — issued by a page that auto-refreshes.
 *
 * · **Windowed.** Aggregates take an explicit hours window and are indexed on
 *   `createdAt`, so their cost is proportional to the window, not the table.
 *
 * · **No secrets, ever.** Password hashes, tokens, broker credentials and raw
 *   prompts are never selected. An admin can see THAT a call happened and what
 *   it cost, not what was in it — the portal is an operational view, not a
 *   surveillance tool over users' trading conversations.
 */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  /** Clamp caller-supplied paging. Defends the DB from a hand-edited URL. */
  private take(limit?: number, fallback = 100, max = 500): number {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
  }

  private since(hours?: number, fallback = 24): Date {
    const n = Number(hours);
    const h = Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 90) : fallback;
    return new Date(Date.now() - h * 3_600_000);
  }

  // ------------------------------------------------------------- overview

  /**
   * The landing screen's headline numbers, for one window.
   *
   * Issued as one `Promise.all` rather than sequentially: they are independent
   * and the page is blocked on the slowest, not the sum.
   */
  async overview(hours = 24) {
    const since = this.since(hours);
    const [
      apiTotal,
      apiErrors,
      aiCalls,
      aiErrors,
      aiCost,
      runs,
      runsSurfaced,
      orders,
      ordersRejected,
      trades,
      users,
      newUsers,
      latency,
    ] = await Promise.all([
      this.prisma.apiCallLog.count({ where: { createdAt: { gte: since } } }),
      this.prisma.apiCallLog.count({ where: { createdAt: { gte: since }, statusCode: { gte: 400 } } }),
      this.prisma.aiCallLog.count({ where: { createdAt: { gte: since } } }),
      this.prisma.aiCallLog.count({ where: { createdAt: { gte: since }, status: { not: 'ok' } } }),
      this.prisma.aiCallLog.aggregate({
        where: { createdAt: { gte: since } },
        _sum: { costUsd: true, promptTokens: true, completionTokens: true },
      }),
      this.prisma.agentRun.count({ where: { startedAt: { gte: since } } }),
      this.prisma.agentRun.count({ where: { startedAt: { gte: since }, surfaced: true } }),
      this.prisma.order.count({ where: { placedAt: { gte: since } } }),
      this.prisma.order.count({ where: { placedAt: { gte: since }, status: 'REJECTED' } }),
      this.prisma.trade.count({ where: { executedAt: { gte: since } } }),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: since } } }),
      this.prisma.apiCallLog.aggregate({ where: { createdAt: { gte: since } }, _avg: { durationMs: true } }),
    ]);

    return {
      windowHours: hours,
      api: {
        total: apiTotal,
        errors: apiErrors,
        errorRate: apiTotal ? apiErrors / apiTotal : 0,
        avgLatencyMs: Math.round(latency._avg.durationMs ?? 0),
      },
      ai: {
        calls: aiCalls,
        errors: aiErrors,
        costUsd: aiCost._sum.costUsd ?? 0,
        promptTokens: aiCost._sum.promptTokens ?? 0,
        completionTokens: aiCost._sum.completionTokens ?? 0,
      },
      agents: {
        runs,
        surfaced: runsSurfaced,
        // Sentinel staying silent is the designed behaviour, so this is a
        // tuning read-out, not an error rate. Named to say so.
        silentRate: runs ? 1 - runsSurfaced / runs : 0,
      },
      orders: { total: orders, rejected: ordersRejected, trades },
      users: { total: users, new: newUsers },
    };
  }

  /** Requests per hour, split into ok / client-error / server-error. Drives the
   *  traffic chart. Raw SQL because Prisma cannot group by a time bucket. */
  async apiTimeseries(hours = 24) {
    const since = this.since(hours);
    const rows = await this.prisma.$queryRaw<Array<{ bucket: Date; ok: bigint; client: bigint; server: bigint; avgMs: number }>>`
      SELECT date_trunc('hour', "createdAt") AS bucket,
             COUNT(*) FILTER (WHERE "statusCode" < 400)                        AS ok,
             COUNT(*) FILTER (WHERE "statusCode" >= 400 AND "statusCode" < 500) AS client,
             COUNT(*) FILTER (WHERE "statusCode" >= 500)                        AS server,
             AVG("durationMs")::float                                          AS "avgMs"
      FROM "ApiCallLog"
      WHERE "createdAt" >= ${since}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    return rows.map((r) => ({
      bucket: r.bucket,
      ok: Number(r.ok ?? 0),
      client: Number(r.client ?? 0),
      server: Number(r.server ?? 0),
      avgMs: Number(r.avgMs ?? 0),
    }));
  }

  // ------------------------------------------------------------ api calls

  async apiCalls(params: { limit?: number; status?: string; path?: string; userId?: string; hours?: number }) {
    const where: Record<string, unknown> = { createdAt: { gte: this.since(params.hours, 24) } };
    // `errors` is the filter an operator actually reaches for; exact status
    // codes are also accepted for when they know what they're chasing.
    if (params.status === 'errors') where.statusCode = { gte: 400 };
    else if (params.status && /^\d{3}$/.test(params.status)) where.statusCode = Number(params.status);
    if (params.path) where.path = { contains: params.path };
    if (params.userId) where.userId = params.userId;

    return this.prisma.apiCallLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: this.take(params.limit),
      select: {
        id: true, requestId: true, method: true, path: true, statusCode: true,
        durationMs: true, userId: true, ip: true, error: true, createdAt: true,
        user: { select: { email: true } },
      },
    });
  }

  /** Slowest and busiest routes — the two questions asked of a route table. */
  async routeStats(hours = 24, limit = 25) {
    const since = this.since(hours);
    const rows = await this.prisma.apiCallLog.groupBy({
      by: ['method', 'path'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _avg: { durationMs: true },
      _max: { durationMs: true },
      orderBy: { _count: { id: 'desc' } },
      take: this.take(limit, 25, 100),
    });
    const errors = await this.prisma.apiCallLog.groupBy({
      by: ['path'],
      where: { createdAt: { gte: since }, statusCode: { gte: 400 } },
      _count: { _all: true },
    });
    const errorByPath = new Map(errors.map((e) => [e.path, e._count._all]));
    return rows.map((r) => ({
      method: r.method,
      path: r.path,
      count: r._count._all,
      avgMs: Math.round(r._avg.durationMs ?? 0),
      maxMs: r._max.durationMs ?? 0,
      errors: errorByPath.get(r.path) ?? 0,
    }));
  }

  // ------------------------------------------------------------------- AI

  async aiCalls(params: { limit?: number; system?: string; agent?: string; status?: string; hours?: number }) {
    const where: Record<string, unknown> = { createdAt: { gte: this.since(params.hours, 24) } };
    if (params.system) where.system = params.system;
    if (params.agent) where.agent = params.agent;
    if (params.status === 'errors') where.status = { not: 'ok' };
    else if (params.status) where.status = params.status;

    return this.prisma.aiCallLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: this.take(params.limit),
      select: {
        id: true, requestId: true, system: true, agent: true, provider: true, model: true,
        tier: true, promptTokens: true, completionTokens: true, costUsd: true,
        latencyMs: true, status: true, error: true, createdAt: true,
      },
    });
  }

  /** Per-agent roll-up: volume, spend, latency, failure rate. The single most
   *  useful table for "how is the AI working". */
  async aiByAgent(hours = 24) {
    const since = this.since(hours);
    const [rows, failures] = await Promise.all([
      this.prisma.aiCallLog.groupBy({
        by: ['system', 'agent'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { costUsd: true, promptTokens: true, completionTokens: true },
        _avg: { latencyMs: true },
        _max: { latencyMs: true },
      }),
      this.prisma.aiCallLog.groupBy({
        by: ['agent'],
        where: { createdAt: { gte: since }, status: { not: 'ok' } },
        _count: { _all: true },
      }),
    ]);
    const failureByAgent = new Map(failures.map((f) => [f.agent, f._count._all]));
    return rows
      .map((r) => ({
        system: r.system,
        agent: r.agent,
        calls: r._count._all,
        costUsd: r._sum.costUsd ?? 0,
        promptTokens: r._sum.promptTokens ?? 0,
        completionTokens: r._sum.completionTokens ?? 0,
        avgLatencyMs: Math.round(r._avg.latencyMs ?? 0),
        maxLatencyMs: r._max.latencyMs ?? 0,
        failures: failureByAgent.get(r.agent) ?? 0,
      }))
      .sort((a: any, b: any) => b.calls - a.calls);
  }

  /** Hourly AI spend and volume, for the cost chart. */
  async aiTimeseries(hours = 24) {
    const since = this.since(hours);
    const rows = await this.prisma.$queryRaw<Array<{ bucket: Date; calls: bigint; cost: number; tokens: bigint }>>`
      SELECT date_trunc('hour', "createdAt")                  AS bucket,
             COUNT(*)                                          AS calls,
             COALESCE(SUM("costUsd"), 0)::float                AS cost,
             COALESCE(SUM("promptTokens" + "completionTokens"), 0) AS tokens
      FROM "AiCallLog"
      WHERE "createdAt" >= ${since}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    return rows.map((r) => ({
      bucket: r.bucket,
      calls: Number(r.calls ?? 0),
      cost: Number(r.cost ?? 0),
      tokens: Number(r.tokens ?? 0),
    }));
  }

  // -------------------------------------------------------------- agents

  async runs(params: { limit?: number; system?: string; status?: string; hours?: number }) {
    const where: Record<string, unknown> = { startedAt: { gte: this.since(params.hours, 24) } };
    if (params.system) where.system = params.system;
    if (params.status) where.status = params.status;
    return this.prisma.agentRun.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: this.take(params.limit, 50, 200),
    });
  }

  /** Every transition in one run, oldest first — the run's timeline. */
  async runActivity(runId: string) {
    const [run, activity, aiCalls] = await Promise.all([
      this.prisma.agentRun.findUnique({ where: { runId } }),
      this.prisma.agentActivity.findMany({ where: { runId }, orderBy: { createdAt: 'asc' }, take: 500 }),
      // Correlated by requestId — the run and its LLM calls share one.
      this.prisma.agentRun.findUnique({ where: { runId }, select: { requestId: true } }).then((r: any) =>
        r?.requestId
          ? this.prisma.aiCallLog.findMany({
              where: { requestId: r.requestId },
              orderBy: { createdAt: 'asc' },
              take: 100,
            })
          : [],
      ),
    ]);
    return { run, activity, aiCalls };
  }

  /**
   * The orbit's data source: one row per known agent with its CURRENT state.
   *
   * "Current" is the last transition seen within a short recency window. Beyond
   * that window an agent is reported `idle` rather than frozen in whatever it
   * was last doing — an orbit that shows an agent eternally "thinking" because
   * it thought once an hour ago is worse than one that admits it is quiet.
   */
  async agentStates(system = 'sentinel', recencySeconds = 30) {
    const cutoff = new Date(Date.now() - recencySeconds * 1000);
    const recent = await this.prisma.agentActivity.findMany({
      where: { system, createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const latest = new Map<string, (typeof recent)[number]>();
    for (const row of recent) if (!latest.has(row.agent)) latest.set(row.agent, row);

    // 24h totals give each agent's card a number even when the platform is
    // quiet, so the orbit is never a ring of blank nodes.
    const totals = await this.prisma.agentActivity.groupBy({
      by: ['agent'],
      where: { system, createdAt: { gte: this.since(24) } },
      _count: { _all: true },
    });
    const totalByAgent = new Map(totals.map((t: any) => [t.agent, t._count._all]));

    return KNOWN_AGENTS[system]?.map((agent) => {
      const row = latest.get(agent.name);
      return {
        ...agent,
        state: row?.state ?? 'idle',
        peer: row?.peer ?? null,
        detail: row?.detail ?? null,
        lastSeen: row?.createdAt ?? null,
        transitions24h: totalByAgent.get(agent.name) ?? 0,
      };
    }) ?? [];
  }

  // -------------------------------------------------------------- orders

  // NOTE: Order timestamps its lifecycle with `placedAt`, and Trade with
  // `executedAt` — neither has a `createdAt`. Domain-accurate names, and worth
  // stating because every other table here uses `createdAt` and the difference
  // is silent at runtime if it slips through as an untyped `where` object.
  async orders(params: { limit?: number; status?: string; userId?: string; hours?: number }) {
    const where: Record<string, unknown> = { placedAt: { gte: this.since(params.hours, 24) } };
    if (params.status) where.status = params.status;
    if (params.userId) where.userId = params.userId;
    return this.prisma.order.findMany({
      where,
      orderBy: { placedAt: 'desc' },
      take: this.take(params.limit),
      include: {
        user: { select: { id: true, email: true } },
        instrument: { select: { symbol: true, displayName: true, type: true } },
      },
    });
  }

  async orderStats(hours = 24) {
    const since = this.since(hours);
    const [byStatus, bySide, volume] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], where: { placedAt: { gte: since } }, _count: { _all: true } }),
      this.prisma.order.groupBy({ by: ['side'], where: { placedAt: { gte: since } }, _count: { _all: true } }),
      this.prisma.trade.aggregate({ where: { executedAt: { gte: since } }, _count: { _all: true } }),
    ]);
    return {
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      bySide: bySide.map((s) => ({ side: s.side, count: s._count._all })),
      trades: volume._count._all,
    };
  }

  async trades(limit = 100, hours = 24) {
    return this.prisma.trade.findMany({
      where: { executedAt: { gte: this.since(hours) } },
      orderBy: { executedAt: 'desc' },
      take: this.take(limit),
      include: {
        user: { select: { email: true } },
        instrument: { select: { symbol: true } },
      },
    });
  }

  // --------------------------------------------------------------- users

  async users(params: { limit?: number; q?: string }) {
    const where = params.q ? { email: { contains: params.q, mode: 'insensitive' as const } } : {};
    return this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: this.take(params.limit),
      // Explicit select, never `include` — `passwordHash` lives on this model
      // and a spread would ship it to a browser.
      select: {
        id: true, email: true, country: true, experienceLevel: true,
        isAdmin: true, createdAt: true,
        _count: { select: { orders: true, trades: true, notifications: true } },
        subscriptions: { select: { status: true, planId: true }, take: 1, orderBy: { createdAt: 'desc' } },
      },
    });
  }

  async auditEvents(params: { limit?: number; eventType?: string; userId?: string; hours?: number }) {
    const where: Record<string, unknown> = { createdAt: { gte: this.since(params.hours, 24 * 7) } };
    if (params.eventType) where.eventType = params.eventType;
    if (params.userId) where.userId = params.userId;
    return this.prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: this.take(params.limit),
      include: { user: { select: { email: true } } },
    });
  }

  /**
   * Grant or revoke portal access. The portal's only destructive action, so it
   * is deliberately narrow: it takes an email, flips one boolean, and writes an
   * audit row naming the admin who did it.
   */
  async setAdmin(email: string, isAdmin: boolean, actorId: string) {
    const user = await this.prisma.user.update({
      where: { email },
      data: { isAdmin },
      select: { id: true, email: true, isAdmin: true },
    });
    await this.prisma.auditEvent.create({
      data: {
        userId: actorId,
        eventType: isAdmin ? 'admin.granted' : 'admin.revoked',
        metadata: { targetUserId: user.id, targetEmail: user.email },
      },
    });
    return user;
  }

  // -------------------------------------------------------------- health

  /**
   * Service health. Each probe is independently caught, so one dead dependency
   * reports as down instead of collapsing the whole page into a 500 — the exact
   * moment an operator most needs this endpoint to answer.
   */
  async health() {
    const probe = async (name: string, fn: () => Promise<unknown>) => {
      const startedAt = Date.now();
      try {
        await fn();
        return { name, status: 'up' as const, latencyMs: Date.now() - startedAt };
      } catch (err) {
        return {
          name,
          status: 'down' as const,
          latencyMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const [database, recentErrors, oldestPending] = await Promise.all([
      probe('postgres', () => this.prisma.$queryRaw`SELECT 1`),
      this.prisma.apiCallLog
        .count({ where: { createdAt: { gte: new Date(Date.now() - 300_000) }, statusCode: { gte: 500 } } })
        .catch(() => -1),
      // A PENDING order that has sat for minutes is the classic symptom of a
      // stuck OMS worker, and it is invisible from any trader-facing screen.
      this.prisma.order
        .findFirst({ where: { status: 'PENDING' }, orderBy: { placedAt: 'asc' }, select: { id: true, placedAt: true } })
        .catch(() => null),
    ]);

    return {
      services: [database],
      serverErrorsLast5m: recentErrors,
      oldestPendingOrder: oldestPending,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      nodeVersion: process.version,
      checkedAt: new Date(),
    };
  }
}

/**
 * The agents the orbit draws, in the order they sit around the ring.
 *
 * Mirrors `agents/sentinel/definitions.json`. Duplicated here rather than
 * imported because the orbit must render every agent — including one that has
 * never emitted an event, which is precisely the case an operator needs to
 * SEE (an agent that never runs is a bug, and a view built only from observed
 * events would render it as absent rather than as silent).
 */
const KNOWN_AGENTS: Record<string, Array<{ name: string; label: string; role: string }>> = {
  sentinel: [
    { name: 'market-technical', label: 'Market Technical', role: 'Observes structure — EMA, RSI, VWAP, CPR, volume, OI, IV, breadth.' },
    { name: 'emotion', label: 'Emotion', role: "Observes the trader's own pacing, sizing drift and loss streaks." },
    { name: 'trap-safety', label: 'Trap Safety', role: 'Composite trap detection — sweeps, false breakouts, expiry traps.' },
    { name: 'compliance-audit', label: 'Compliance Audit', role: 'Labels each observation with a SEBI category and its evidence.' },
    { name: 'orchestrator', label: 'Orchestrator', role: 'The only user-facing voice. Synthesises corroborating signals into one message.' },
  ],
  'tradew-ai': [
    { name: 'assistant', label: 'Assistant', role: 'The conversational surface — answers, navigates, explains.' },
    { name: 'research', label: 'Research', role: 'Validates, summarises and embeds external sources.' },
    { name: 'orchestrator', label: 'Orchestrator', role: 'Routes a request to the agent that should handle it.' },
  ],
};

/** The orbit needs to know which node is the centre. */
export const ORCHESTRATOR = 'orchestrator';
