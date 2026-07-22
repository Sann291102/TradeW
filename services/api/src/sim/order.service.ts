import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Instrument, Order, OrderSide, OrderStatus, OrderType, OrderValidity, PaperWallet, Position, ProductType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MarketPriceService } from './market-price.service';
import { istDayKey, todayIstSessionEnd } from './ist-time.util';

export interface PlaceOrderInput {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  productType?: ProductType;
  validity?: OrderValidity;
  /** Required for LIMIT and SL, ignored otherwise. */
  price?: number;
  /** Required for SL and SL_M, ignored otherwise. */
  triggerPrice?: number;
}

export interface ModifyOrderInput {
  quantity?: number;
  price?: number;
  triggerPrice?: number;
}

type Tx = Prisma.TransactionClient;

const STARTING_BALANCE = 1_000_000; // ₹10L paper capital, matches PaperWallet's schema default
const CHARGES_RATE = 0.0003; // 3bps of gross trade value — same convention as the original market-only engine

/**
 * Simplified simulated margin — NOT real SPAN/exposure margin. A paper
 * engine needs *some* number to block so "available balance" is meaningful
 * and "insufficient margin" can genuinely reject an order, without
 * reimplementing an exchange's actual margin engine. Documented here rather
 * than silently presented as authoritative.
 */
function computeMargin(instrument: Instrument, side: OrderSide, productType: ProductType, price: number, quantity: number): number {
  const notional = price * quantity;
  if (instrument.type === 'OPTION' && side === 'BUY') return notional; // full premium paid
  if (productType === 'CNC') return notional; // cash delivery — no leverage
  if (instrument.type === 'FUTURE' || (instrument.type === 'OPTION' && side === 'SELL')) return notional * 0.15; // ~SPAN+exposure approximation
  return notional * 0.2; // MIS equity/ETF/index intraday — ~5x simulated leverage
}

/** Applies one fill to a position's (quantity, avgPrice), correctly handling
 *  add / partial-close / full-close / close-and-flip, and returns the
 *  realized P&L this specific fill locked in (0 unless it closes something). */
function applyFill(
  existingQty: number,
  existingAvgPrice: number,
  side: OrderSide,
  fillQty: number,
  fillPrice: number,
): { newQuantity: number; newAvgPrice: number; realizedPnlDelta: number } {
  const delta = side === 'BUY' ? fillQty : -fillQty;
  const newQuantity = existingQty + delta;

  if (existingQty === 0 || Math.sign(existingQty) === Math.sign(delta)) {
    const newAvgPrice =
      existingQty === 0 ? fillPrice : (Math.abs(existingQty) * existingAvgPrice + Math.abs(delta) * fillPrice) / Math.abs(newQuantity);
    return { newQuantity, newAvgPrice, realizedPnlDelta: 0 };
  }

  const closingQty = Math.min(Math.abs(existingQty), Math.abs(delta));
  const realizedPnlDelta = closingQty * (fillPrice - existingAvgPrice) * Math.sign(existingQty);

  if (Math.abs(delta) < Math.abs(existingQty)) {
    return { newQuantity, newAvgPrice: existingAvgPrice, realizedPnlDelta }; // partial close, remainder keeps its cost basis
  }
  return { newQuantity, newAvgPrice: newQuantity === 0 ? existingAvgPrice : fillPrice, realizedPnlDelta }; // full close, or close-and-flip
}

