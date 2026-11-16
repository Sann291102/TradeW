import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExecutionImprovementStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { istParts } from './execution-identity';
import { rejectCheckLabel } from './execution-policy';
import {
  IMPROVEMENT_KINDS,
  isRiskReducing,
  runLearningCycle,
  type JournalRecord,
  type RejectionRecord,
} from './learning-cycle';
import { splitHoldout, validateCandidate } from './learning-validation';

/**
 * The staged learning pipeline:
 *
 *   EXPERIENCE   ExecutionJournal rows (written by the journal service)
 *        ↓
 *   LEARNING     ExecutionLearningCycle — metrics + observations
 *        ↓
 *   CANDIDATE    ExecutionImprovement (PROPOSED) — inert
 *        ↓
 *   VALIDATION   out-of-sample holdout → VALIDATED | REJECTED | still PROPOSED
 *        ↓
 *   PROMOTION    an OPERATOR applies it. Nothing else can.
 *
 * ## The one rule the whole design exists to enforce
 *
 * No automated path advances anything to PROMOTED. `runDailyCycle` and
 * `validatePending` can only ever move a row to PROPOSED, VALIDATING,
 * VALIDATED or REJECTED. `promote()` is the only writer of PROMOTED and it
 * requires an operator id from the request. Grep for `PROMOTED` — it appears in
 * exactly one method, and that method is reachable only from the admin
 * controller.
 *
 * ## And what a promotion may change
 *
 * Only what the closed `IMPROVEMENT_KINDS` set can express, all of which are
 * risk-neutral or risk-reducing. `promote()` re-checks `isRiskReducing` before
 * writing — not because a loosening kind can currently exist, but so that
 * adding one later fails here loudly rather than silently widening risk.
 */
