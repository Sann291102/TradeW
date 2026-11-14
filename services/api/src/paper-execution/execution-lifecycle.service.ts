import { Injectable, Logger } from '@nestjs/common';
import { ExecutionIntentStatus, ExecutionPositionState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderService } from '../sim/order.service';
import { ExecutionJournalService } from './execution-journal.service';
import { istParts } from './execution-identity';
import { RECOVERY_ORPHANED } from './execution-policy';

/**
 * How long a PROPOSED intent may sit with no order before recovery fails it.
 *
 * Long enough that a normal in-flight submission — createIntent → placeOrder,
 * a few seconds at most — is never mistaken for an orphan and failed out from
 * under the leader that is actively submitting it. Anything older than this
 * that is still PROPOSED-with-no-order is a decision whose process died between
 * claiming the key and placing the order.
 */
export const STALE_PROPOSED_MS = 2 * 60_000;

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
  /**
   * Orphans already reported as held back by an unlinked order. Reconcile runs
   * every 15 s, and the condition persists until an operator acts, so the
   * ERROR is written once per intent per process rather than four times a
   * minute forever.
   */
  private readonly heldOrphansReported = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly journal: ExecutionJournalService,
  ) {}

  /**
   * Advance every in-flight intent to match what the OMS actually did.
   *
   * Idempotent by construction: each transition is guarded by the status it
   * moves FROM, so running this twice in a row is a no-op the second time.
   */
  async reconcile(): Promise<{ filled: number; failed: number; closed: number; recovered: number }> {
    let filled = 0;
    let failed = 0;
    let closed = 0;

    // ---- RESTART RECOVERY: orphaned PROPOSED intents ----------------------
    //
    // Run FIRST, every reconcile, so a crash between claiming a decision and
    // submitting it self-heals on the next tick rather than leaving a decision
    // that is neither an order nor a recorded refusal. In-memory scheduler state
    // is never assumed authoritative — the database is, and this reconciles it.
    const recovered = await this.recoverStuckIntents();

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
        // The managed position is closed in the SAME transaction as the intent
        // and the outcome. A CLOSED intent with an OPEN position row would be
        // re-evaluated by the two-second manager forever, against a position
        // the account no longer holds.
        await tx.executionPosition.updateMany({
          where: { intentId: intent.id },
          data: { state: ExecutionPositionState.CLOSED, unrealizedPnl: 0 },
        });
      });
      closed++;
      this.logger.log(
        `${intent.profile.name}: intent ${intent.id} closed — realized ${realizedPnl.toFixed(2)} over ${holdingSeconds}s.`,
      );

      // ---- The journal, and with it the learning fold --------------------
      //
      // AFTER the transaction, deliberately. Writing the journal inside it
      // would put a calibration read-modify-write inside the transaction that
      // closes a position, so a lock contention on a calibration bucket could
      // roll back the CLOSE of a trade. The journal is a derived record: it
      // can be written a moment later, or rebuilt, and losing it costs a
      // record rather than an accounting.
      try {
        await this.journal.write(intent.id);
      } catch (err) {
        this.logger.error(`journal write failed for intent ${intent.id} (non-fatal)`, err as Error);
      }
    }

    return { filled, failed, closed, recovered };
  }

  /**
   * Fail any PROPOSED intent that never became an order and is older than the
   * staleness window — the classic "process restarted mid-submit" orphan.
   *
   * ## Why this is safe against a live submission
   *
   * A PROPOSED intent that a leader is submitting RIGHT NOW is seconds old; the
   * `STALE_PROPOSED_MS` floor excludes it, so recovery never fails an intent out
   * from under an in-flight `placeOrder`. The update is also conditional on
   * `status: PROPOSED` in the WHERE clause, so an intent that became an order
   * between the read and the write matches zero rows.
   *
   * ## Why an UNLINKED order on the same contract stops recovery
   *
   * `runProfile` links the order to its intent in a transaction AFTER
   * `placeOrder` returns. A crash in that gap leaves a real order (and a real
   * position) with no link, and the intent still PROPOSED. Failing that intent
   * would make it re-claimable — `createIntent` re-claims a FAILED intent with
   * no linked order — and the next pass in the same window could place a SECOND
   * order. So when the account holds an unlinked order for this contract placed
   * at or after the decision, the intent is left PROPOSED (which `createIntent`
   * treats as a genuine duplicate) and the case is logged once for an
   * operator. On a USER_PAPER account the same guard also holds back an orphan
   * when the PERSON bought that contract themselves after the decision — the
   * conservative side to err on, since the cost is a stuck PROPOSED row, not a
   * second position.
   */
  async recoverStuckIntents(now: Date = new Date()): Promise<number> {
    const threshold = new Date(now.getTime() - STALE_PROPOSED_MS);
    const orphans = await this.prisma.executionIntent.findMany({
      where: { status: ExecutionIntentStatus.PROPOSED, order: { is: null }, decidedAt: { lt: threshold } },
      select: {
        id: true,
        decidedAt: true,
        contractSymbol: true,
        profile: { select: { accountUserId: true, name: true } },
      },
    });
    if (orphans.length === 0) return 0;

    let recovered = 0;
    for (const orphan of orphans) {
      const unlinked = await this.prisma.order.findFirst({
        where: {
          userId: orphan.profile.accountUserId,
          executionIntentId: null,
          exitOfIntentId: null,
          instrument: { symbol: orphan.contractSymbol },
          placedAt: { gte: orphan.decidedAt },
        },
        select: { id: true },
      });
      if (unlinked) {
        if (this.heldOrphansReported.has(orphan.id)) continue;
        this.heldOrphansReported.add(orphan.id);
        this.logger.error(
          `${orphan.profile.name}: intent ${orphan.id} is PROPOSED with no linked order, but order ${unlinked.id} ` +
            `for ${orphan.contractSymbol} was placed after the decision — left PROPOSED for an operator rather than ` +
            'failed, because a FAILED intent can be re-claimed into a second order.',
        );
        continue;
      }
      const res = await this.prisma.executionIntent.updateMany({
        // Status in the WHERE clause is the guard: a concurrent submission that
        // moved this to SUBMITTED between the read above and here matches zero
        // rows, so recovery can never clobber an intent that became an order.
        where: { id: orphan.id, status: ExecutionIntentStatus.PROPOSED },
        data: {
          status: ExecutionIntentStatus.FAILED,
          rejectReason:
            'Recovered on reconcile: the decision was proposed but no order was ever submitted — ' +
            'the process most likely restarted between claiming the decision and placing the order.',
          rejectCheckId: RECOVERY_ORPHANED,
        },
      });
      if (res.count === 1) {
        recovered++;
        this.logger.warn(
          `recovered orphaned intent ${orphan.id} (${orphan.contractSymbol}) — proposed but never submitted; marked FAILED.`,
        );
      }
    }
    return recovered;
  }

  /**
   * Flatten every position ANY profile is holding, once the IST clock reaches
   * that profile's `squareOffMinute`.
   *
   * Only positions this loop actually opened are touched, and only on accounts
   * bound to a profile — established by walking this profile's own FILLED
   * intents, never by scanning the account for anything that happens to be open.
   *
   * ## `enabled` is deliberately NOT in this query any more
   *
   * It used to be (`where: { enabled: true, … }`), and that was a real defect
   * rather than a stylistic one. `ExecutionProfile.enabled` gates ENTRIES —
   * it is what "arm" and "disarm" mean in the console. Filtering square-off on
   * it as well meant that disarming an agent that was holding a position
   * STRANDED that position: no square-off, and (before the position manager
   * existed) no stop and no target either, until a human noticed and flattened
   * it by hand. The most dangerous thing an operator could do was the button
   * labelled as the safe one.
   *
   * `PositionManagerService` follows the same rule for the same reason, and
   * `position-decision.ts` cannot even express the old behaviour — it takes no
   * `enabled` flag at all.
   *
   * This is now a BACKSTOP rather than the primary mechanism: the two-second
   * manager squares off at `squareOffMinute` long before this 15-second pass
   * would. It is kept because it walks a different path to the same positions
   * (FILLED intents rather than OPEN position rows), so a position whose
   * `ExecutionPosition` row is somehow missing is still flattened.
   */
  async squareOff(
    now: Date = new Date(),
    // Under the global EMERGENCY_STOP the scheduler passes `forceAll`, and the
    // profile's square-off minute is ignored. The two-second position manager
    // carries out the emergency exit for every position it manages (it holds
    // the atomic OPEN→EXITING claim), so the forced backstop only flattens the
    // FILLED intents the manager cannot see — those with no live
    // `ExecutionPosition` row. Forcing both paths onto the same position would
    // race two exit orders.
    opts: { forceAll?: boolean } = {},
  ): Promise<{ exited: number; errors: number }> {
    const { minuteOfDay } = istParts(now);
    const profiles = await this.prisma.executionProfile.findMany({
      where: { environment: 'PAPER' },
    });

    let exited = 0;
    let errors = 0;

    for (const profile of profiles) {
      const forced = opts.forceAll === true && minuteOfDay < profile.squareOffMinute;
      if (!opts.forceAll && minuteOfDay < profile.squareOffMinute) continue;

      const holding = await this.prisma.executionIntent.findMany({
        where: {
          profileId: profile.id,
          status: ExecutionIntentStatus.FILLED,
          // Forced (emergency) and before the profile's own minute: leave the
          // manager's positions to the manager. See the note on `opts`.
          ...(forced
            ? { OR: [{ position: { is: null } }, { position: { is: { state: ExecutionPositionState.CLOSED } } }] }
            : {}),
        },
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
