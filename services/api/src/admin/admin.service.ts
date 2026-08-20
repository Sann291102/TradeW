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
 *
 * · **Prisma and nothing else.** `ControlModule` provides this class directly
 *   rather than importing `AdminModule`, so the console's one-way boundary
 *   survives — and that only works while the only thing this constructor needs
 *   is the `@Global` `PrismaService`. Injecting a second service here breaks
 *   the control plane's boot with an unresolvable dependency, because that
 *   module never imported whatever the new dependency came from. Live state
 *   belongs on the controller, which can inject whatever it likes.
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

  /**
   * Per-minute request pulse over the last `minutes` (clamped 1..180) from the
   * API call log. Backs the "System pulse" panel with a real, recent cadence.
   * Deliberately per-MINUTE, not per-second: the log records each request, so a
   * minute bucket is a truthful rate, whereas a per-second figure would imply a
   * resolution the data does not carry. The UI labels it accordingly.
   */
  async apiPulse(minutes = 30) {
    const n = Number(minutes);
    const m = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 180) : 30;
    const since = new Date(Date.now() - m * 60_000);
    const rows = await this.prisma.$queryRaw<Array<{ bucket: Date; total: bigint; errors: bigint; avgMs: number }>>`
      SELECT date_trunc('minute', "createdAt")                 AS bucket,
             COUNT(*)                                           AS total,
             COUNT(*) FILTER (WHERE "statusCode" >= 500)        AS errors,
             AVG("durationMs")::float                           AS "avgMs"
      FROM "ApiCallLog"
      WHERE "createdAt" >= ${since}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    return rows.map((r) => ({
      bucket: r.bucket,
      total: Number(r.total ?? 0),
      errors: Number(r.errors ?? 0),
      avgMs: Math.round(Number(r.avgMs ?? 0)),
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

  /**
   * Per-model roll-up: a real GROUP BY over the AI call log by provider+model.
   * Backs the console's "Model usage" panel with genuine figures (calls, tokens,
   * spend, latency, failures) rather than the invented percentages a mockup
   * shows. A model that made no calls in the window simply does not appear.
   */
  async aiByModel(hours = 24) {
    const since = this.since(hours);
    const [rows, failures] = await Promise.all([
      this.prisma.aiCallLog.groupBy({
        by: ['provider', 'model'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { costUsd: true, promptTokens: true, completionTokens: true },
        _avg: { latencyMs: true },
      }),
      this.prisma.aiCallLog.groupBy({
        by: ['provider', 'model'],
        where: { createdAt: { gte: since }, status: { not: 'ok' } },
        _count: { _all: true },
      }),
    ]);
    const failKey = (p: string, m: string) => `${p}::${m}`;
    const failByModel = new Map(failures.map((f) => [failKey(f.provider, f.model), f._count._all]));
    return rows
      .map((r) => ({
        provider: r.provider,
        model: r.model,
        calls: r._count._all,
        costUsd: r._sum.costUsd ?? 0,
        promptTokens: r._sum.promptTokens ?? 0,
        completionTokens: r._sum.completionTokens ?? 0,
        avgLatencyMs: Math.round(r._avg.latencyMs ?? 0),
        failures: failByModel.get(failKey(r.provider, r.model)) ?? 0,
      }))
      .sort((a: { calls: number }, b: { calls: number }) => b.calls - a.calls);
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
  /**
   * `source` filters on the PRESENCE of an execution intent, not on an account
   * name or a text convention: `Order.executionIntentId` is set only by the
   * paper-execution loop and null for every human order, so "was this
   * agent-generated?" is a structural question with an exact answer.
   *
   *   'sentinel' → it carries an entry link OR an exit link
   *   'user'     → it carries neither
   *   undefined  → everything (the pre-existing behaviour, unchanged)
   *
   * BOTH links, not just the entry. A square-off cannot reuse
   * `executionIntentId` (that column is @unique and holds the entry), so it
   * carries `exitOfIntentId` instead — and while this filter tested only the
   * entry, an agent appeared to open positions and never close them. Half of
   * its order flow was filed as a human's.
   */
  async orders(params: { limit?: number; status?: string; userId?: string; hours?: number; source?: string }) {
    const where: Record<string, unknown> = { placedAt: { gte: this.since(params.hours, 24) } };
    if (params.status) where.status = params.status;
    if (params.userId) where.userId = params.userId;
    if (params.source === 'sentinel') {
      where.OR = [{ executionIntentId: { not: null } }, { exitOfIntentId: { not: null } }];
    }
    if (params.source === 'user') {
      where.executionIntentId = null;
      where.exitOfIntentId = null;
    }
    return this.prisma.order.findMany({
      where,
      orderBy: { placedAt: 'desc' },
      take: this.take(params.limit),
      include: {
        user: { select: { id: true, email: true } },
        instrument: { select: { symbol: true, displayName: true, type: true } },
        // The provenance the Orders table renders inline. A nested select
        // rather than a second query per row: an agent-order list would
        // otherwise be N+1 against the intent table on every 8-second poll.
        executionIntent: {
          select: {
            id: true,
            agent: true,
            symbol: true,
            optionType: true,
            bias: true,
            strike: true,
            confidence: true,
            status: true,
            environment: true,
            strategyName: true,
            profile: { select: { name: true } },
            outcome: { select: { result: true, realizedPnl: true } },
          },
        },
        // The intent this order CLOSED, when it is an agent exit. Narrower than
        // the entry selection above on purpose: the console renders an exit as
        // "exit of <that decision>" and links to the same trace, so it needs
        // the identity and the contract, not the evidence a second time.
        exitOfIntent: {
          select: {
            id: true,
            agent: true,
            symbol: true,
            optionType: true,
            strike: true,
            status: true,
            environment: true,
            profile: { select: { name: true } },
          },
        },
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

  /**
   * Arm or disarm one execution profile.
   *
   * Audited like `setAdmin` and for the same reason: this is the switch that
   * decides whether an autonomous agent may place orders, so "who turned it on,
   * and when" has to survive in a table rather than in a log line that ages out.
   *
   * `environment` is echoed back deliberately — an operator arming a profile
   * should see PAPER in the response confirming what they just armed.
   */
  async setExecutionProfileEnabled(id: string, enabled: boolean) {
    const profile = await this.prisma.executionProfile.update({
      where: { id },
      data: { enabled },
      select: { id: true, name: true, agent: true, symbol: true, environment: true, enabled: true },
    });
    await this.prisma.auditEvent.create({
      data: {
        eventType: enabled ? 'execution.profile.enabled' : 'execution.profile.disabled',
        metadata: {
          profileId: profile.id,
          profileName: profile.name,
          agent: profile.agent,
          symbol: profile.symbol,
          environment: profile.environment,
        },
      },
    });
    return profile;
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

  // ------------------------------------------------------------- cognition

  /**
   * Note what is NOT here: the live network snapshot and the sensor roster.
   * Those come off `CognitionService` on the controller, because they are the
   * network's in-memory state rather than a Prisma read — and because pulling
   * that dependency into this class is what broke the control plane's boot the
   * first time round (see the constructor note above).
   *
   * The split is also the honest one. Postgres holds what the network has
   * *recorded*; the live object holds what it is *doing*. On an instance where
   * the loop is disabled, the tables still have yesterday's rows while the
   * network is idle, and it is that second fact the console has to show —
   * otherwise a disabled network is indistinguishable from a working one.
   */

  /**
   * Recent passes.
   *
   * `unscoredOnly` exists because "how many episodes are still waiting for an
   * outcome" is the question that reveals a stalled feedback loop, and a
   * stalled feedback loop stops all learning without producing a single error.
   */
  async cognitionEpisodes(params: {
    limit?: number;
    domain?: string;
    status?: string;
    hours?: number;
    unscoredOnly?: boolean;
  }) {
    return this.prisma.cognitiveEpisode.findMany({
      where: {
        startedAt: { gte: this.since(params.hours) },
        ...(params.domain ? { domain: params.domain } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.unscoredOnly ? { scoredAt: null } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: this.take(params.limit, 60, 300),
    });
  }

  /** One pass and everything it perceived. The console's drill-down. */
  async cognitionEpisode(episodeId: string) {
    const [episode, percepts, proposals] = await Promise.all([
      this.prisma.cognitiveEpisode.findUnique({ where: { episodeId } }),
      this.prisma.percept.findMany({
        where: { episodeId },
        orderBy: { salience: 'desc' },
        take: 200,
      }),
      this.prisma.cognitiveProposal.findMany({ where: { episodeId }, orderBy: { confidence: 'desc' } }),
    ]);
    return { episode, percepts, proposals };
  }

  /**
   * Per-domain percept ingestion over a window, aggregated from real percept
   * timestamps. Backs the "Perceptor domains" source panel: a genuine count,
   * mean salience, last-seen and a DERIVED rate (percepts ÷ window hours). The
   * rate is honest arithmetic on real rows, not a fabricated "signals/sec".
   */
  async cognitionDomains(hours = 24) {
    const since = this.since(hours);
    const rows = await this.prisma.percept.groupBy({
      by: ['domain'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _avg: { salience: true },
      _max: { createdAt: true },
    });
    const windowHours = Math.max(0.001, (Date.now() - since.getTime()) / 3_600_000);
    return rows
      .map((r) => ({
        domain: r.domain,
        percepts: r._count._all,
        meanSalience: r._avg.salience ?? 0,
        lastAt: r._max.createdAt,
        perHour: Math.round((r._count._all / windowHours) * 10) / 10,
      }))
      .sort((a: { percepts: number }, b: { percepts: number }) => b.percepts - a.percepts);
  }

  async cognitionPercepts(params: { limit?: number; domain?: string; perceptorId?: string; hours?: number }) {
    return this.prisma.percept.findMany({
      where: {
        createdAt: { gte: this.since(params.hours) },
        ...(params.domain ? { domain: params.domain } : {}),
        ...(params.perceptorId ? { perceptorId: params.perceptorId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: this.take(params.limit, 100, 500),
    });
  }

  /**
   * The learned weights.
   *
   * Ordered by weight, and every row carries `reinforcements` alongside it. The
   * console renders that column deliberately: a high weight with zero
   * reinforcements is a *guess* the network has never had scored, and presenting
   * it beside a weight that survived forty outcomes without that distinction
   * would misrepresent the one number this whole system exists to produce.
   */
  async cognitionSynapses(params: { limit?: number; layer?: string; provenOnly?: boolean }) {
    return this.prisma.neuralSynapse.findMany({
      where: {
        ...(params.layer ? { layer: params.layer } : {}),
        ...(params.provenOnly ? { reinforcements: { gt: 0 } } : {}),
      },
      orderBy: [{ weight: 'desc' }, { reinforcements: 'desc' }],
      take: this.take(params.limit, 100, 500),
    });
  }

  /** The operator queue. `pending` first — this is a worklist, not a log. */
  async cognitionProposals(params: { limit?: number; status?: string; domain?: string; hours?: number }) {
    return this.prisma.cognitiveProposal.findMany({
      where: {
        createdAt: { gte: this.since(params.hours, 24 * 7) },
        ...(params.status ? { status: params.status } : {}),
        ...(params.domain ? { domain: params.domain } : {}),
      },
      orderBy: [{ status: 'asc' }, { confidence: 'desc' }],
      take: this.take(params.limit, 50, 200),
    });
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
