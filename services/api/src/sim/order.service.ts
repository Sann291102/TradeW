import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Instrument, Order, OrderSide, OrderStatus, OrderType, OrderValidity, PaperWallet, Position, ProductType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { computeOrderIntent } from '../discipline/discipline-limits';
import { DisciplineService } from '../discipline/discipline.service';
import { nextTradingDay } from '../discipline/market-calendar';
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
  /**
   * Discipline override — supplied only on a retry, after the trader has sat
   * through the friction prompt raised by a previous attempt. The token is
   * server-signed and single-use; the reason is the trader's own words.
   * Ignored entirely when no limit is breached.
   */
  overrideToken?: string;
  overrideReason?: string;
}

export interface ModifyOrderInput {
  quantity?: number;
  price?: number;
  triggerPrice?: number;
}

type Tx = Prisma.TransactionClient;

const STARTING_BALANCE = 1_000_000; // ₹10L paper capital, matches PaperWallet's schema default
// 3bps of gross trade value — same convention as the original market-only engine.
// Exported so HoldingsService.sell can charge a holdings sale identically
// instead of re-declaring the rate.
export const CHARGES_RATE = 0.0003;

/**
 * Approximate SPAN+exposure rate for a short option, as a fraction of the
 * UNDERLYING notional. Calibrated against a live broker quote: NIFTY 28 Jul
 * 23950 PE, 1 lot (65), underlying ~23,900 → broker required ₹2,02,475.
 * 23,900 × 65 × 0.13 = ₹2,01,955, within 0.3%.
 */
const SHORT_OPTION_MARGIN_RATE = 0.13;
/** Futures margin, also on the underlying notional (the future's own price). */
const FUTURES_MARGIN_RATE = 0.15;
/** MIS equity/index intraday — ~5x simulated leverage. */
const INTRADAY_EQUITY_MARGIN_RATE = 0.2;

/**
 * Simplified simulated margin — NOT real SPAN/exposure margin. A paper engine
 * needs *some* number to block so "available balance" is meaningful and
 * "insufficient margin" can genuinely reject an order, without reimplementing
 * an exchange's margin engine.
 *
 * SHORT OPTIONS ARE THE CASE THIS FUNCTION EXISTS TO GET RIGHT. It previously
 * computed every leg off `price × quantity`, where `price` for an option is the
 * PREMIUM. For a long option that is correct — the premium is the whole cost
 * and the whole risk. For a SHORT option it is meaningless: the premium is what
 * the trader receives, and the risk is on the underlying. Selling one NIFTY
 * 23900 PE at ₹9.55 blocked 0.15 × 9.55 × 65 = ₹93, against a real broker
 * requirement of ₹2,02,475 — under-margined by a factor of ~2,175.
 *
 * That is the most dangerous possible error in a teaching account: it lets a
 * ₹10L paper wallet short unlimited options for free, and rewards the one
 * strategy that can actually bankrupt a real trader. Short-option and futures
 * margin is now taken on the underlying notional.
 *
 * `underlyingSpot` is the live underlying price when the caller has one (the
 * option-chain response carries it). When absent, the contract's own strike is
 * used — a close proxy near the money, and always far closer than the premium.
 *
 * CALLERS MUST NOT APPLY THIS TO A REDUCING ORDER. This function answers "what
 * does opening this exposure cost", and a closing order does the opposite — it
 * releases the position's margin. Charging it as new exposure made positions
 * impossible to exit: a SELL closing a long 780 NIFTY CALL was billed
 * 24,250 × 780 × 0.13 = ₹24.6L against a ₹10L wallet and rejected as
 * "Insufficient margin", three times in a row, with no way out of the trade.
 * `placeOrder` gates on `computeOrderIntent` for exactly this reason.
 */
