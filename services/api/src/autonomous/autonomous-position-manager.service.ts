/**
 * Managing an open autonomous paper position — and nothing else.
 *
 * ## What it may do
 *
 * Advance the trailing stop, and close the position when the plan says to.
 * That is the whole mandate.
 *
 * ## What it may NOT do, and why that is enforced here
 *
 * It never re-runs entry logic, never re-derives a setup, never widens a stop,
 * never extends a target, never switches strategy. §14 and §15 exist because
 * an engine that keeps re-deciding an open trade is not managing it — it is
 * arguing with its earlier self, and the earlier self had the discipline of a
 * risk gate behind it.
 *
 * Structurally: this service has no `SetupScannerService`, no
 * `ContractSelectorService`, and no access to `deriveLevels`. The only plan it
 * can read is the one already written on the trade row.
 *
 * ## The stop only ever ratchets forward
 *
 * `updateTrailingStop` guarantees that in the maths; this service preserves it
 * across restarts by holding `currentStop` and `highWaterPrice` on the row
 * rather than in memory. A process that dies mid-trade comes back, reads the
 * row, and continues from exactly where it was — it cannot reset a ratchet
 * that had already locked in profit.
 *
 * ## The exit rules are the backtester's
 *
 * A bar spanning both the stop and the target is a STOP, and a gap through the
 * stop fills at the open. Restating them here rather than importing them would
 * create a second set of conclusions free to drift from the first, so the
 * ordering below deliberately mirrors `execution-simulator.ts`.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DEFAULT_TRAILING, advanceHighWater, updateTrailingStop } from '@tradew/strategy-core';
import { isVenueOpen, tradableSpec, venueMinutesToClose } from '@tradew/market-data';
import { PrismaService } from '../prisma/prisma.service';
import { OrderService } from '../sim/order.service';
import { MarketPriceService } from '../sim/market-price.service';

/** Minutes before the venue close at which an open position is squared off. */
export const SQUARE_OFF_MINUTES_BEFORE_CLOSE = 20;

export type AutonomousExitReason = 'STOP' | 'TARGET' | 'TRAIL' | 'SQUARE_OFF' | 'MARKET_UNAVAILABLE';

export interface ManageSummary {
  evaluated: number;
  trailed: number;
  exited: number;
  held: number;
  errors: number;
}

@Injectable()
export class AutonomousPositionManagerService {
  private readonly logger = new Logger(AutonomousPositionManagerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly marketPrice: MarketPriceService,
  ) {}

