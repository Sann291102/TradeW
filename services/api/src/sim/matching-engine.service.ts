import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MarketPriceService } from './market-price.service';
import { OrderService } from './order.service';

const POLL_MS = 3_000;

type OrderWithInstrument = Prisma.OrderGetPayload<{ include: { instrument: true } }>;

/**
 * Fills resting LIMIT/SL/SL_M orders against the live Dhan bridge — there is
 * no real exchange order book to rest on, so this plain interval poller is
 * the paper engine's matching engine. One `/quotes` snapshot per tick (see
 * MarketPriceService's own 2s cache) covers every resting order regardless
 * of count, so polling cost doesn't scale with order volume.
 *
 * Plain `setInterval` via Nest's lifecycle hooks rather than `@nestjs/schedule`
 * — this service needs nothing that package provides beyond "run every N
 * seconds," so it isn't a new dependency for one line of behavior.
 */
@Injectable()
export class MatchingEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchingEngineService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketPrice: MarketPriceService,
    private readonly orders: OrderService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    let resting: OrderWithInstrument[];
    try {
      resting = await this.prisma.order.findMany({
        where: { status: { in: ['OPEN', 'TRIGGER_PENDING'] } },
        include: { instrument: true },
      });
    } catch (err) {
      this.logger.error('tick: failed to load resting orders', err as Error);
      return;
    }
    if (resting.length === 0) return;

    for (const order of resting) {
      try {
        await this.evaluate(order);
      } catch (err) {
        // One order's evaluation failing (e.g. its instrument's live price is
        // momentarily unreachable) must never stop the rest of the book from
        // being evaluated this tick.
        this.logger.error(`tick: failed to evaluate order ${order.id} (${order.instrument.symbol})`, err as Error);
      }
    }
  }

  private async evaluate(order: OrderWithInstrument): Promise<void> {
    if (order.expiresAt && order.expiresAt.getTime() < Date.now()) {
      await this.expireOrder(order);
      return;
    }

    const price = await this.marketPrice.getPrice(order.instrument); // throws (caught by tick's per-order try/catch) if unpriceable right now — order stays resting, retried next tick

    if (order.status === 'TRIGGER_PENDING') {
      const trigger = Number(order.triggerPrice);
      // SL/SL_M BUY protects a short (or enters a breakout) — triggers when
      // price rises to the trigger. SELL protects a long — triggers when
      // price falls to it. Standard stop-order semantics.
      const triggered = order.side === 'BUY' ? price.ltp >= trigger : price.ltp <= trigger;
      if (!triggered) return;

      if (order.type === 'SL_M') {
        const fillPrice = order.side === 'BUY' ? price.ask : price.bid;
        await this.doFill(order, fillPrice, price.ltp);
        return;
      }

      // SL -> now a resting LIMIT at `order.price`. Re-check in the same
      // tick (not next tick) in case the trigger and the limit are both
      // satisfied by the same price move.
      await this.prisma.order.update({ where: { id: order.id }, data: { status: 'OPEN' } });
      order = { ...order, status: 'OPEN' };
    }

    if (order.status === 'OPEN' && order.type !== 'MARKET') {
      const limitPrice = Number(order.price);
      const fillable = order.side === 'BUY' ? price.ask <= limitPrice : price.bid >= limitPrice;
      if (!fillable) return;
      // Fill at the limit price or better — the market can gap through a
      // limit, but the user is never filled worse than what they asked for.
      const fillPrice = order.side === 'BUY' ? Math.min(limitPrice, price.ask) : Math.max(limitPrice, price.bid);
      await this.doFill(order, fillPrice, price.ltp);
    }
  }

  private async doFill(order: OrderWithInstrument, fillPrice: number, referenceLtp: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.orders.executeFill(tx, order, order.instrument, fillPrice, order.quantity, referenceLtp);
    });
  }

  private async expireOrder(order: OrderWithInstrument): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (Number(order.marginBlocked) > 0) {
        await tx.paperWallet.update({
          where: { userId: order.userId },
          data: { marginUsed: { decrement: order.marginBlocked }, cashBalance: { increment: order.marginBlocked } },
        });
      }
      await tx.order.update({ where: { id: order.id }, data: { status: 'EXPIRED' } });
    });
  }
}
