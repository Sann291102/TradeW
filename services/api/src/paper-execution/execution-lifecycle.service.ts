import { Injectable, Logger } from '@nestjs/common';
import { ExecutionIntentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderService } from '../sim/order.service';
import { istParts } from './execution-identity';

/**
 * Carries an execution past the order and through to a recorded outcome.
 *
 * `PaperExecutionService` ends at "the order was submitted". That is the point
 * where a naive implementation would declare victory, and it is roughly
 * halfway: a submitted order is not a fill, a fill is not a position, and a
 * position that never closes never produces the outcome the whole loop exists
 * to generate. This service is the second half —
 *
 *     SUBMITTED → (matching engine fills it) → FILLED
 *               → (square-off or exit)       → CLOSED + ExecutionOutcome
 *
 * ## It reads state, it does not compute money
 *
 * Every number recorded here is read from a `Trade` row the existing OMS wrote.
 * The realized P&L on an outcome is the sum of the realized P&L the paper
 * engine itself booked, never a recomputation from entry and exit prices — a
 * second implementation of that arithmetic would drift from the wallet, and
 * then the learning record and the account would disagree about the same trade.
 *
 * ## Exits go through the same door as entries
 *
 * Square-off calls `OrderService.exitPosition`, which places an ordinary MARKET
 * order in the opposite direction. There is no bypass, no direct position
 * write, and no separate close path — so an exit is margin-settled, charged and
 * matched exactly like any other order.
 */
@Injectable()
export class ExecutionLifecycleService {
  private readonly logger = new Logger(ExecutionLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
  ) {}

  /**
   * Advance every in-flight intent to match what the OMS actually did.
   *
   * Idempotent by construction: each transition is guarded by the status it
   * moves FROM, so running this twice in a row is a no-op the second time.
   */
  async reconcile(): Promise<{ filled: number; failed: number; closed: number }> {
    let filled = 0;
    let failed = 0;
    let closed = 0;

    // ---- SUBMITTED → FILLED / FAILED --------------------------------------
    const submitted = await this.prisma.executionIntent.findMany({
      where: { status: ExecutionIntentStatus.SUBMITTED },
      include: { order: true, profile: { select: { accountUserId: true, name: true } } },
    });

    for (const intent of submitted) {
      const order = intent.order;
      if (!order) {
        // SUBMITTED with no order is structurally impossible (the link and the
        // status are written in one transaction), so if it ever happens it is a
        // real inconsistency and must be visible rather than retried forever.
        this.logger.error(`intent ${intent.id} is SUBMITTED with no linked order — marking FAILED`);
        await this.prisma.executionIntent.update({
          where: { id: intent.id },
          data: { status: ExecutionIntentStatus.FAILED, rejectReason: 'Submitted but no order was linked.' },
        });
        failed++;
        continue;
      }

      if (order.status === 'FILLED' && order.avgFillPrice) {
        await this.prisma.$transaction(async (tx) => {
          await tx.executionIntent.update({
            where: { id: intent.id },
            data: { status: ExecutionIntentStatus.FILLED },
          });
          // The console's "last fill" column. Stamped here as well as in the
          // executor because a MARKET order fills inside `placeOrder` while a
          // resting one fills HERE, minutes later — recording it in only one of
          // the two places would show a profile that had never filled anything.
          await tx.executionProfile.update({
            where: { id: intent.profileId },
            data: { lastFillAt: order.updatedAt },
          });
          // `upsert`, not `create`: a MARKET order fills inside `placeOrder`, so
          // `PaperExecutionService` may already have written the entry row. This
          // path is for orders the MATCHING ENGINE filled later.
          await tx.executionOutcome.upsert({
            where: { intentId: intent.id },
            create: {
              intentId: intent.id,
              entryPrice: order.avgFillPrice!,
              quantity: order.filledQuantity,
              realizedPnl: 0,
              charges: order.charges,
              result: 'OPEN',
              exitReason: 'PENDING',
              entryAt: order.updatedAt,
            },
            update: {},
          });
        });
        filled++;
        continue;
      }

      if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(order.status)) {
        await this.prisma.executionIntent.update({
          where: { id: intent.id },
          data: {
            status: ExecutionIntentStatus.FAILED,
            rejectReason: `Order ended ${order.status}${order.rejectReason ? `: ${order.rejectReason}` : ''}.`,
          },
        });
        failed++;
      }
      // Anything still OPEN / TRIGGER_PENDING / PARTIALLY_FILLED is simply
      // still working. Left alone, re-examined next pass.
    }

    // ---- FILLED → CLOSED, once the position is flat ------------------------
    const open = await this.prisma.executionIntent.findMany({
      where: { status: ExecutionIntentStatus.FILLED },
      include: {
        order: { select: { instrumentId: true, productType: true, updatedAt: true } },
        outcome: true,
        profile: { select: { accountUserId: true, name: true } },
      },
    });

