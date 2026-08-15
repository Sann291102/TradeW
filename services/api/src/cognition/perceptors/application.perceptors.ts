import { NewPercept, SenseContext } from '@tradew/ai-core';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaPerceptor, clamp01, priorWindow } from './shared';

/**
 * The application's own senses — errors, latency, stuck work, failing agents.
 *
 * This is the domain that turns the network from a market tool into something
 * that helps run the platform. Everything here reads the telemetry tables the
 * admin console already writes (`ApiCallLog`, `AiCallLog`, `AgentRun`) plus the
 * order book, so none of it required new instrumentation — the data was being
 * recorded and nothing was drawing conclusions from it.
 *
 * WHY THESE SIX
 *
 * Each corresponds to a failure that is invisible from every trader-facing
 * screen and, before this, from the operator console too unless somebody
 * happened to be looking at the right panel at the right minute:
 *
 *   error-rate      a route started failing
 *   latency         a route got slower without failing
 *   ai-failures     an agent's provider is erroring, timing out or refusing
 *   ai-cost         one agent started burning budget
 *   stuck-orders    the OMS worker stalled — orders sitting in PENDING
 *   agent-silence   an agent that used to run has stopped running
 *
 * The last one is the reason the domain exists. Every other signal here is
 * something happening; `agent-silence` is something *not* happening, which no
 * event-driven view can ever show you.
 */

// ---------------------------------------------------------------------------

