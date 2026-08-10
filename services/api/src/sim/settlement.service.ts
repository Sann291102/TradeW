import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LeaderElectionService } from '../common/leader-election';
import { PrismaService } from '../prisma/prisma.service';

const SWEEP_MS = 5 * 60_000; // settlement is date-granular, not price-driven — no need for MatchingEngineService's 3s cadence
/** Lease name — see common/leader-election.ts. */
const SETTLEMENT_SWEEP_JOB = 'settlement-sweep';

/**
 * Weighted-average merge of a newly-settled lot into an existing Holding.
 * Exported for settlement.spec.ts only — pure and dependency-free for the
 * same reason `applyFill` is (see order.service.ts): the money arithmetic
 * should be assertable without a database. Nothing outside this module
 * should call it at runtime.
 */
export function mergeHoldingLot(
  existingQty: number,
  existingAvgCost: number,
  addQty: number,
  addCost: number,
): { newQuantity: number; newAvgCost: number } {
  const newQuantity = existingQty + addQty;
  const newAvgCost = existingQty === 0 ? addCost : (existingQty * existingAvgCost + addQty * addCost) / newQuantity;
  return { newQuantity, newAvgCost };
}

/**
 * Transfers CNC positions into Holdings once their T+1 settlement date
 * clears — the real broker distinction the paper engine previously had no
 * concept of (see the Position/Holding schema comments). Two entry points,
 * one method:
 *
 *  - A `setInterval` sweep (same "plain interval, not @nestjs/schedule"
 *    precedent as MatchingEngineService — settlement needs nothing that
 *    package provides beyond "run every N minutes") over every user with a
 *    position past due.
 *  - A per-request call to `settleUser` from PositionService/HoldingsService
 *    for the requesting user, so a user's own view is never stale between
 *    sweep ticks — settlement is idempotent (a no-op once nothing is due),
 *    so calling it redundantly costs one cheap query, never double-transfers.
 */
@Injectable()
export class SettlementService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: LeaderElectionService,
  ) {}

  onModuleInit(): void {
    this.leader.register(SETTLEMENT_SWEEP_JOB);
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    // Only the SWEEP is leader-gated. The per-request `settleUser` path stays
    // available on every replica — it is idempotent and scoped to the caller,
    // so a follower serving a user's own portfolio read must still be able to
    // settle that user rather than showing them a stale book until the leader
    // next sweeps.
    if (!this.leader.isLeader(SETTLEMENT_SWEEP_JOB)) return;

    let due: Array<{ userId: string }>;
    try {
      due = await this.prisma.position.findMany({
        where: { productType: 'CNC', quantity: { gt: 0 }, settlesAt: { lte: new Date() } },
        select: { userId: true },
        distinct: ['userId'],
      });
    } catch (err) {
      this.logger.error('sweep: failed to load due positions', err as Error);
      return;
    }
    for (const { userId } of due) {
      try {
        await this.settleUser(userId);
      } catch (err) {
        // One user's transfer failing (e.g. a transient DB error mid-transaction)
        // must never block the rest of the sweep.
        this.logger.error(`sweep: failed to settle user ${userId}`, err as Error);
      }
    }
  }

  /**
   * Transfers every one of `userId`'s CNC positions past `settlesAt` into
   * Holding rows (weighted-average merge with any existing holding),
   * flattens the source Position (`quantity: 0, closeReason: 'SETTLED'`,
   * its margin released — settled shares are owned outright, not margined),
   * and writes a HoldingSettlement audit row. One position at a time, each
   * in its own transaction, so one instrument's transfer failing doesn't
   * roll back another's.
   */
  async settleUser(userId: string): Promise<void> {
    const due = await this.prisma.position.findMany({
      where: { userId, productType: 'CNC', quantity: { gt: 0 }, settlesAt: { lte: new Date() } },
    });
    if (due.length === 0) return;

    for (const position of due) {
      await this.prisma.$transaction(async (tx) => {
        const qty = position.quantity;
        const cost = Number(position.avgPrice);

        const existing = await tx.holding.findUnique({
          where: { userId_instrumentId: { userId, instrumentId: position.instrumentId } },
        });
        const { newQuantity, newAvgCost } = mergeHoldingLot(existing?.quantity ?? 0, existing ? Number(existing.avgCost) : 0, qty, cost);

        if (existing) {
          await tx.holding.update({ where: { id: existing.id }, data: { quantity: newQuantity, avgCost: newAvgCost } });
        } else {
          await tx.holding.create({
            data: { userId, instrumentId: position.instrumentId, quantity: newQuantity, avgCost: newAvgCost },
          });
        }

        await tx.holdingSettlement.create({
          data: { userId, instrumentId: position.instrumentId, positionId: position.id, quantity: qty, costPrice: cost },
        });

        if (Number(position.marginUsed) > 0) {
          await tx.paperWallet.update({ where: { userId }, data: { marginUsed: { decrement: position.marginUsed } } });
        }

        await tx.position.update({
          where: { id: position.id },
          data: { quantity: 0, marginUsed: 0, settlesAt: null, closeReason: 'SETTLED' },
        });
      });
    }
  }
}
