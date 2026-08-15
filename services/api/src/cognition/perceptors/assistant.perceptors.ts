import { NewPercept, SenseContext } from '@tradew/ai-core';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaPerceptor, clamp01, priorWindow } from './shared';

/**
 * Tara — the assistant domain.
 *
 * This is the domain that answers "is Tara getting better at her job?", and the
 * hard part is that almost nothing in this codebase records whether she was
 * *right*. There are no thumbs, no ratings, no explicit feedback anywhere. So
 * these perceptors read the two proxies that do exist and are honest about them
 * being proxies:
 *
 *   · **refusals and errors** — Tara declining or failing to answer. Not
 *     inherently bad (the guardrails are supposed to refuse advice requests),
 *     which is exactly why the *rate changing* is the signal rather than the
 *     rate itself.
 *   · **response latency** — how long she takes. A proxy for whether the
 *     routing tier is right for what she is being asked.
 *
 * The third source is the conversation itself, and it does not live here: turns
 * arrive as pushed percepts through `asLangChainMemory().saveContext`, because
 * only the caller holds the text and only the caller knows when a turn ended.
 * That perceptor is declared here with `cadence: 'event'` so it appears in the
 * console roster — a sensor that is only ever pushed to must still be visible,
 * or an operator cannot tell "nobody is talking to Tara" from "the wiring
 * broke".
 */

// ---------------------------------------------------------------------------

/**
 * Declared, never polled — turns are pushed in by the assistant.
 *
 * `sense()` returns nothing by construction. The definition exists so the
 * sensor has a row in the console, a health record, and a stable id that
 * synapses can key on.
 */
