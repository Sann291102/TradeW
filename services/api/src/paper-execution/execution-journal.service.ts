import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionCalibrationService } from './execution-calibration.service';

/**
 * One row per completed automated paper trade, written once, at the close.
 *
 * ## Why a denormalised snapshot rather than a view
 *
 * Every field here already exists somewhere — on the intent, the outcome, the
 * position, the trail history, the order. A view over those six tables would
 * avoid the duplication and would answer a DIFFERENT question every time it
 * ran: the strategy definition gets a new version, the calibration moves, the
 * profile's risk percentages are retuned, and last month's trade silently
 * starts reporting the levels it would have had under today's configuration.
 *
 * A journal has to say what the agent knew and decided AT THE TIME. That is a
 * snapshot by definition.
 *
 * ## It is not a second source of truth for money
 *
 * `realizedPnl` is copied from `ExecutionOutcome`, which copied it from the
 * `Trade` rows the OMS booked. Three copies of one number is two too many to
 * COMPUTE independently, so none of them is: each is read from the one below.
 * The only number derived here is `rMultiple`, and it is derived from two
 * numbers that are themselves copies.
 *
 * ## Writing it is what closes the learning loop
 *
 * `write()` folds the trade into its calibration bucket and records the
 * version that fold produced. A later `ExecutionIntent` records the version it
 * READ. Those two columns are the whole evidence that an outcome reached a
 * decision — a join, not an assertion.
 */
@Injectable()
export class ExecutionJournalService {
  private readonly logger = new Logger(ExecutionJournalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calibration: ExecutionCalibrationService,
  ) {}

  /**
   * Write the journal entry for a closed intent, and fold it into calibration.
   *
   * Idempotent on `intentId` (unique): a reconcile pass that runs twice over
   * the same close writes one row and folds one trade.
   */
  async write(intentId: string): Promise<{ journalId: string; calibrationKey: string | null; calibrationVersion: number | null } | null> {
    const existing = await this.prisma.executionJournal.findUnique({ where: { intentId }, select: { id: true } });
    if (existing) return null;

    const intent = await this.prisma.executionIntent.findUnique({
      where: { id: intentId },
      include: {
        profile: { select: { id: true, name: true, agent: true, accountUserId: true } },
        outcome: true,
        position: { include: { trailAdjustments: { orderBy: { at: 'asc' } } } },
        order: { select: { instrument: { select: { securityId: true } } } },
      },
    });
    if (!intent || !intent.outcome) return null;

    const outcome = intent.outcome;
    const position = intent.position;
    const realizedPnl = Number(outcome.realizedPnl);
    const riskBudget = intent.riskBudget == null ? null : Number(intent.riskBudget);

    // R is the trade measured in units of what it was ALLOWED to lose — the
    // only quantity comparable across positions of different sizes. Null, not
    // zero, when the budget was not recorded: an unknown denominator makes the
    // ratio unknown, and a 0 there would pull every mean toward the middle.
    const rMultiple = riskBudget != null && riskBudget > 0 ? round3(realizedPnl / riskBudget) : null;

    const trailHistory = (position?.trailAdjustments ?? []).map((t) => ({
      from: t.fromPrice == null ? null : Number(t.fromPrice),
      to: Number(t.toPrice),
      trigger: Number(t.triggerPrice),
      highWater: Number(t.highWaterPrice),
      steps: t.totalSteps,
      reason: t.reason,
      at: t.at.toISOString(),
    }));

    // ---- Fold into calibration FIRST, so the version can be recorded -------
    //
    // The order matters. Writing the journal first and folding afterwards
    // would leave the journal's `calibrationVersion` either null or a guess,
    // and that column is half the evidence that the loop closes.
    let calibrationKey: string | null = null;
    let calibrationVersion: number | null = null;
    if (intent.strategyId && intent.strategyVersion && intent.regime) {
      const folded = await this.calibration.recordOutcome({
        identity: {
          agent: intent.agent,
          symbol: intent.symbol,
          strategyId: intent.strategyId,
          strategyVersion: intent.strategyVersion,
          regime: intent.regime,
        },
        intentId: intent.id,
        result: outcome.result,
        realizedPnl,
        rMultiple,
      });
      calibrationKey = folded?.key ?? null;
      calibrationVersion = folded?.version ?? null;
    }

    const marketSnapshot = (intent.marketSnapshot ?? {}) as Record<string, unknown>;

    const journal = await this.prisma.executionJournal.create({
      data: {
        intentId: intent.id,
        profileId: intent.profile.id,
        userId: intent.profile.accountUserId,
        agent: intent.agent,
        symbol: intent.symbol,
        strategyId: intent.strategyId,
        strategyName: intent.strategyName,
        strategyVersion: intent.strategyVersion,
        regime: intent.regime,

        underlying: intent.symbol,
        expiry: intent.expiry,
        strike: intent.strike,
        optionType: intent.optionType,
        contractSymbol: intent.contractSymbol,
        securityId: intent.order?.instrument?.securityId ?? null,
        lots: intent.lots,
        quantity: intent.quantity,

        indexDirection: intent.indexDirection,
        indexStrength: intent.indexStrength,
        confidence: intent.confidence,
        evidence: (intent.evidence ?? undefined) as Prisma.InputJsonValue | undefined,
        confirmations: (intent.confirmations ?? undefined) as Prisma.InputJsonValue | undefined,
        dataQuality: (intent.dataQuality ?? undefined) as Prisma.InputJsonValue | undefined,
        rationale: intent.rationale,
        publication: (intent.publication ?? undefined) as Prisma.InputJsonValue | undefined,
        optionContext: (intent.optionContext ?? undefined) as Prisma.InputJsonValue | undefined,
        positioning: (intent.positioning ?? undefined) as Prisma.InputJsonValue | undefined,
        positioningJudgement: (intent.positioningJudgement ?? undefined) as Prisma.InputJsonValue | undefined,
        policyChecks: (marketSnapshot.policyChecks ?? undefined) as Prisma.InputJsonValue | undefined,

        walletEquity: intent.walletEquity,
        allocatedCapital: intent.allocatedCapital,
        riskBudget: intent.riskBudget,
        rewardTarget: intent.rewardTarget,
        // The levels AS PLANNED, from the position row where one exists (those
        // were re-derived from the real fill) and from the intent otherwise.
        initialStop: position?.stopPrice ?? intent.stopPrice,
        initialTarget: position?.targetPrice ?? intent.targetPrice,
        riskPlan: (intent.riskPlan ?? undefined) as Prisma.InputJsonValue | undefined,
        fillModel: (intent.fillModel ?? undefined) as Prisma.InputJsonValue | undefined,

        entryAt: outcome.entryAt,
        exitAt: outcome.exitAt,
        entryPrice: outcome.entryPrice,
        exitPrice: outcome.exitPrice,
        trailHistory: trailHistory as unknown as Prisma.InputJsonValue,
        finalTrail: position?.trailPrice ?? null,

        exitReason: outcome.exitReason,
        exitDetail: position?.exitDetail ?? null,
        invalidationReason: outcome.invalidationReason,
        holdingSeconds: outcome.holdingSeconds,

        realizedPnl: outcome.realizedPnl,
        charges: outcome.charges,
        rMultiple,
        result: outcome.result,

        calibrationKey,
        calibrationVersion,
      },
      select: { id: true },
    });

    this.logger.log(
      `journal ${journal.id}: ${intent.contractSymbol} ${outcome.result} ` +
        `${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)}` +
        (rMultiple != null ? ` (${rMultiple >= 0 ? '+' : ''}${rMultiple.toFixed(2)}R)` : '') +
        ` exit=${outcome.exitReason}` +
        (calibrationKey ? ` → calibration ${calibrationKey} v${calibrationVersion}` : ' (no calibration bucket)'),
    );

    return { journalId: journal.id, calibrationKey, calibrationVersion };
  }