// Exported so PositionService.convert / previewConvert can recompute margin
// for a proposed product-type conversion identically, instead of
// re-implementing this formula in the frontend or a second time here.
export function computeMargin(
  instrument: Instrument,
  side: OrderSide,
  productType: ProductType,
  price: number,
  quantity: number,
  underlyingSpot?: number,
): number {
  const premiumNotional = price * quantity;

  // Long option: premium paid in full, no leverage. Risk is capped at it.
  if (instrument.type === 'OPTION' && side === 'BUY') return premiumNotional;

  if (instrument.type === 'OPTION' && side === 'SELL') {
    // Reference price for the underlying, best available first.
    const reference =
      underlyingSpot && underlyingSpot > 0
        ? underlyingSpot
        : instrument.strikePrice != null
          ? Number(instrument.strikePrice)
          : null;
    // No way to value the underlying — refuse to invent a number. Falling back
    // to the premium here is exactly the bug this function is fixing.
    if (reference == null || !(reference > 0)) {
      throw new BadRequestException(
        `Cannot compute margin for ${instrument.symbol}: the underlying price is unavailable. Try again shortly.`,
      );
    }
    return reference * quantity * SHORT_OPTION_MARGIN_RATE;
  }

  if (productType === 'CNC') return premiumNotional; // cash delivery — no leverage
  // A future's own price IS its underlying notional, so premiumNotional is the
  // right base here despite the name.
  if (instrument.type === 'FUTURE') return premiumNotional * FUTURES_MARGIN_RATE;
  return premiumNotional * INTRADAY_EQUITY_MARGIN_RATE;
}

/** Applies one fill to a position's (quantity, avgPrice), correctly handling
 *  add / partial-close / full-close / close-and-flip, and returns the
 *  realized P&L this specific fill locked in (0 unless it closes something).
 *
 *  Exported for `order-fill.spec.ts` only — it stays pure and dependency-free
 *  precisely so the money arithmetic can be asserted without a database or a
 *  Nest context. Nothing outside this module should call it at runtime. */
