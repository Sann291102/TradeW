import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PositionService } from '../sim/position.service';

/**
 * The execution trace — the full provenance of one paper order, backward to the
 * Sentinel run that produced it and forward to the outcome it became.
 *
 * ## Every edge here is a foreign key
 *
 * The requirement this service exists to satisfy is that traceability must not
 * rest on timestamps or text matching. It does not:
 *
 *     Order.executionIntentId          → ExecutionIntent      (unique FK)
 *     ExecutionStrikeCandidate.intentId → ExecutionIntent      (FK, cascade)
 *     ExecutionOutcome.intentId         → ExecutionIntent      (unique FK)
 *     ExecutionIntent.profileId         → ExecutionProfile     (FK)
 *     ExecutionProfile.accountUserId    → User                 (FK)
 *     Trade.orderId                     → Order                (FK)
 *
 * The one deliberate exception is `ExecutionIntent.sentinelRunId`, a plain
 * reference rather than an FK — `AgentRun` is telemetry on a retention
 * schedule, and an intent must outlive its telemetry. So the trace reports the
 * run when the row is still there and says so plainly when it has aged out,
 * rather than failing or pretending the link never existed.
 *
 * ## Nothing here is decorative
 *
 * Each stage carries `present: false` when its data genuinely does not exist
 * (an intent that never became an order, a position still open and therefore
 * without an outcome). A stage is never synthesised to make the timeline look
 * complete — an operator reading this needs to be able to tell "this did not
 * happen" from "this happened and we did not record it".
 */

export interface TraceStage {
  id: string;
  label: string;
  present: boolean;
  at: string | null;
  summary: string;
  detail?: Record<string, unknown>;
}