export class ConversationPerceptor extends PrismaPerceptor {
  constructor(prisma: PrismaService) {
    super(
      {
        id: 'assistant.conversation',
        domain: 'assistant',
        label: 'Conversation turns',
        description: 'Completed assistant turns, pushed in by the chat path rather than polled. Silence here is normal outside trading hours.',
        cadence: 'event',
        emits: ['conversation_turn'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(): Promise<NewPercept[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------

/**
 * Refusal and error rate for the assistant, against the previous window.
 *
 * The rate itself is not the finding. Tara refuses to give trading advice by
 * design — CORE_GUARDRAILS makes that a contract, not a bug — so a steady
 * refusal rate is a system working correctly. What matters is the rate *moving*:
 * a jump usually means either a prompt change made her over-refuse, or users
 * have started asking a new class of question the guardrails were not written
 * with in mind. Both are worth a human's attention; neither is visible from the
 * absolute number.
 */
export class AssistantRefusalPerceptor extends PrismaPerceptor {
  constructor(prisma: PrismaService) {
    super(
      {
        id: 'assistant.refusals',
        domain: 'assistant',
        label: 'Assistant refusals & errors',
        description: 'Non-ok assistant calls against the previous window. A steady refusal rate is correct behaviour — a change in it is the signal.',
        cadence: 'interval',
        expectedIntervalMs: 10 * 60_000,
        emits: ['refusal_rate_shift', 'assistant_errors'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const prior = priorWindow(context);
    const where = (from: Date, to: Date) => ({ system: 'tradew-ai', createdAt: { gte: from, lt: to } });

    const [nowTotal, nowBad, beforeTotal, beforeBad] = await Promise.all([
      this.prisma.aiCallLog.count({ where: where(context.since, context.until) }),
      this.prisma.aiCallLog.groupBy({
        by: ['status'],
        where: { ...where(context.since, context.until), status: { not: 'ok' } },
        _count: { _all: true },
      }),
      this.prisma.aiCallLog.count({ where: where(prior.since, prior.until) }),
      this.prisma.aiCallLog.count({ where: { ...where(prior.since, prior.until), status: { not: 'ok' } } }),
    ]);

    // Too little traffic to compare. Reporting a shift from 1 call to 2 would be
    // noise dressed up as a finding.
    if (nowTotal < 5 || beforeTotal < 5) return [];

    const badNow = nowBad.reduce((sum, r) => sum + r._count._all, 0);
    const rate = badNow / nowTotal;
    const priorRate = beforeBad / beforeTotal;
    const shift = Math.abs(rate - priorRate);
    // Ten percentage points. Below that, ordinary variation in what users ask.
    if (shift < 0.1) return [];

    const errors = nowBad.filter((r) => r.status === 'error' || r.status === 'timeout').reduce((s, r) => s + r._count._all, 0);

    return [
      this.percept({
        // An error is a fault; a refusal is a policy outcome. Same table, and
        // conflating them would have an operator debugging a provider when the
        // actual change was to a prompt.
        kind: errors > badNow / 2 ? 'assistant_errors' : 'refusal_rate_shift',
        subject: { type: 'agent', id: 'tara', label: 'Tara' },
        observedAt: context.until,
        salience: clamp01(shift * 2),
        confidence: this.sampleConfidence(Math.min(nowTotal, beforeTotal)),
        features: { rate, priorRate, shift, calls: nowTotal, errors, refusals: badNow - errors },
        summary: `Tara non-ok rate ${(rate * 100).toFixed(0)}% over ${nowTotal} calls, was ${(priorRate * 100).toFixed(0)}%`,
        tags: ['assistant', 'guardrails'],
      }),
    ];
  }
}

// ---------------------------------------------------------------------------

/**
 * How long Tara takes to answer, per model tier.
 *
 * Grouped by tier because that is the actionable axis: if `fast` has drifted to
 * deep-tier latency, the router is sending the wrong things to the wrong model,
 * and that is a fix. An ungrouped average would show "the assistant got slower"
 * and point at nothing.
 */
export class AssistantLatencyPerceptor extends PrismaPerceptor {
  constructor(prisma: PrismaService) {
    super(
      {
        id: 'assistant.latency',
        domain: 'assistant',
        label: 'Assistant latency',
        description: 'Assistant response latency grouped by model tier — surfaces a routing decision that has drifted, not just a slow window.',
        cadence: 'interval',
        expectedIntervalMs: 10 * 60_000,
        emits: ['assistant_slow'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const prior = priorWindow(context);
    const [now, before] = await Promise.all([
      this.prisma.aiCallLog.groupBy({
        by: ['tier'],
        where: { system: 'tradew-ai', status: 'ok', createdAt: { gte: context.since, lt: context.until } },
        _avg: { latencyMs: true },
        _count: { _all: true },
      }),
      this.prisma.aiCallLog.groupBy({
        by: ['tier'],
        where: { system: 'tradew-ai', status: 'ok', createdAt: { gte: prior.since, lt: prior.until } },
        _avg: { latencyMs: true },
        _count: { _all: true },
      }),
    ]);

    const baseline = new Map(before.map((r) => [r.tier ?? 'unknown', { avg: r._avg.latencyMs ?? 0, n: r._count._all }]));
    const out: NewPercept[] = [];

    for (const row of now) {
      const tier = row.tier ?? 'unknown';
      const avg = row._avg.latencyMs ?? 0;
      const prev = baseline.get(tier);
      if (!prev || prev.n < 3 || row._count._all < 3) continue;
      const salience = this.deviationSalience(avg, prev.avg, 200);
      if (salience <= 0 || avg < prev.avg * 1.5) continue;

      out.push(
        this.percept({
          kind: 'assistant_slow',
          subject: { type: 'agent', id: `tara/${tier}`, label: `Tara (${tier} tier)` },
          observedAt: context.until,
          salience,
          confidence: this.sampleConfidence(Math.min(row._count._all, prev.n)),
          features: { avgMs: avg, priorAvgMs: prev.avg, calls: row._count._all },
          summary: `Tara ${tier}-tier responses averaging ${Math.round(avg)}ms, up from ${Math.round(prev.avg)}ms`,
          tags: ['assistant', 'latency', tier],
        }),
      );
    }
    return out;
  }
}

export function assistantPerceptors(prisma: PrismaService) {
  return [new ConversationPerceptor(prisma), new AssistantRefusalPerceptor(prisma), new AssistantLatencyPerceptor(prisma)];
}