export function applyFill(
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketPrice: MarketPriceService,
    private readonly discipline: DisciplineService,
  ) {}

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

    // ---- Discipline limits (self-imposed session limits) -----------------
    // Placed here, after input/instrument validation and before either
    // transaction, because this is the single point both MARKET and resting
    // orders pass through. A malformed order is still rejected on its own
    // merits above rather than being frictioned.
    //
    // `intent` is derived from the position this server holds, never from
    // anything the caller sent — a client-supplied "this is a close" flag
    // would be the obvious way to skip the prompt. Reducing orders bypass the
    // checks entirely: the loss limit is breached exactly when the trader is
    // holding a loser, and standing between them and the exit would invert the
    // point of the feature.
    //
    // Throws 409 with a signed override token when a limit is breached and no
    // valid override accompanies the order. It never hard-blocks.
    const openPosition = await this.prisma.position.findUnique({
      where: { userId_instrumentId_productType: { userId, instrumentId: instrument.id, productType } },
      select: { quantity: true },
    });
    const intent = computeOrderIntent(openPosition?.quantity ?? 0, input.side, input.quantity);
    const disciplinePlan = await this.discipline.evaluatePlacement(
      userId,
      intent,
      { token: input.overrideToken, reason: input.overrideReason },
      new Date(),
    );

    if (input.type === 'MARKET') {
      const price = await this.marketPrice.getPrice(instrument);
      const fillPrice = input.side === 'BUY' ? price.ask : price.bid;
      // A reducing order costs no margin — it RELEASES the position's own. See
      // `requiredMargin`.
      const margin =
        intent === 'reduce'
          ? 0
          : computeMargin(instrument, input.side, productType, fillPrice, input.quantity, price.underlyingSpot);
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
        // Same transaction as the order: the trade counter can never drift
        // from the order book, and a replayed override token collides on
        // DisciplineOverride.tokenNonce and rolls this order back with it.
        await this.discipline.recordPlacement(tx, disciplinePlan);
        return this.executeFill(tx, order, instrument, fillPrice, input.quantity, price.ltp);
      });
    }

    // LIMIT / SL / SL_M — rests until MatchingEngineService fills it.
    const referencePrice = input.type === 'LIMIT' ? input.price! : input.triggerPrice!;
    // A resting SHORT OPTION still needs the underlying to size its margin, and
    // the limit price is a premium. One extra quote read here is worth far more
    // than blocking ₹93 against a ₹2L risk; a failure degrades to the strike,
    // which computeMargin handles.
    const restingSpot =
      intent === 'open' && instrument.type === 'OPTION' && input.side === 'SELL'
        ? await this.marketPrice
            .getPrice(instrument)
            .then((p) => p.underlyingSpot)
            .catch(() => undefined)
        : undefined;
    // Same rule as the MARKET branch — a resting order that reduces an existing
    // position blocks nothing.
    const margin =
      intent === 'reduce'
        ? 0
        : computeMargin(instrument, input.side, productType, referencePrice, input.quantity, restingSpot);
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
      // A resting order counts against the trade limit at placement, not at
      // fill — the decision the limit governs is the one being made now. The
      // matching engine deliberately does not re-check discipline when this
      // order later fills.
      await this.discipline.recordPlacement(tx, disciplinePlan);
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
      // Mirrors applyFill's own closingQty (`Math.min(|existingQty|, fillQty)`)
      // — recomputed here rather than widening applyFill's return, since this
      // is the one caller that needs it and applyFill stays the single
      // pure/tested source of the P&L math itself. Equal to fillQty except on
      // a close-and-flip fill, where it's the closing leg only — see the
      // Trade.closedQuantity schema comment.
      const closedQuantity = Math.min(Math.abs(existing?.quantity ?? 0), fillQty);
      await tx.trade.update({
        where: { id: trade.id },
        data: { realizedPnl: Number(realizedPnlDelta.toFixed(2)), closedQuantity },
      });
    }

    const newRealizedTotal = Number(existing?.realizedPnl ?? 0) + realizedPnlDelta;
    // No live underlying spot on this path (executeFill is also reached from
    // the matching engine, which holds only the contract's own price), so a
    // short-option position re-margins off its strike. Near the money that is
    // within a percent or two of spot, and it is the same basis the placement
    // check used if the chain was briefly unavailable.
    const newMargin =
      newQuantity === 0
        ? 0
        : computeMargin(
            instrument,
            newQuantity >= 0 ? 'BUY' : 'SELL',
            order.productType,
            Math.abs(newAvgPrice),
            Math.abs(newQuantity),
          );

    // CNC settlement cohort (see SettlementService / the Position/Holding
    // schema comments). Only ever set for CNC — MIS/NRML never carry a
    // settlement date, so they structurally can never reach Holding. A BUY
    // joins the existing pending cohort's date if one is still outstanding
    // (position-level, not per-lot — a documented simplification, see
    // schema.prisma); a fresh cohort (nothing pending) gets a new T+1 date.
    // closeReason clears the moment quantity is nonzero again (a fill
    // reopening a flattened/settled row) and is set to 'FLATTENED' — never
    // 'SETTLED', that belongs to SettlementService alone — whenever a fill
    // brings quantity to exactly zero.
    const isCncBuy = order.productType === 'CNC' && order.side === 'BUY';
    const existingSettlesAt = existing?.settlesAt ?? null;
    const settlementFields =
      newQuantity === 0
        ? { settlesAt: null, closeReason: 'FLATTENED' as const }
        : {
            settlesAt:
              isCncBuy && (!existingSettlesAt || existingSettlesAt <= new Date()) ? nextTradingDay() : existingSettlesAt,
            closeReason: null,
          };

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
          ...settlementFields,
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
          ...settlementFields,
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

    // Mirror the realized P&L this fill locked in onto today's discipline
    // session, in this same transaction — the loss-limit check is a single
    // point read against that counter rather than an aggregate over trades,
    // so it must never be able to drift from the fills that moved it. Also
    // where the one-time profit-target notice fires. A no-op when the trader
    // never opened a session today.
    await this.discipline.applyRealizedPnl(tx, order.userId, realizedPnlDelta);

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