/** 5xx rate per route, against the immediately preceding window. */
export class ErrorRatePerceptor extends PrismaPerceptor {
  constructor(prisma: PrismaService) {
    super(
      {
        id: 'application.error-rate',
        domain: 'application',
        label: 'API error rate',
        description: 'Watches the 5xx rate of each route against the previous window of the same length. Fires when a route starts failing.',
        cadence: 'interval',
        expectedIntervalMs: 5 * 60_000,
        emits: ['error_rate_spike', 'new_failing_route'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const prior = priorWindow(context);

    const [current, previous] = await Promise.all([
      this.prisma.apiCallLog.groupBy({
        by: ['path'],
        where: { createdAt: { gte: context.since, lt: context.until } },
        _count: { _all: true },
      }),
      this.prisma.apiCallLog.groupBy({
        by: ['path'],
        where: { createdAt: { gte: prior.since, lt: prior.until } },
        _count: { _all: true },
      }),
    ]);

    const errorsNow = await this.prisma.apiCallLog.groupBy({
      by: ['path'],
      where: { createdAt: { gte: context.since, lt: context.until }, statusCode: { gte: 500 } },
      _count: { _all: true },
    });
    const errorsBefore = await this.prisma.apiCallLog.groupBy({
      by: ['path'],
      where: { createdAt: { gte: prior.since, lt: prior.until }, statusCode: { gte: 500 } },
      _count: { _all: true },
    });

    const totalNow = new Map(current.map((r) => [r.path, r._count._all]));
    const totalBefore = new Map(previous.map((r) => [r.path, r._count._all]));
    const errBefore = new Map(errorsBefore.map((r) => [r.path, r._count._all]));

    const out: NewPercept[] = [];
    for (const row of errorsNow) {
      const total = totalNow.get(row.path) ?? 0;
      if (!total) continue;
      const rate = row._count._all / total;
      const beforeTotal = totalBefore.get(row.path) ?? 0;
      const beforeRate = beforeTotal ? (errBefore.get(row.path) ?? 0) / beforeTotal : 0;

      // A route that was already failing and still is at the same rate is not
      // news — it is a known incident, and re-firing it every five minutes is
      // how an operator learns to ignore this sensor. Novelty is the signal.
      const salience = this.deviationSalience(rate, beforeRate, 0.005);
      if (salience <= 0) continue;

      out.push(
        this.percept({
          kind: beforeRate === 0 ? 'new_failing_route' : 'error_rate_spike',
          subject: { type: 'route', id: row.path, label: row.path },
          observedAt: context.until,
          salience,
          confidence: this.sampleConfidence(total),
          features: { errorRate: rate, priorErrorRate: beforeRate, errors: row._count._all, requests: total },
          summary: `${row.path} — 5xx rate ${(rate * 100).toFixed(1)}% over ${total} requests (was ${(beforeRate * 100).toFixed(1)}%)`,
          occurrences: row._count._all,
          tags: ['error', 'route'],
        }),
      );
    }
    return out;
  }
}

// ---------------------------------------------------------------------------

/**
 * Latency regression per route.
 *
 * Separate from the error perceptor because a route that gets three times
 * slower while returning 200s is a different problem with a different cause,
 * and folding it into an "unhealthy route" signal loses the distinction exactly
 * where it matters most — an operator reading the console needs to know whether
 * to look at an exception or at a query plan.
 */
export class LatencyPerceptor extends PrismaPerceptor {
  constructor(prisma: PrismaService) {
    super(
      {
        id: 'application.latency',
        domain: 'application',
        label: 'Route latency',
        description: 'Compares each route’s mean latency against the previous window. Fires on a regression, independently of whether the route is erroring.',
        cadence: 'interval',
        expectedIntervalMs: 5 * 60_000,
        emits: ['latency_regression'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const prior = priorWindow(context);

    const [now, before] = await Promise.all([
      this.prisma.apiCallLog.groupBy({
        by: ['path'],
        where: { createdAt: { gte: context.since, lt: context.until } },
        _avg: { durationMs: true },
        _max: { durationMs: true },
        _count: { _all: true },
      }),
      this.prisma.apiCallLog.groupBy({
        by: ['path'],
        where: { createdAt: { gte: prior.since, lt: prior.until } },
        _avg: { durationMs: true },
        _count: { _all: true },
      }),
    ]);

    const baseline = new Map(before.map((r) => [r.path, { avg: r._avg.durationMs ?? 0, n: r._count._all }]));
    const out: NewPercept[] = [];

    for (const row of now) {
      const avg = row._avg.durationMs ?? 0;
      const prev = baseline.get(row.path);
      // No baseline means a route that only just started being called. That is
      // not a regression, and reporting it as one would make every deploy that
      // adds an endpoint look like an incident.
      if (!prev || prev.n < 5 || row._count._all < 5) continue;

      const salience = this.deviationSalience(avg, prev.avg, 20);
      // 25% slower is inside normal variance for anything that touches a
      // network. Below that the signal is not worth an operator's attention.
      if (salience <= 0 || avg < prev.avg * 1.25) continue;

      out.push(
        this.percept({
          kind: 'latency_regression',
          subject: { type: 'route', id: row.path, label: row.path },
          observedAt: context.until,
          salience,
          confidence: this.sampleConfidence(Math.min(row._count._all, prev.n)),
          features: { avgMs: avg, priorAvgMs: prev.avg, maxMs: row._max.durationMs ?? 0, requests: row._count._all },
          summary: `${row.path} — mean latency ${Math.round(avg)}ms, up from ${Math.round(prev.avg)}ms`,
          tags: ['latency', 'route'],
        }),
      );
    }
    return out;
  }
}

// ---------------------------------------------------------------------------

/** Provider errors, timeouts and refusals, per agent. */
export class AiFailurePerceptor extends PrismaPerceptor {
  constructor(prisma: PrismaService) {
    super(
      {
        id: 'application.ai-failures',
        domain: 'application',
        label: 'AI call failures',
        description: 'Non-ok LLM calls grouped by agent and status. Separates a provider outage from a single agent producing bad requests.',
        cadence: 'interval',
        expectedIntervalMs: 5 * 60_000,
        emits: ['ai_failure_burst'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const rows = await this.prisma.aiCallLog.groupBy({
      by: ['agent', 'status', 'provider'],
      where: { createdAt: { gte: context.since, lt: context.until }, status: { not: 'ok' } },
      _count: { _all: true },
      _avg: { latencyMs: true },
    });
    if (!rows.length) return [];

    const totals = await this.prisma.aiCallLog.groupBy({
      by: ['agent'],
      where: { createdAt: { gte: context.since, lt: context.until } },
      _count: { _all: true },
    });
    const totalByAgent = new Map(totals.map((r) => [r.agent, r._count._all]));

    return rows.map((row) => {
      const total = totalByAgent.get(row.agent) ?? row._count._all;
      const failureRate = row._count._all / total;
      return this.percept({
        kind: 'ai_failure_burst',
        subject: { type: 'agent', id: row.agent, label: row.agent },
        observedAt: context.until,
        // Failure rate IS the salience here — there is no useful baseline,
        // because the healthy state is zero and any sustained non-zero rate is
        // worth knowing about.
        salience: clamp01(failureRate),
        confidence: this.sampleConfidence(total),
        features: { failures: row._count._all, total, failureRate, avgLatencyMs: row._avg.latencyMs ?? 0 },
        summary: `${row.agent} — ${row._count._all}/${total} calls ${row.status} on ${row.provider}`,
        occurrences: row._count._all,
        tags: ['ai', row.status, row.provider],
      });
    });
  }
}

// ---------------------------------------------------------------------------

/**
 * Per-agent LLM spend, against the previous window.
 *
 * Cost is a correctness signal, not only a budget one. An agent whose spend
 * quadruples is usually retrying, or has had its context balloon, or is being
 * invoked in a loop — all bugs, all of which show up here days before they show
 * up on an invoice.
 */
export class AiCostPerceptor extends PrismaPerceptor {
  constructor(prisma: PrismaService) {
    super(
      {
        id: 'application.ai-cost',
        domain: 'application',
        label: 'AI spend anomaly',
        description: 'Per-agent LLM spend against the previous window. A spend spike is usually a retry loop or a context leak, not a pricing change.',
        cadence: 'interval',
        expectedIntervalMs: 15 * 60_000,
        emits: ['ai_cost_spike'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const prior = priorWindow(context);
    const [now, before] = await Promise.all([
      this.prisma.aiCallLog.groupBy({
        by: ['agent'],
        where: { createdAt: { gte: context.since, lt: context.until } },
        _sum: { costUsd: true, promptTokens: true, completionTokens: true },
        _count: { _all: true },
      }),
      this.prisma.aiCallLog.groupBy({
        by: ['agent'],
        where: { createdAt: { gte: prior.since, lt: prior.until } },
        _sum: { costUsd: true },
        _count: { _all: true },
      }),
    ]);

    const baseline = new Map(before.map((r) => [r.agent, { cost: r._sum.costUsd ?? 0, n: r._count._all }]));
    const out: NewPercept[] = [];

    for (const row of now) {
      const cost = row._sum.costUsd ?? 0;
      const prev = baseline.get(row.agent);
      if (!prev || prev.cost <= 0) continue;
      const salience = this.deviationSalience(cost, prev.cost, 0.0001);
      if (salience < 0.25) continue;

      out.push(
        this.percept({
          kind: 'ai_cost_spike',
          subject: { type: 'agent', id: row.agent, label: row.agent },
          observedAt: context.until,
          salience,
          confidence: this.sampleConfidence(row._count._all),
          features: {
            costUsd: cost,
            priorCostUsd: prev.cost,
            calls: row._count._all,
            priorCalls: prev.n,
            promptTokens: row._sum.promptTokens ?? 0,
            completionTokens: row._sum.completionTokens ?? 0,
          },
          // Labelled an estimate, as everywhere else the local rate card is used.
          summary: `${row.agent} — estimated spend $${cost.toFixed(4)} over ${row._count._all} calls, up from $${prev.cost.toFixed(4)}`,
          tags: ['ai', 'cost'],
        }),
      );
    }
    return out;
  }
}

// ---------------------------------------------------------------------------

/**
 * Orders sitting in PENDING past the point where that is plausible.
 *
 * A stalled OMS worker is invisible from every trader-facing screen — the user
 * sees an order that has been "placed" and simply never moves. This is the
 * single most user-affecting fault the application can have, so its salience
 * floor is high and its confidence is 1: a PENDING order older than the
 * threshold is not an inference, it is a fact read directly from the book.
 */
export class StuckOrderPerceptor extends PrismaPerceptor {
  /** Beyond this, a PENDING order is not slow, it is stuck. */
  private static readonly STUCK_AFTER_MS = 2 * 60_000;

  constructor(prisma: PrismaService) {
    super(
      {
        id: 'application.stuck-orders',
        domain: 'application',
        label: 'Stuck orders',
        description: 'Orders left in PENDING past the point where a working matching engine would have moved them. The clearest signal of a stalled OMS worker.',
        cadence: 'interval',
        expectedIntervalMs: 60_000,
        emits: ['orders_stuck_pending'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const cutoff = new Date(context.until.getTime() - StuckOrderPerceptor.STUCK_AFTER_MS);
    const stuck = await this.prisma.order.findMany({
      where: { status: 'PENDING', placedAt: { lt: cutoff } },
      select: { id: true, placedAt: true },
      orderBy: { placedAt: 'asc' },
      take: 200,
    });
    if (!stuck.length) return [];

    const oldestMs = context.until.getTime() - stuck[0].placedAt.getTime();
    return [
      this.percept({
        kind: 'orders_stuck_pending',
        subject: { type: 'subsystem', id: 'oms', label: 'Order management' },
        observedAt: context.until,
        // Scales with how long the oldest has waited, saturating at ten minutes.
        // A single order stuck for nine minutes matters as much as ten stuck
        // for two — duration, not count, is what the user experiences.
        salience: clamp01(0.5 + oldestMs / (10 * 60_000)),
        confidence: 1,
        features: { stuckCount: stuck.length, oldestAgeMs: oldestMs },
        summary: `${stuck.length} order${stuck.length === 1 ? '' : 's'} stuck in PENDING; oldest ${Math.round(oldestMs / 1000)}s`,
        payload: { oldestOrderId: stuck[0].id },
        occurrences: stuck.length,
        tags: ['orders', 'oms'],
      }),
    ];
  }
}

// ---------------------------------------------------------------------------

/**
 * An agent that used to run and has stopped.
 *
 * The absence detector, and the reason this domain is not just a nicer error
 * dashboard. Every other perceptor here is triggered by something happening.
 * This one is triggered by something *not* happening, which no stream of events
 * can express — a Sentinel agent that quietly stopped being scheduled produces
 * no errors, no latency, no cost, and no rows anywhere. It just goes quiet, and
 * the platform looks healthy while an entire analytical dimension is missing.
 *
 * The comparison is against the agent's own recent history rather than a fixed
 * roster, so an agent that is legitimately retired stops being reported once its
 * history ages out, without anyone maintaining a list.
 */
export class AgentSilencePerceptor extends PrismaPerceptor {
  /** How far back "used to run" reaches. */
  private static readonly HISTORY_MS = 24 * 3_600_000;
  /** Silence past this is reported. */
  private static readonly SILENT_AFTER_MS = 60 * 60_000;

  constructor(prisma: PrismaService) {
    super(
      {
        id: 'application.agent-silence',
        domain: 'application',
        label: 'Agent gone silent',
        description: 'An agent that ran in the last 24h and has produced nothing for an hour. The one fault no event-driven view can surface.',
        cadence: 'interval',
        expectedIntervalMs: 15 * 60_000,
        emits: ['agent_silent'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const historyFrom = new Date(context.until.getTime() - AgentSilencePerceptor.HISTORY_MS);
    const silentBefore = new Date(context.until.getTime() - AgentSilencePerceptor.SILENT_AFTER_MS);

    const seen = await this.prisma.agentActivity.groupBy({
      by: ['agent', 'system'],
      where: { createdAt: { gte: historyFrom } },
      _max: { createdAt: true },
      _count: { _all: true },
    });

    return seen
      .filter((row) => {
        const last = row._max.createdAt;
        // An agent with only a handful of transitions all day was never really
        // running; calling it "silent" would be a false positive on something
        // that is simply rare.
        return last !== null && last < silentBefore && row._count._all >= 10;
      })
      .map((row) => {
        const silentMs = context.until.getTime() - (row._max.createdAt as Date).getTime();
        return this.percept({
          kind: 'agent_silent',
          subject: { type: 'agent', id: row.agent, label: `${row.system}/${row.agent}` },
          observedAt: context.until,
          salience: clamp01(0.4 + silentMs / (6 * 3_600_000)),
          confidence: this.sampleConfidence(row._count._all),
          features: { silentMs, transitions24h: row._count._all },
          summary: `${row.system}/${row.agent} has produced nothing for ${Math.round(silentMs / 60_000)} minutes, after ${row._count._all} transitions in the last 24h`,
          tags: ['agent', 'silence', row.system],
        });
      });
  }
}

export function applicationPerceptors(prisma: PrismaService) {
  return [
    new ErrorRatePerceptor(prisma),
    new LatencyPerceptor(prisma),
    new AiFailurePerceptor(prisma),
    new AiCostPerceptor(prisma),
    new StuckOrderPerceptor(prisma),
    new AgentSilencePerceptor(prisma),
  ];
}