@Injectable()
export class ExecutionLearningService {
  private readonly logger = new Logger(ExecutionLearningService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run the end-of-session cycle for every profile that traded, or for one.
   *
   * Idempotent per (sessionDate, profileId): re-running replaces the cycle's
   * metrics and report, and candidate creation de-duplicates on the open
   * proposals, so a cron that fires twice does not double-propose.
   */
  async runDailyCycle(args: { sessionDate?: string; profileId?: string; now?: Date } = {}): Promise<
    { sessionDate: string; cycles: { profileId: string; agent: string; trades: number; candidates: number; report: string }[] }
  > {
    const now = args.now ?? new Date();
    const sessionDate = args.sessionDate ?? istParts(now).dayKey;

    const profiles = await this.prisma.executionProfile.findMany({
      where: { ...(args.profileId ? { id: args.profileId } : {}) },
      select: {
        id: true, name: true, agent: true, minConfidence: true,
        trailStepPoints: true, strategyIds: true,
      },
    });

    const cycles: { profileId: string; agent: string; trades: number; candidates: number; report: string }[] = [];

    for (const profile of profiles) {
      const dayStart = new Date(`${sessionDate}T00:00:00+05:30`);
      const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);

      const [todayRows, historyRows, rejections] = await Promise.all([
        this.prisma.executionJournal.findMany({
          where: { profileId: profile.id, entryAt: { gte: dayStart, lt: dayEnd } },
          orderBy: { entryAt: 'asc' },
        }),
        // EVERY trade this profile has ever completed. Candidates come from
        // here, never from the day — see `runLearningCycle`'s doc comment.
        this.prisma.executionJournal.findMany({
          where: { profileId: profile.id },
          orderBy: { entryAt: 'asc' },
        }),
        this.prisma.executionIntent.groupBy({
          by: ['rejectCheckId'],
          where: { profileId: profile.id, decidedAt: { gte: dayStart, lt: dayEnd }, status: 'REJECTED' },
          _count: { _all: true },
        }),
      ]);

      // A profile that has never traded produces no cycle at all. Writing an
      // empty row every night for every profile would bury the sessions that
      // actually contain something.
      if (todayRows.length === 0 && historyRows.length === 0 && rejections.length === 0) continue;

      const result = runLearningCycle({
        sessionDate,
        agent: profile.agent,
        today: todayRows.map(toRecord),
        history: historyRows.map(toRecord),
        rejections: rejections.map(
          (r): RejectionRecord => ({
            checkId: r.rejectCheckId,
            label: rejectCheckLabel(r.rejectCheckId),
            count: r._count._all,
          }),
        ),
        current: {
          minConfidence: profile.minConfidence,
          trailStepPoints: Number(profile.trailStepPoints),
          strategyIds: profile.strategyIds,
        },
      });

      const cycle = await this.prisma.executionLearningCycle.upsert({
        where: { sessionDate_profileId: { sessionDate, profileId: profile.id } },
        create: {
          sessionDate,
          profileId: profile.id,
          agent: profile.agent,
          tradesAnalysed: result.tradesAnalysed,
          wins: result.wins,
          losses: result.losses,
          rejectedSetups: result.rejectedSetups,
          metrics: result.metrics as unknown as Prisma.InputJsonValue,
          observations: result.observations as unknown as Prisma.InputJsonValue,
          report: result.report,
        },
        update: {
          tradesAnalysed: result.tradesAnalysed,
          wins: result.wins,
          losses: result.losses,
          rejectedSetups: result.rejectedSetups,
          metrics: result.metrics as unknown as Prisma.InputJsonValue,
          observations: result.observations as unknown as Prisma.InputJsonValue,
          report: result.report,
        },
        select: { id: true },
      });

      // ---- Candidates, de-duplicated against what is already open ---------
      //
      // A pattern that persists re-derives the same candidate every night. Left
      // alone that would produce a table of identical proposals and an operator
      // who stops reading it, so an equivalent OPEN proposal suppresses the new
      // one. A previously REJECTED one is deliberately NOT suppressed: evidence
      // accumulates, and a proposal the holdout once refuted may later be
      // supported. It is re-proposed and re-validated on the new evidence.
      let created = 0;
      for (const candidate of result.candidates) {
        const existing = await this.prisma.executionImprovement.findFirst({
          where: {
            profileId: profile.id,
            kind: candidate.kind,
            bucketKey: candidate.bucketKey,
            status: { in: [ExecutionImprovementStatus.PROPOSED, ExecutionImprovementStatus.VALIDATING, ExecutionImprovementStatus.VALIDATED, ExecutionImprovementStatus.PROMOTED] },
          },
          select: { id: true },
        });
        if (existing) continue;

        await this.prisma.executionImprovement.create({
          data: {
            cycleId: cycle.id,
            profileId: profile.id,
            agent: profile.agent,
            bucketKey: candidate.bucketKey,
            kind: candidate.kind,
            currentValue: candidate.currentValue as Prisma.InputJsonValue,
            proposedValue: candidate.proposedValue as Prisma.InputJsonValue,
            rationale: candidate.rationale,
            evidence: candidate.evidence as Prisma.InputJsonValue,
            status: ExecutionImprovementStatus.PROPOSED,
          },
        });
        created++;
      }

      this.logger.log(
        `learning cycle ${sessionDate} ${profile.name}: ${result.tradesAnalysed} trade(s), ` +
          `${result.observations.length} observation(s), ${created} new candidate(s) — none applied.`,
      );

      cycles.push({
        profileId: profile.id,
        agent: profile.agent,
        trades: result.tradesAnalysed,
        candidates: created,
        report: result.report,
      });
    }

    return { sessionDate, cycles };
  }

  /**
   * Validate every PROPOSED candidate against out-of-sample history.
   *
   * Moves a row to VALIDATED or REJECTED, or leaves it PROPOSED when the
   * journal cannot settle it. It can never reach PROMOTED from here.
   */
  async validatePending(): Promise<{ validated: number; rejected: number; inconclusive: number }> {
    const pending = await this.prisma.executionImprovement.findMany({
      where: { status: ExecutionImprovementStatus.PROPOSED },
      orderBy: { createdAt: 'asc' },
    });

    let validated = 0;
    let rejected = 0;
    let inconclusive = 0;

    for (const candidate of pending) {
      const history = await this.prisma.executionJournal.findMany({
        where: { ...(candidate.profileId ? { profileId: candidate.profileId } : { agent: candidate.agent }) },
        orderBy: { entryAt: 'asc' },
      });

      // The query above orders by `entryAt`, so the array is already the
      // chronology the split needs.
      const { holdout } = splitHoldout(history.map(toRecord));

      const result = validateCandidate({
        kind: candidate.kind,
        proposedValue: candidate.proposedValue as Record<string, unknown>,
        holdout,
      });

      const status = !result.conclusive
        ? ExecutionImprovementStatus.PROPOSED
        : result.supported
          ? ExecutionImprovementStatus.VALIDATED
          : ExecutionImprovementStatus.REJECTED;

      await this.prisma.executionImprovement.update({
        where: { id: candidate.id },
        data: {
          status,
          validation: result as unknown as Prisma.InputJsonValue,
          validatedAt: new Date(),
          rejectedReason: status === ExecutionImprovementStatus.REJECTED ? result.reason : null,
        },
      });

      if (status === ExecutionImprovementStatus.VALIDATED) validated++;
      else if (status === ExecutionImprovementStatus.REJECTED) rejected++;
      else inconclusive++;
    }

    if (pending.length > 0) {
      this.logger.log(
        `validated ${pending.length} candidate(s): ${validated} supported, ${rejected} refuted, ${inconclusive} inconclusive. None applied.`,
      );
    }
    return { validated, rejected, inconclusive };
  }