  /**
   * Advance every open autonomous position.
   *
   * Open positions are discovered from the DATABASE on every pass, not from
   * memory — which is what makes restart recovery automatic rather than a
   * separate code path that could rot. A process that comes up mid-session
   * finds its positions on the first tick.
   */
  async manageAll(now: Date = new Date()): Promise<ManageSummary> {
    const open = await this.prisma.autonomousTrade.findMany({
      where: { positionStatus: 'OPEN' },
      orderBy: { entryAt: 'asc' },
    });

    const summary: ManageSummary = { evaluated: open.length, trailed: 0, exited: 0, held: 0, errors: 0 };

    for (const trade of open) {
      try {
        const outcome = await this.manageOne(trade, now);
        if (outcome === 'exited') summary.exited += 1;
        else if (outcome === 'trailed') summary.trailed += 1;
        else summary.held += 1;
      } catch (err) {
        summary.errors += 1;
        this.logger.error(
          `manage ${trade.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return summary;
  }

  private async manageOne(
    trade: Prisma.AutonomousTradeGetPayload<Record<string, never>>,
    now: Date,
  ): Promise<'held' | 'trailed' | 'exited'> {
    const spec = tradableSpec(trade.symbol);
    const venue = spec?.venue ?? 'NSE';

    // ---- Price the CONTRACT, not the underlying ---------------------------
    let ltp: number | null = null;
    let marketOpen = false;
    try {
      const instrument = await this.marketPrice.resolveInstrument(trade.tradedSymbol);
      const price = await this.marketPrice.getPrice(instrument);
      ltp = price.ltp;
      marketOpen = price.marketOpen;
    } catch {
      // A position we cannot price is a position we cannot manage. Holding is
      // the safe direction — an exit at a made-up price is worse than a late
      // one, and the next tick will try again.
      this.logger.warn(`${trade.tradedSymbol}: unpriceable this tick — holding.`);
      return 'held';
    }

    const direction = trade.direction === 'long' ? 'long' : 'short';
    const entry = Number(trade.actualFillPrice ?? trade.plannedEntry);
    const initialRisk = Math.abs(entry - Number(trade.initialStop));
    const currentStop = Number(trade.currentStop);
    const target = Number(trade.initialTarget);

    // ---- Square-off before the venue closes -------------------------------
    const minutesToClose = venueMinutesToClose(venue, now);
    if (
      !isVenueOpen(venue, now) ||
      (minutesToClose !== null && minutesToClose <= SQUARE_OFF_MINUTES_BEFORE_CLOSE)
    ) {
      // Checked FIRST: a position the clock has already closed must not be
      // credited with a target the rest of the session happened to reach.
      await this.close(trade, ltp, 'SQUARE_OFF', now, `Venue ${venue} closing — squared off at ${ltp}.`);
      return 'exited';
    }
    if (!marketOpen) {
      return 'held';
    }

    // ---- Exits, in the backtester's pessimistic order ---------------------
    const hitStop = direction === 'long' ? ltp <= currentStop : ltp >= currentStop;
    if (hitStop) {
      const reason: AutonomousExitReason = trade.trailActivated ? 'TRAIL' : 'STOP';
      await this.close(trade, ltp, reason, now, `Price ${ltp} reached the ${reason.toLowerCase()} at ${currentStop}.`);
      return 'exited';
    }

    const hitTarget = direction === 'long' ? ltp >= target : ltp <= target;
    if (hitTarget) {
      await this.close(trade, ltp, 'TARGET', now, `Price ${ltp} reached the ${trade.plannedRR}R target at ${target}.`);
      return 'exited';
    }

    // ---- The ratchet ------------------------------------------------------
    const highWater = advanceHighWater(
      direction,
      Number(trade.highWaterPrice ?? entry),
      direction === 'long' ? ltp : Number(trade.highWaterPrice ?? entry),
      direction === 'short' ? ltp : Number(trade.highWaterPrice ?? entry),
    );

    const trail = updateTrailingStop({
      direction,
      entry,
      initialRisk,
      currentStop,
      highWaterPrice: highWater,
      config: DEFAULT_TRAILING,
    });

    if (!trail.moved) {
      // `lastManagedAt` is stamped on EVERY pass, including one that changed
      // nothing.
      //
      // Writing only on a change made "managed, nothing to do" and "not managed
      // at all" look identical in the table — and a silent management loop is
      // exactly the failure that let a frozen scheduler go unnoticed for three
      // hours in September. One small write a minute per open position is a
      // cheap price for being able to tell a live manager from a dead one.
      //
      // The high-water mark advances here too even when the stop does not: it
      // is what the NEXT evaluation ratchets from.
      await this.prisma.autonomousTrade.update({
        where: { id: trade.id },
        data: { highWaterPrice: new Prisma.Decimal(highWater), lastManagedAt: now },
      });
      return 'held';
    }

    await this.prisma.autonomousTrade.update({
      where: { id: trade.id },
      data: {
        currentStop: new Prisma.Decimal(trail.stop),
        highWaterPrice: new Prisma.Decimal(highWater),
        trailSteps: trail.stepsReached,
        trailActivated: true,
        lastManagedAt: now,
      },
    });
    this.logger.log(`TRAIL ${trade.tradedSymbol}: ${trail.reason}`);
    return 'trailed';
  }

  /**
   * Close the position through the same paper OMS that opened it, and record
   * the realised result measured from the ACTUAL fill.
   */
  private async close(
    trade: Prisma.AutonomousTradeGetPayload<Record<string, never>>,
    ltp: number,
    reason: AutonomousExitReason,
    now: Date,
    detail: string,
  ): Promise<void> {
    const entry = Number(trade.actualFillPrice ?? trade.plannedEntry);
    const initialRisk = Math.abs(entry - Number(trade.initialStop));

    let exitPrice = ltp;
    let exitOrderId: string | null = null;
    let realizedPnl: number | null = null;
    let charges: number | null = null;

    try {
      const profile = await this.prisma.executionProfile.findFirst({
        where: { agent: 'autonomous-brain', symbol: trade.symbol },
        select: { accountUserId: true, productType: true },
      });
      if (profile) {
        // A long option is closed by SELLing it — the same ticket a human
        // would use, through the same OMS.
        const order = await this.orders.placeOrder(profile.accountUserId, {
          symbol: trade.tradedSymbol,
          side: 'SELL',
          quantity: trade.filledQuantity ?? trade.quantity,
          type: 'MARKET',
          productType: profile.productType,
        });
        exitOrderId = order.id;
        if (order.avgFillPrice != null) exitPrice = Number(order.avgFillPrice);
        charges = order.charges == null ? null : Number(order.charges);
      }
    } catch (err) {
      // The position is closed in OUR book regardless: leaving it OPEN after
      // deciding to exit would keep trailing a trade the plan has ended.
      this.logger.error(
        `exit order for ${trade.tradedSymbol} failed (${err instanceof Error ? err.message : String(err)}) — recording the exit anyway.`,
      );
    }

    const qty = trade.filledQuantity ?? trade.quantity;
    const move = trade.direction === 'long' ? exitPrice - entry : entry - exitPrice;
    realizedPnl = Math.round(move * qty * 100) / 100 - (charges ?? 0);
    // Measured from the ACTUAL fill, never the planned entry — that gap is the
    // slippage, and folding it away would flatter every result.
    const realizedR = initialRisk > 0 ? Math.round((move / initialRisk) * 1000) / 1000 : null;

    const mfePrice = Number(trade.highWaterPrice ?? entry);
    const mfeMove = trade.direction === 'long' ? mfePrice - entry : entry - mfePrice;

    await this.prisma.autonomousTrade.update({
      where: { id: trade.id },
      data: {
        positionStatus: 'CLOSED',
        exitOrderId,
        exitPrice: new Prisma.Decimal(exitPrice),
        exitAt: now,
        exitReason: reason,
        realizedPnl: new Prisma.Decimal(realizedPnl),
        charges: charges == null ? null : new Prisma.Decimal(charges),
        realizedR: realizedR == null ? null : new Prisma.Decimal(realizedR),
        mfePrice: new Prisma.Decimal(mfePrice),
        mfeR: initialRisk > 0 ? new Prisma.Decimal(Math.round((mfeMove / initialRisk) * 1000) / 1000) : null,
        holdingSeconds: trade.entryAt ? Math.round((now.getTime() - trade.entryAt.getTime()) / 1000) : null,
        lastManagedAt: now,
      },
    });

    this.logger.log(
      `PAPER EXIT ${trade.tradedSymbol} @ ${exitPrice} (${reason}) — ${realizedR ?? '—'}R, P&L ${realizedPnl}. ${detail}`,
    );
  }
}