/**
 * The paper-trading order engine. Extends the original market-order-only
 * `sim.service.ts` (archived at
 * archive/api-sim-service-market-order-only.service.ts.txt) into a real
 * order lifecycle: MARKET fills immediately as before; LIMIT/SL/SL_M rest
 * (status OPEN/TRIGGER_PENDING) until `MatchingEngineService`'s poller fills
 * them against the live Dhan bridge — see MarketPriceService for why that's
 * the price source, not Postgres's simulated Quote table.
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(private readonly prisma: PrismaService, private readonly marketPrice: MarketPriceService) {}

  /** Every user gets one lazily-created paper wallet, seeded on first order
   *  rather than at signup — accounts that never trade never get a row. */
  async ensureWallet(userId: string): Promise<PaperWallet> {
    const existing = await this.prisma.paperWallet.findUnique({ where: { userId } });
    if (existing) return existing;
    return this.prisma.paperWallet.create({
      data: { userId, startingBalance: STARTING_BALANCE, cashBalance: STARTING_BALANCE },
    });
  }

  async placeOrder(userId: string, input: PlaceOrderInput): Promise<Order> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }
    if ((input.type === 'LIMIT' || input.type === 'SL') && (input.price == null || input.price <= 0)) {
      throw new BadRequestException(`${input.type} orders require a positive price`);
    }
    if ((input.type === 'SL' || input.type === 'SL_M') && (input.triggerPrice == null || input.triggerPrice <= 0)) {
      throw new BadRequestException(`${input.type} orders require a positive triggerPrice`);
    }

    const instrument = await this.marketPrice.resolveInstrument(input.symbol);
    if (input.quantity % instrument.lotSize !== 0) {
      throw new BadRequestException(`Quantity must be a multiple of lot size ${instrument.lotSize}`);
    }

    const wallet = await this.ensureWallet(userId);
    const productType = input.productType ?? 'MIS';
    const validity = input.validity ?? 'DAY';

    if (input.type === 'MARKET') {
      const price = await this.marketPrice.getPrice(instrument);
      const fillPrice = input.side === 'BUY' ? price.ask : price.bid;
      const margin = computeMargin(instrument, input.side, productType, fillPrice, input.quantity);
      if (margin > Number(wallet.cashBalance)) {
        return this.rejectNewOrder(userId, instrument, input, productType, validity, 'Insufficient margin');
      }
      return this.prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            userId,
            instrumentId: instrument.id,
            side: input.side,
            type: 'MARKET',
            validity,
            productType,
            status: 'PENDING',
            quantity: input.quantity,
          },
        });
        return this.executeFill(tx, order, instrument, fillPrice, input.quantity, price.ltp);
      });
    }

    // LIMIT / SL / SL_M — rests until MatchingEngineService fills it.
    const referencePrice = input.type === 'LIMIT' ? input.price! : input.triggerPrice!;
    const margin = computeMargin(instrument, input.side, productType, referencePrice, input.quantity);
    if (margin > Number(wallet.cashBalance)) {
      return this.rejectNewOrder(userId, instrument, input, productType, validity, 'Insufficient margin');
    }

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          userId,
          instrumentId: instrument.id,
          side: input.side,
          type: input.type,
          validity,
          productType,
          status: input.type === 'LIMIT' ? 'OPEN' : 'TRIGGER_PENDING',
          quantity: input.quantity,
          price: input.price,
          triggerPrice: input.triggerPrice,
          marginBlocked: margin,
          expiresAt: validity === 'DAY' ? todayIstSessionEnd() : null,
        },
      });
      await tx.paperWallet.update({
        where: { userId },
        data: { marginUsed: { increment: margin }, cashBalance: { decrement: margin } },
      });
      return order;
    });
  }

  private async rejectNewOrder(
    userId: string,
    instrument: Instrument,
    input: PlaceOrderInput,
    productType: ProductType,
    validity: OrderValidity,
    reason: string,
  ): Promise<Order> {
    return this.prisma.order.create({
      data: {
        userId,
        instrumentId: instrument.id,
        side: input.side,
        type: input.type,
        validity,
        productType,
        status: 'REJECTED',
        quantity: input.quantity,
        price: input.price,
        triggerPrice: input.triggerPrice,
        rejectReason: reason,
      },
    });
  }

  /**
   * Applies a fill (full order quantity, from a MARKET order or a resting
   * order the matching engine just triggered) atomically: records the
   * Trade, updates the Position (add/close/flip via `applyFill`), realizes
   * P&L into the wallet, and settles margin — the order's originally
   * blocked margin is released and the position's own margin (recomputed
   * from its new quantity/avgPrice) is (re)blocked.
   *
   * Only ever called from within an existing `$transaction` (`tx`), by
   * `placeOrder` for MARKET fills and by `MatchingEngineService` for
   * resting-order fills, so both paths share one correctness-critical path.
   */
  async executeFill(
    tx: Tx,
    order: Order,
    instrument: Instrument,
    fillPrice: number,
    fillQty: number,
    /** LTP at the moment of fill, when the caller has one (MARKET orders) —
     *  used only to report `slippage` (fillPrice vs. the price the user saw
     *  when placing the order). Resting LIMIT/SL/SL_M fills have no single
     *  "LTP at placement" to compare against, so this is omitted there and
     *  slippage is reported as 0 (the fill happened exactly at the
     *  triggered price by construction). */
    referenceLtp?: number,
  ): Promise<Order> {
    const gross = fillPrice * fillQty;
    const charges = Number((gross * CHARGES_RATE).toFixed(2));

    const trade = await tx.trade.create({
      data: { orderId: order.id, userId: order.userId, instrumentId: instrument.id, side: order.side, quantity: fillQty, fillPrice, charges },
    });

    const existing = await tx.position.findUnique({
      where: { userId_instrumentId_productType: { userId: order.userId, instrumentId: instrument.id, productType: order.productType } },
    });
    const dayKey = istDayKey(new Date());
    const anchorStale = !existing?.sessionAnchorAt || istDayKey(existing.sessionAnchorAt) !== dayKey;

    const { newQuantity, newAvgPrice, realizedPnlDelta } = applyFill(
      existing?.quantity ?? 0,
      existing ? Number(existing.avgPrice) : 0,
      order.side,
      fillQty,
      fillPrice,
    );

    if (realizedPnlDelta !== 0) {
      await tx.trade.update({ where: { id: trade.id }, data: { realizedPnl: Number(realizedPnlDelta.toFixed(2)) } });
    }

    const newRealizedTotal = Number(existing?.realizedPnl ?? 0) + realizedPnlDelta;
    const newMargin = newQuantity === 0 ? 0 : computeMargin(instrument, newQuantity >= 0 ? 'BUY' : 'SELL', order.productType, Math.abs(newAvgPrice), Math.abs(newQuantity));

    let position: Position;
    if (!existing) {
      position = await tx.position.create({
        data: {
          userId: order.userId,
          instrumentId: instrument.id,
          productType: order.productType,
          quantity: newQuantity,
          avgPrice: newAvgPrice,
          realizedPnl: newRealizedTotal,
          marginUsed: newMargin,
          sessionOpenQty: 0,
          sessionOpenAvgPrice: newAvgPrice,
          sessionOpenMarketPrice: fillPrice,
          sessionAnchorAt: new Date(),
        },
      });
    } else {
      position = await tx.position.update({
        where: { id: existing.id },
        data: {
          quantity: newQuantity,
          avgPrice: newAvgPrice,
          realizedPnl: newRealizedTotal,
          marginUsed: newMargin,
          // First trade of a new IST day snapshots yesterday's carry-forward
          // baseline for PositionService's daily-P&L split; otherwise unchanged.
          ...(anchorStale
            ? {
                sessionOpenQty: existing.quantity,
                sessionOpenAvgPrice: existing.avgPrice,
                sessionOpenMarketPrice: fillPrice,
                sessionAnchorAt: new Date(),
              }
            : {}),
        },
      });
    }

    // wallet.marginUsed must always equal (every open position's margin) +
    // (every resting order's blocked margin). A fill retires BOTH this
    // order's own block AND the position's pre-fill margin, replacing them
    // with the position's post-fill margin — so the delta has to subtract
    // both, not just the order's. Omitting the position term was a real bug:
    // MARKET orders never block their own margin (order.marginBlocked stays
    // 0), so closing a position via a MARKET order — or via a LIMIT/SL
    // placed at a very different reference price — left the position's old
    // margin permanently stranded in wallet.marginUsed after the position
    // itself had gone to zero.
    const previousPositionMargin = existing ? Number(existing.marginUsed) : 0;
    const marginDelta = newMargin - previousPositionMargin - Number(order.marginBlocked);
    await tx.paperWallet.update({
      where: { userId: order.userId },
      data: {
        marginUsed: { increment: marginDelta },
        cashBalance: { decrement: marginDelta + charges - realizedPnlDelta },
        realizedPnl: { increment: realizedPnlDelta },
      },
    });

    return tx.order.update({
      where: { id: order.id },
      data: {
        status: 'FILLED',
        filledQuantity: fillQty,
        avgFillPrice: fillPrice,
        charges,
        slippage: referenceLtp != null ? Number((fillPrice - referenceLtp).toFixed(2)) : 0,
      },
    });
  }

  async modifyOrder(userId: string, orderId: string, patch: ModifyOrderInput): Promise<Order> {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId }, include: { instrument: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (!['OPEN', 'TRIGGER_PENDING', 'PENDING'].includes(order.status)) {
      throw new BadRequestException(`Cannot modify an order in status ${order.status}`);
    }
    if (patch.quantity != null && patch.quantity % order.instrument.lotSize !== 0) {
      throw new BadRequestException(`Quantity must be a multiple of lot size ${order.instrument.lotSize}`);
    }

    const newQuantity = patch.quantity ?? order.quantity;
    const newPrice = patch.price ?? (order.price ? Number(order.price) : undefined);
    const newTrigger = patch.triggerPrice ?? (order.triggerPrice ? Number(order.triggerPrice) : undefined);
    const referencePrice = order.type === 'LIMIT' ? newPrice! : (newTrigger ?? Number(order.price ?? 0));
    const newMargin = computeMargin(order.instrument, order.side, order.productType, referencePrice, newQuantity);
    const marginDelta = newMargin - Number(order.marginBlocked);

    return this.prisma.$transaction(async (tx) => {
      if (marginDelta !== 0) {
        const wallet = await tx.paperWallet.findUnique({ where: { userId } });
        if (wallet && marginDelta > Number(wallet.cashBalance)) {
          throw new BadRequestException('Insufficient margin for this modification');
        }
        await tx.paperWallet.update({ where: { userId }, data: { marginUsed: { increment: marginDelta }, cashBalance: { decrement: marginDelta } } });
      }
      return tx.order.update({
        where: { id: orderId },
        data: { quantity: newQuantity, price: newPrice, triggerPrice: newTrigger, marginBlocked: newMargin },
      });
    });
  }

  async cancelOrder(userId: string, orderId: string): Promise<Order> {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId } });
    if (!order) throw new NotFoundException('Order not found');
    if (!['OPEN', 'TRIGGER_PENDING', 'PENDING', 'PARTIALLY_FILLED'].includes(order.status)) {
      throw new BadRequestException(`Cannot cancel an order in status ${order.status}`);
    }
    return this.prisma.$transaction(async (tx) => {
      if (Number(order.marginBlocked) > 0) {
        await tx.paperWallet.update({
          where: { userId },
          data: { marginUsed: { decrement: order.marginBlocked }, cashBalance: { increment: order.marginBlocked } },
        });
      }
      return tx.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });
    });
  }

  /** Flattens one position with a MARKET order in the opposite direction. */
  async exitPosition(userId: string, instrumentId: string, productType: ProductType = 'MIS'): Promise<Order> {
    const position = await this.prisma.position.findUnique({
      where: { userId_instrumentId_productType: { userId, instrumentId, productType } },
      include: { instrument: true },
    });
    if (!position || position.quantity === 0) throw new NotFoundException('No open position to exit');
    return this.placeOrder(userId, {
      symbol: position.instrument.symbol,
      side: position.quantity > 0 ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: Math.abs(position.quantity),
      productType,
    });
  }

  /** Exits every open position for the user, one MARKET order each. Never
   *  throws for an individual failure (e.g. one symbol's live price is
   *  momentarily unreachable) — collects per-position results instead, so
   *  one bad quote can't block flattening everything else. */
  async exitAll(userId: string): Promise<Array<{ instrumentId: string; symbol: string; order?: Order; error?: string }>> {
    const positions = await this.prisma.position.findMany({ where: { userId, quantity: { not: 0 } }, include: { instrument: true } });
    const results: Array<{ instrumentId: string; symbol: string; order?: Order; error?: string }> = [];
    for (const position of positions) {
      try {
        const order = await this.exitPosition(userId, position.instrumentId, position.productType);
        results.push({ instrumentId: position.instrumentId, symbol: position.instrument.symbol, order });
      } catch (err) {
        this.logger.error(`exitAll: failed to exit ${position.instrument.symbol}`, err as Error);
        results.push({ instrumentId: position.instrumentId, symbol: position.instrument.symbol, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  async orderBook(userId: string, statusFilter?: OrderStatus[]): Promise<Prisma.OrderGetPayload<{ include: { instrument: true } }>[]> {
    return this.prisma.order.findMany({
      where: { userId, ...(statusFilter ? { status: { in: statusFilter } } : {}) },
      include: { instrument: true },
      orderBy: { placedAt: 'desc' },
      take: 200,
    });
  }

  async tradeBook(userId: string): Promise<Prisma.TradeGetPayload<{ include: { instrument: true } }>[]> {
    return this.prisma.trade.findMany({
      where: { userId },
      include: { instrument: true },
      orderBy: { executedAt: 'desc' },
      take: 200,
    });
  }
}