  /**
   * Apply a VALIDATED improvement. THE ONLY WRITER OF `PROMOTED`.
   *
   * Requires an operator, requires the candidate to have survived out-of-sample
   * validation, and re-checks that the kind is risk-reducing before it writes.
   * A candidate that is merely PROPOSED — including one validation could not
   * settle — is refused here, which is what stops an unvalidatable idea from
   * being waved through.
   */
  async promote(id: string, operator: string): Promise<{ id: string; kind: string; applied: string }> {
    const candidate = await this.prisma.executionImprovement.findUnique({ where: { id } });
    if (!candidate) throw new NotFoundException(`No improvement ${id}`);

    if (candidate.status !== ExecutionImprovementStatus.VALIDATED) {
      throw new BadRequestException(
        `Improvement ${id} is ${candidate.status}, not VALIDATED. Only a candidate that survived out-of-sample ` +
          'validation may be promoted; run validation first, or reject it.',
      );
    }
    if (!isRiskReducing(candidate.kind)) {
      // Unreachable today — every member of the closed set is risk-reducing or
      // neutral. It exists so that ADDING a loosening kind fails loudly here
      // instead of quietly widening risk through the promotion path.
      throw new BadRequestException(
        `Improvement kind "${candidate.kind}" is not declared risk-reducing and cannot be promoted.`,
      );
    }
    if (!candidate.profileId) {
      throw new BadRequestException(`Improvement ${id} names no profile, so there is nothing to apply it to.`);
    }

    const proposed = candidate.proposedValue as Record<string, unknown>;
    let applied: string;

    if (candidate.kind === IMPROVEMENT_KINDS.CONFIDENCE_FLOOR_RAISE) {
      const profile = await this.prisma.executionProfile.findUniqueOrThrow({
        where: { id: candidate.profileId },
        select: { minConfidence: true },
      });
      const next = Number(proposed.minConfidence);
      // RAISE ONLY. The proposal cannot express a reduction, and this refuses
      // one anyway — a stale candidate whose profile has since been tightened
      // by hand must not drag the floor back down.
      if (!Number.isFinite(next) || next <= profile.minConfidence) {
        throw new BadRequestException(
          `Refused: ${next} is not above the profile's current ${profile.minConfidence}% floor. ` +
            'A confidence-floor improvement may only ever raise it.',
        );
      }
      await this.prisma.executionProfile.update({
        where: { id: candidate.profileId },
        data: { minConfidence: next },
      });
      applied = `minConfidence ${profile.minConfidence} → ${next}`;
    } else if (candidate.kind === IMPROVEMENT_KINDS.STRATEGY_REGIME_DISABLE) {
      // Recorded, not auto-applied to the roster.
      //
      // `strategyIds` is regime-BLIND: removing the strategy outright would
      // also stop it trading in the regimes where it works, which is a bigger
      // change than the evidence supports. The honest action is to record the
      // promotion and surface it, until the roster itself can be keyed by
      // regime. Stated plainly rather than pretending a config change happened.
      applied =
        `recorded: ${String(proposed.strategyId)} is not to be traded in a ${String(proposed.regime)} regime. ` +
        'Not auto-applied — the strategy roster is regime-blind, so removing it would also stop the regimes where it works.';
    } else if (candidate.kind === IMPROVEMENT_KINDS.TRAIL_STEP_TIGHTEN) {
      // Unreachable while journal validation returns inconclusive for this
      // kind, so it can never be VALIDATED. Kept for when a backtest replay
      // supplies the missing evidence.
      const next = Number(proposed.trailStepPoints);
      const profile = await this.prisma.executionProfile.findUniqueOrThrow({
        where: { id: candidate.profileId },
        select: { trailStepPoints: true },
      });
      if (!Number.isFinite(next) || next <= 0 || next >= Number(profile.trailStepPoints)) {
        throw new BadRequestException(
          `Refused: a trail-step improvement may only tighten (${next} is not below ${Number(profile.trailStepPoints)}).`,
        );
      }
      await this.prisma.executionProfile.update({
        where: { id: candidate.profileId },
        data: { trailStepPoints: next },
      });
      applied = `trailStepPoints ${Number(profile.trailStepPoints)} → ${next}`;
    } else {
      throw new BadRequestException(`No promotion path is defined for kind "${candidate.kind}".`);
    }

    await this.prisma.executionImprovement.update({
      where: { id },
      data: {
        status: ExecutionImprovementStatus.PROMOTED,
        promotedAt: new Date(),
        promotedBy: operator,
      },
    });

    this.logger.warn(`improvement ${id} PROMOTED by ${operator}: ${applied}`);
    return { id, kind: candidate.kind, applied };
  }