    for (const intent of open) {
      if (!intent.order || !intent.outcome) continue;

      const position = await this.prisma.position.findUnique({
        where: {
          userId_instrumentId_productType: {
            userId: intent.profile.accountUserId,
            instrumentId: intent.order.instrumentId,
            productType: intent.order.productType,
          },
        },
        select: { quantity: true },
      });

      // Still holding — nothing to record yet.
      if (position && position.quantity !== 0) continue;

      // Flat. The closing trades are the ones that booked realized P&L on this
      // instrument since the entry filled.
      const entryAt = intent.outcome.entryAt;
      const closingTrades = await this.prisma.trade.findMany({
        where: {
          userId: intent.profile.accountUserId,
          instrumentId: intent.order.instrumentId,
          executedAt: { gte: entryAt },
          realizedPnl: { not: null },
        },
        orderBy: { executedAt: 'asc' },
      });

      if (closingTrades.length === 0) continue; // flat but nothing booked yet

      const realizedPnl = closingTrades.reduce((sum, t) => sum + Number(t.realizedPnl ?? 0), 0);
      const charges = closingTrades.reduce((sum, t) => sum + Number(t.charges), 0) + Number(intent.outcome.charges);
      const last = closingTrades[closingTrades.length - 1];
      const exitAt = last.executedAt;
      const holdingSeconds = Math.max(0, Math.round((exitAt.getTime() - entryAt.getTime()) / 1000));

      await this.prisma.$transaction(async (tx) => {
        await tx.executionOutcome.update({
          where: { intentId: intent.id },
          data: {
            exitPrice: last.fillPrice,
            realizedPnl,
            charges,
            // A scratch is its own outcome, not a small win and not a small
            // loss: collapsing it into either would bias any future calibration
            // that counts win rate.
            result: realizedPnl > 0 ? 'WIN' : realizedPnl < 0 ? 'LOSS' : 'SCRATCH',
            // `squareOff` stamps SQUARE_OFF on the outcome BEFORE it places the
            // exit order, so a reason still reading PENDING here means the
            // position was flattened by something other than this loop — an
            // operator squaring off the account by hand, most likely. Recording
            // that as SQUARE_OFF would attribute a human's exit to the agent
            // and quietly corrupt the one column a future calibration would use
            // to separate "the plan ended it" from "someone else did".
            exitReason: intent.outcome!.exitReason === 'PENDING' ? 'MANUAL' : intent.outcome!.exitReason,
            exitAt,
            holdingSeconds,
          },
        });
        await tx.executionIntent.update({ where: { id: intent.id }, data: { status: ExecutionIntentStatus.CLOSED } });
      });
      closed++;
      this.logger.log(
        `${intent.profile.name}: intent ${intent.id} closed — realized ${realizedPnl.toFixed(2)} over ${holdingSeconds}s.`,
      );
    }

    return { filled, failed, closed };
  }

  /**
   * Flatten every position an enabled profile is holding, once the IST clock
   * reaches that profile's `squareOffMinute`.
   *
   * Only positions this loop actually opened are touched, and only on accounts
   * bound to a profile — established by walking this profile's own FILLED
   * intents, never by scanning the account for anything that happens to be open.
   */
  async squareOff(now: Date = new Date()): Promise<{ exited: number; errors: number }> {
    const { minuteOfDay } = istParts(now);
    // Selected by STATE, and deliberately including PAUSED and DISARMED.
    //
    // Square-off is not execution, it is the RISK CONTROL that closes what
    // execution opened. A profile disarmed at 14:00 with an open position must
    // still be flattened at 15:10 — refusing to square off a stood-down profile
    // would leave an unattended intraday option position overnight, which is
    // the one outcome worse than an unwanted entry.
    //
    // Live profiles are excluded: `OrderService.exitPosition` closes a PAPER
    // position against the paper wallet, and calling it for a position that
    // lives in a broker's book would book a fictional exit against a real
    // holding. Live square-off is the broker's own bracket/GTT, not this loop's.
    const profiles = await this.prisma.executionProfile.findMany({
      where: {
        environment: 'PAPER',
        state: {
          in: ['PAPER_ARMED', 'PAPER_RUNNING', 'PAPER_QUALIFIED', 'PAUSED', 'DISARMED', 'ERROR'],
        },
      },
    });

    let exited = 0;
    let errors = 0;

    for (const profile of profiles) {
      if (minuteOfDay < profile.squareOffMinute) continue;

      const holding = await this.prisma.executionIntent.findMany({
        where: { profileId: profile.id, status: ExecutionIntentStatus.FILLED },
        include: { order: { select: { instrumentId: true, productType: true } } },
      });

      for (const intent of holding) {
        if (!intent.order) continue;
        try {
          const position = await this.prisma.position.findUnique({
            where: {
              userId_instrumentId_productType: {
                userId: profile.accountUserId,
                instrumentId: intent.order.instrumentId,
                productType: intent.order.productType,
              },
            },
            select: { quantity: true },
          });
          if (!position || position.quantity === 0) continue;

          // The ordinary exit path — a MARKET order in the opposite direction,
          // margin-settled and charged like any other.
          const exit = await this.orders.exitPosition(
            profile.accountUserId,
            intent.order.instrumentId,
            intent.order.productType,
          );
          // Link the exit back to the decision it closes.
          //
          // `Order.executionIntentId` cannot carry this: it is @unique and
          // already holds the ENTRY, which is the idempotency guarantee at the
          // order layer. So the exit gets its own nullable column. Without it
          // the console's `source=sentinel` filter matched the loop's entries
          // and none of its exits — the agent appeared to open positions it
          // never closed, which is precisely the shape a real bug would have.
          //
          // Written after the order exists rather than as part of placing it,
          // because `OrderService` knows nothing about intents and must not
          // start to: the arrow points execution → OMS, never back.
          await this.prisma.order.update({
            where: { id: exit.id },
            data: { exitOfIntentId: intent.id },
          });
          await this.prisma.executionOutcome.updateMany({
            where: { intentId: intent.id, exitReason: 'PENDING' },
            data: { exitReason: 'SQUARE_OFF' },
          });
          exited++;
          this.logger.log(`${profile.name}: squared off intent ${intent.id}.`);
        } catch (err) {
          // One position's exit failing (a momentarily unpriceable contract)
          // must never stop the rest from being flattened — the same rule
          // `OrderService.exitAll` follows.
          errors++;
          this.logger.error(`${profile.name}: square-off failed for intent ${intent.id}`, err as Error);
        }
      }
    }

    return { exited, errors };
  }
}