  /** The journal, newest first, for the console. */
  async list(params: { limit?: number; profileId?: string; symbol?: string; hours?: number } = {}) {
    const hours = params.hours ?? 24 * 30;
    const rows = await this.prisma.executionJournal.findMany({
      where: {
        ...(params.profileId ? { profileId: params.profileId } : {}),
        ...(params.symbol ? { symbol: params.symbol.toUpperCase() } : {}),
        entryAt: { gte: new Date(Date.now() - hours * 3_600_000) },
      },
      orderBy: { entryAt: 'desc' },
      take: Math.min(Math.max(params.limit ?? 50, 1), 500),
    });

    return rows.map((r) => ({
      id: r.id,
      intentId: r.intentId,
      agent: r.agent,
      symbol: r.symbol,
      strategyId: r.strategyId,
      strategyName: r.strategyName,
      strategyVersion: r.strategyVersion,
      regime: r.regime,
      contractSymbol: r.contractSymbol,
      optionType: r.optionType,
      strike: Number(r.strike),
      quantity: r.quantity,
      indexDirection: r.indexDirection,
      confidence: r.confidence,
      entryAt: r.entryAt.toISOString(),
      exitAt: r.exitAt?.toISOString() ?? null,
      entryPrice: Number(r.entryPrice),
      exitPrice: r.exitPrice == null ? null : Number(r.exitPrice),
      initialStop: r.initialStop == null ? null : Number(r.initialStop),
      initialTarget: r.initialTarget == null ? null : Number(r.initialTarget),
      finalTrail: r.finalTrail == null ? null : Number(r.finalTrail),
      trailHistory: r.trailHistory,
      exitReason: r.exitReason,
      exitDetail: r.exitDetail,
      holdingSeconds: r.holdingSeconds,
      realizedPnl: Number(r.realizedPnl),
      charges: Number(r.charges),
      rMultiple: r.rMultiple == null ? null : Number(r.rMultiple),
      result: r.result,
      riskBudget: r.riskBudget == null ? null : Number(r.riskBudget),
      allocatedCapital: r.allocatedCapital == null ? null : Number(r.allocatedCapital),
      calibrationKey: r.calibrationKey,
      calibrationVersion: r.calibrationVersion,
      evidence: r.evidence,
      confirmations: r.confirmations,
      dataQuality: r.dataQuality,
      fillModel: r.fillModel,
      riskPlan: r.riskPlan,
      rationale: r.rationale,
    }));
  }

  /** One entry in full — every question the audit asks, in one object. */
  async byIntentId(intentId: string) {
    const row = await this.prisma.executionJournal.findUnique({ where: { intentId } });
    return row ?? null;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