  /** Refuse a candidate outright. An operator act, recorded with its reason. */
  async reject(id: string, operator: string, reason: string): Promise<{ id: string }> {
    const candidate = await this.prisma.executionImprovement.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!candidate) throw new NotFoundException(`No improvement ${id}`);
    if (candidate.status === ExecutionImprovementStatus.PROMOTED) {
      throw new BadRequestException('That improvement has already been promoted and cannot be rejected retroactively.');
    }
    await this.prisma.executionImprovement.update({
      where: { id },
      data: {
        status: ExecutionImprovementStatus.REJECTED,
        rejectedReason: `Rejected by ${operator}: ${reason}`,
      },
    });
    return { id };
  }

  /** The cycles, newest first, for the console. */
  async cycles(params: { profileId?: string; limit?: number } = {}) {
    return this.prisma.executionLearningCycle.findMany({
      where: { ...(params.profileId ? { profileId: params.profileId } : {}) },
      orderBy: { sessionDate: 'desc' },
      take: Math.min(Math.max(params.limit ?? 30, 1), 200),
    });
  }

  /** Candidate improvements, newest first, optionally by status. */
  async improvements(params: { status?: string; profileId?: string; limit?: number } = {}) {
    return this.prisma.executionImprovement.findMany({
      where: {
        ...(params.profileId ? { profileId: params.profileId } : {}),
        ...(params.status ? { status: params.status as ExecutionImprovementStatus } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(params.limit ?? 50, 1), 200),
    });
  }
}

/** The journal row as the pure modules want it. */
function toRecord(row: {
  id: string;
  strategyId: string | null;
  strategyName: string | null;
  strategyVersion: string | null;
  regime: string | null;
  result: string;
  rMultiple: Prisma.Decimal | null;
  realizedPnl: Prisma.Decimal;
  exitReason: string;
  confidence: number;
  thesisCorrect: boolean | null;
  mfeR: Prisma.Decimal | null;
  maeR: Prisma.Decimal | null;
  entrySlippage: Prisma.Decimal | null;
  holdingSeconds: number | null;
  postTradeAnalysis: Prisma.JsonValue;
}): JournalRecord {
  const analysis = (row.postTradeAnalysis ?? {}) as { difference?: { giveBackPct?: number | null } };
  return {
    id: row.id,
    strategyId: row.strategyId,
    strategyName: row.strategyName,
    strategyVersion: row.strategyVersion,
    regime: row.regime,
    result: row.result,
    rMultiple: row.rMultiple == null ? null : Number(row.rMultiple),
    realizedPnl: Number(row.realizedPnl),
    exitReason: row.exitReason,
    confidence: row.confidence,
    thesisCorrect: row.thesisCorrect,
    mfeR: row.mfeR == null ? null : Number(row.mfeR),
    maeR: row.maeR == null ? null : Number(row.maeR),
    entrySlippage: row.entrySlippage == null ? null : Number(row.entrySlippage),
    giveBackPct: analysis.difference?.giveBackPct ?? null,
    holdingSeconds: row.holdingSeconds,
  };
}