@Injectable()
export class ExecutionTraceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly positions: PositionService,
  ) {}

  /** Trace from an ORDER id — the console's entry point when an operator clicks a row. */
  async byOrderId(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      // Either link resolves to the same decision. An agent's square-off has no
      // `executionIntentId` (that column is @unique and holds the ENTRY), so
      // looking only there made every agent EXIT untraceable — the console
      // offered no trace on exactly the orders whose provenance is least
      // obvious from the row itself.
      select: { executionIntentId: true, exitOfIntentId: true },
    });
    if (!order) throw new NotFoundException(`No order ${orderId}`);
    const intentId = order.executionIntentId ?? order.exitOfIntentId;
    if (!intentId) {
      throw new NotFoundException(
        `Order ${orderId} was not produced by the execution loop — it has no execution intent. ` +
          'Manually placed orders have no Sentinel provenance to trace.',
      );
    }
    return this.byIntentId(intentId);
  }

  async byIntentId(intentId: string) {
    const intent = await this.prisma.executionIntent.findUnique({
      where: { id: intentId },
      include: {
        profile: { include: { account: { select: { id: true, email: true } } } },
        candidates: { orderBy: { strike: 'asc' } },
        outcome: true,
        order: { include: { instrument: true, trades: { orderBy: { executedAt: 'asc' } } } },
      },
    });
    if (!intent) throw new NotFoundException(`No execution intent ${intentId}`);

    const run = intent.sentinelRunId
      ? await this.prisma.agentRun.findUnique({ where: { runId: intent.sentinelRunId } })
      : null;

    // The live position, when one is still open. Read through the SAME
    // PositionService the trader-facing positions screen uses, so the P&L on a
    // trace and the P&L on a positions page can never disagree.
    const livePositions = intent.order
      ? await this.positions.list(intent.profile.accountUserId).catch(() => [])
      : [];
    const livePosition = intent.order
      ? livePositions.find((p) => p.instrumentId === intent.order!.instrumentId) ?? null
      : null;

    const stages: TraceStage[] = [
      {
        id: 'market',
        label: 'Market',
        present: intent.underlyingSpot != null,
        at: intent.decidedAt.toISOString(),
        summary:
          intent.underlyingSpot != null
            ? `${intent.symbol} at ${Number(intent.underlyingSpot).toFixed(2)}`
            : `${intent.symbol} — no spot recorded for this decision`,
        detail: (intent.marketSnapshot as Record<string, unknown>) ?? undefined,
      },
      {
        id: 'sentinel',
        label: 'Sentinel run',
        present: run != null,
        at: run?.startedAt.toISOString() ?? null,
        summary: run
          ? `Run ${run.runId} — ${run.agentsRan.length} agents, ${run.status}, ${run.durationMs ?? '?'}ms`
          : intent.sentinelRunId
            ? // Two different causes, and this code cannot distinguish them, so it
              // must not pick one. Retention pruning is the expected cause for an
              // OLD intent; for a recent one it means no AgentRun row was ever
              // written — which is the case whenever the run originated inside
              // `services/sentinel`, since only `services/api` installs the
              // ai-core telemetry sink (see TelemetryService). The correlation
              // ID below is durable either way; only the enrichment is missing.
              `Run ${intent.sentinelRunId} is referenced, but no AgentRun row is present for it — ` +
              'either it has been pruned by telemetry retention, or the run originated in a process ' +
              'with no telemetry sink installed. The run id itself is recorded on the intent.'
            : 'No Sentinel run id was recorded for this intent.',
        detail: run
          ? { runId: run.runId, agentsRan: run.agentsRan, surfaced: run.surfaced, confidence: run.confidence, trigger: run.trigger }
          : undefined,
      },
      {
        id: 'strategy',
        label: 'Strategy',
        present: intent.strategyName != null || intent.strategyId != null,
        at: intent.decidedAt.toISOString(),
        summary: intent.strategyName ?? intent.strategyId ?? 'Sentinel chose its own strategy context (auto mode).',
      },
      {
        id: 'strikes',
        label: 'Three-strike evaluation',
        present: intent.candidates.length > 0,
        at: intent.decidedAt.toISOString(),
        summary: intent.candidates.length
          ? `${intent.candidates.length} candidates evaluated; ${intent.candidates.filter((c) => c.tradable).length} tradable.`
          : 'No candidates were recorded.',
        detail: {
          candidates: intent.candidates.map((c) => ({
            role: c.role,
            strike: Number(c.strike),
            optionType: c.optionType,
            premium: c.premium != null ? Number(c.premium) : null,
            openInterest: c.openInterest != null ? Number(c.openInterest) : null,
            volume: c.volume != null ? Number(c.volume) : null,
            impliedVol: c.impliedVol,
            moneyness: c.moneyness != null ? Number(c.moneyness) : null,
            tradable: c.tradable,
            selected: c.selected,
            reason: c.reason,
            checks: c.checks,
          })),
        },
      },
      {
        id: 'side-in-focus',
        label: 'Side in Focus',
        present: true,
        at: intent.decidedAt.toISOString(),
        summary: `${intent.bias} — ${intent.optionType} at ${intent.confidence}% confidence`,
        detail: {
          bias: intent.bias,
          side: intent.optionType,
          strike: Number(intent.strike),
          confidence: intent.confidence,
          rationale: intent.rationale,
          optionContext: intent.optionContext,
          publication: intent.publication,
        },
      },
      {
        id: 'intent',
        label: 'Execution intent',
        present: true,
        at: intent.decidedAt.toISOString(),
        summary: `${intent.side} ${intent.quantity} ${intent.contractSymbol} (${intent.status})`,
        detail: {
          idempotencyKey: intent.idempotencyKey,
          environment: intent.environment,
          lots: intent.lots,
          quantity: intent.quantity,
          productType: intent.productType,
          orderType: intent.orderType,
          rejectReason: intent.rejectReason,
        },
      },
      {
        id: 'profile',
        label: 'Execution profile & account',
        present: true,
        at: null,
        summary: `${intent.profile.name} (${intent.profile.agent}) → ${intent.profile.account.email} [${intent.profile.environment}]`,
        detail: {
          agent: intent.profile.agent,
          environment: intent.profile.environment,
          accountEmail: intent.profile.account.email,
          lots: intent.profile.lots,
          minConfidence: intent.profile.minConfidence,
          maxOpenPositions: intent.profile.maxOpenPositions,
          maxOrdersPerDay: intent.profile.maxOrdersPerDay,
          maxLossPerDay: Number(intent.profile.maxLossPerDay),
        },
      },
      {
        id: 'risk',
        label: 'Risk & policy validation',
        // The policy record is kept on the intent's snapshot, so it survives
        // alongside the decision it governed rather than only in a log line.
        present: Array.isArray((intent.marketSnapshot as Record<string, unknown>)?.policyChecks),
        at: intent.decidedAt.toISOString(),
        summary:
          intent.status === 'REJECTED'
            ? `Rejected: ${intent.rejectReason ?? 'policy'}`
            : 'All policy checks passed.',
        detail: { checks: (intent.marketSnapshot as Record<string, unknown>)?.policyChecks },
      },
      {
        id: 'order',
        label: 'Order',
        present: intent.order != null,
        at: intent.order?.placedAt.toISOString() ?? null,
        summary: intent.order
          ? `${intent.order.status} — ${intent.order.side} ${intent.order.quantity} ${intent.order.instrument.symbol}`
          : intent.status === 'REJECTED'
            ? 'No order was created — the intent was rejected by policy before submission.'
            : 'No order was created.',
        detail: intent.order
          ? {
              orderId: intent.order.id,
              status: intent.order.status,
              type: intent.order.type,
              quantity: intent.order.quantity,
              filledQuantity: intent.order.filledQuantity,
              avgFillPrice: intent.order.avgFillPrice != null ? Number(intent.order.avgFillPrice) : null,
              charges: Number(intent.order.charges),
              slippage: intent.order.slippage != null ? Number(intent.order.slippage) : null,
              rejectReason: intent.order.rejectReason,
            }
          : undefined,
      },
      {
        id: 'fill',
        label: 'Matching engine & fill',
        present: (intent.order?.trades.length ?? 0) > 0,
        at: intent.order?.trades[0]?.executedAt.toISOString() ?? null,
        summary: intent.order?.trades.length
          ? `${intent.order.trades.length} fill(s), ${intent.order.trades.reduce((n, t) => n + t.quantity, 0)} qty`
          : 'Not filled.',
        detail: {
          trades: (intent.order?.trades ?? []).map((t) => ({
            id: t.id,
            quantity: t.quantity,
            fillPrice: Number(t.fillPrice),
            charges: Number(t.charges),
            realizedPnl: t.realizedPnl != null ? Number(t.realizedPnl) : null,
            executedAt: t.executedAt.toISOString(),
          })),
        },
      },
      {
        id: 'position',
        label: 'Position & P&L',
        present: livePosition != null,
        at: null,
        summary: livePosition
          ? `${livePosition.quantity} @ ${livePosition.avgPrice} — MTM ${livePosition.mtm} (${livePosition.positionStatus})`
          : intent.outcome
            ? 'Position closed.'
            : 'No open position.',
        detail: livePosition ? (livePosition as unknown as Record<string, unknown>) : undefined,
      },
      {
        id: 'outcome',
        label: 'Outcome',
        present: intent.outcome != null && intent.outcome.result !== 'OPEN',
        at: intent.outcome?.exitAt?.toISOString() ?? null,
        summary: intent.outcome
          ? intent.outcome.result === 'OPEN'
            ? 'Still open — no outcome recorded yet.'
            : `${intent.outcome.result} ${Number(intent.outcome.realizedPnl).toFixed(2)} over ${intent.outcome.holdingSeconds ?? '?'}s (${intent.outcome.exitReason})`
          : 'No outcome recorded.',
        detail: intent.outcome
          ? {
              entryPrice: Number(intent.outcome.entryPrice),
              exitPrice: intent.outcome.exitPrice != null ? Number(intent.outcome.exitPrice) : null,
              quantity: intent.outcome.quantity,
              realizedPnl: Number(intent.outcome.realizedPnl),
              charges: Number(intent.outcome.charges),
              result: intent.outcome.result,
              exitReason: intent.outcome.exitReason,
              invalidationReason: intent.outcome.invalidationReason,
              holdingSeconds: intent.outcome.holdingSeconds,
            }
          : undefined,
      },
    ];

    return {
      intentId: intent.id,
      orderId: intent.order?.id ?? null,
      status: intent.status,
      environment: intent.environment,
      symbol: intent.symbol,
      contractSymbol: intent.contractSymbol,
      agent: intent.profile.agent,
      profileName: intent.profile.name,
      decidedAt: intent.decidedAt.toISOString(),
      stages,
    };
  }
}
