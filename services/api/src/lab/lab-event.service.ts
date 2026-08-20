import { Injectable, Logger } from '@nestjs/common';
import { LabEventKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { defaultSeverity, deriveDedupeKey, isEmittableNow, type LabEventInput } from './lab-events';

/**
 * The Agent Lab's timeline — append-only, idempotent, and the only writer.
 *
 * ## Duplicate delivery is safe by construction
 *
 * `dedupeKey` is unique. A second write of the same event loses on the
 * constraint and this service returns the FIRST row, so a restarted worker, an
 * overlapping tick and two racing replicas all converge on one timeline entry.
 * That is the same mechanism `ExecutionIntent.idempotencyKey` uses, and it is
 * deliberately enforced by Postgres rather than by a read-then-write check,
 * which has a window between the read and the write.
 *
 * ## There is no update path, and there must not be one
 *
 * An event states that something happened at a moment. Correcting it would make
 * the timeline a record of what is currently believed rather than of what
 * occurred, and the entire value of this table is that an administrator can
 * reconstruct a decision months later and trust it. A wrong event is followed
 * by a further event, never edited.
 */
@Injectable()
export class LabEventService {
  private readonly logger = new Logger(LabEventService.name);

  /**
   * Write one event. Returns the stored row, which may be one written earlier.
   *
   * NEVER THROWS TO THE CALLER. The Lab's loop must not die because the
   * timeline could not be written — an observation pass that already happened
   * is a fact, and losing the record of it is bad but losing the loop is worse.
   * A write failure is logged loudly and the pass continues.
   */
  constructor(private readonly prisma: PrismaService) {}

  async emit(input: LabEventInput) {
    if (!isEmittableNow(input.kind)) {
      // A kind that no phase-appropriate code path can produce is a bug in the
      // caller, not a datum. Refusing it is what keeps the control room honest:
      // the brief's one hard requirement is that the timeline shows real
      // activity, and the cheapest way to violate that is to emit a kind whose
      // machinery does not exist yet.
      this.logger.error(
        `refusing to emit ${input.kind}: not emittable in this phase — see EMITTABLE_IN_PHASE_0`,
      );
      return null;
    }

    const dedupeKey = deriveDedupeKey(input);
    const data: Prisma.ExperimentEventCreateInput = {
      kind: input.kind,
      severity: input.severity ?? defaultSeverity(input.kind),
      at: input.at,
      actor: input.actor,
      summary: input.summary,
      symbol: input.symbol ?? null,
      timeframe: input.timeframe ?? null,
      experimentId: input.experimentId ?? null,
      detail: (input.detail ?? undefined) as Prisma.InputJsonValue | undefined,
      dataAvailability: (input.dataAvailability ?? undefined) as Prisma.InputJsonValue | undefined,
      dedupeKey,
      ...(input.profileId ? { profile: { connect: { id: input.profileId } } } : {}),
    };

    try {
      return await this.prisma.experimentEvent.create({ data });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Already recorded. This is the mechanism working, not a fault, so it
        // is not logged as one.
        return this.prisma.experimentEvent.findUnique({ where: { dedupeKey } });
      }
      this.logger.error(`failed to write lab event ${input.kind}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * The timeline, newest first.
   *
   * Newest-first because an operator opening the control room is asking "what
   * is happening", not "what happened first". The UI reverses for display.
   */
  async list(filter: {
    profileId?: string;
    experimentId?: string;
    kind?: LabEventKind;
    symbol?: string;
    since?: Date;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1_000);
    const where: Prisma.ExperimentEventWhereInput = {
      ...(filter.profileId ? { profileId: filter.profileId } : {}),
      ...(filter.experimentId ? { experimentId: filter.experimentId } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.symbol ? { symbol: filter.symbol.toUpperCase() } : {}),
      ...(filter.since ? { recordedAt: { gte: filter.since } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.experimentEvent.findMany({
        where,
        // Ordered by RECORDED time, not market time. The two differ, and a
        // reader scrolling a live feed is following the order things were
        // observed in; `at` is shown on each row so the market instant is never
        // lost. Sorting by `at` would make a backfilled event appear to arrive
        // in the past.
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        include: { profile: { select: { id: true, name: true, symbol: true } } },
      }),
      this.prisma.experimentEvent.count({ where }),
    ]);
    return { total, limit, rows };
  }

  /** Counts by kind over a window — the control room's activity summary. */
  async summary(sinceHours: number) {
    const since = new Date(Date.now() - Math.max(1, sinceHours) * 3_600_000);
    const grouped = await this.prisma.experimentEvent.groupBy({
      by: ['kind'],
      where: { recordedAt: { gte: since } },
      _count: { _all: true },
      _max: { recordedAt: true },
    });
    return grouped
      .map((g) => ({ kind: g.kind, count: g._count._all, lastAt: g._max.recordedAt }))
      .sort((a, b) => b.count - a.count);
  }
}
