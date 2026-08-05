import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CHARGES_RATE } from './order.service';
import { MarketPriceService } from './market-price.service';
import { SettlementService } from './settlement.service';

type HoldingWithInstrument = Prisma.HoldingGetPayload<{ include: { instrument: true } }>;

export interface HoldingDto {
  id: string;
  instrumentId: string;
  symbol: string;
  displayName: string;
  quantity: number;
  avgCost: number;
  ltp: number;
  currentValue: number;
  investedValue: number;
  overallPnl: number;
  overallPnlPct: number;
  /** (ltp - previousClose) * quantity. 0 with priceStatus 'stale' when no
   *  Quote row exists yet for this instrument — a holdings sale/refresh must
   *  never block on that, it just can't show a day-change figure. */
  dayChange: number;
  dayChangePct: number;
  priceStatus: 'live' | 'stale';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Settled CNC equity — the T+1 destination `SettlementService` transfers
 * matured Positions into (see that service's docstring for the lifecycle).
 * This service only ever reads/reduces Holding rows; it never creates one —
 * that happens exclusively via settlement.
 */
@Injectable()
export class HoldingsService {
  private readonly logger = new Logger(HoldingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketPrice: MarketPriceService,
    private readonly settlement: SettlementService,
  ) {}

  async list(userId: string): Promise<HoldingDto[]> {
    // Lazy settlement: a user's own view must never be stale between the
    // periodic sweep's ticks (see SettlementService's docstring).
    await this.settlement.settleUser(userId);

    const holdings = await this.prisma.holding.findMany({
      where: { userId, quantity: { gt: 0 } },
      include: { instrument: true },
      orderBy: { updatedAt: 'desc' },
    });
    return Promise.all(holdings.map((h) => this.toDto(h)));
  }

  private async toDto(h: HoldingWithInstrument): Promise<HoldingDto> {
    const avgCost = Number(h.avgCost);
    let ltp = avgCost;
    let priceStatus: HoldingDto['priceStatus'] = 'stale';
    try {
      const price = await this.marketPrice.getPrice(h.instrument);
      ltp = price.ltp;
      priceStatus = 'live';
    } catch (err) {
      this.logger.warn(`toDto(${h.instrument.symbol}): live price unavailable, using avgCost — ${(err as Error).message}`);
    }

    const investedValue = round2(avgCost * h.quantity);
    const currentValue = round2(ltp * h.quantity);
    const overallPnl = round2(currentValue - investedValue);

    // Day change needs yesterday's close, which MarketPriceService's live
    // bridge doesn't carry (see its own docstring) — it comes from the
    // separately-ingested Quote table instead (services/market-data's own
    // pipeline). Missing for an instrument the ingestor hasn't covered yet;
    // degrades to 0 rather than guessing, same "never fabricate" rule
    // PositionService's priceStatus follows.
    const quote = await this.prisma.quote.findUnique({ where: { instrumentId: h.instrumentId } });
    const previousClose = quote?.previousClose != null ? Number(quote.previousClose) : null;
    const dayChange = previousClose != null ? round2((ltp - previousClose) * h.quantity) : 0;

    return {
      id: h.id,
      instrumentId: h.instrumentId,
      symbol: h.instrument.symbol,
      displayName: h.instrument.displayName,
      quantity: h.quantity,
      avgCost,
      ltp,
      currentValue,
      investedValue,
      overallPnl,
      overallPnlPct: investedValue !== 0 ? round2((overallPnl / investedValue) * 100) : 0,
      dayChange,
      dayChangePct: previousClose && previousClose !== 0 ? round2(((ltp - previousClose) / previousClose) * 100) : 0,
      priceStatus,
    };
  }

  /**
   * Sells up to `quantity` of a settled holding at the live price — a real
   * broker order (creates Order + Trade rows so Orders/Trade History show it
   * too), not a silent state mutation. Realizes P&L against the holding's
   * `avgCost`; `avgCost` itself never changes on a sell, only `quantity`
   * does (mirrors how Position.avgPrice is untouched by a partial close).
   */
  async sell(userId: string, instrumentId: string, quantity: number): Promise<HoldingDto | null> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }

    const holding = await this.prisma.holding.findUnique({
      where: { userId_instrumentId: { userId, instrumentId } },
      include: { instrument: true },
    });
    if (!holding || holding.quantity === 0) throw new NotFoundException('No settled holding to sell');
    if (quantity > holding.quantity) {
      throw new BadRequestException(`Cannot sell ${quantity} — only ${holding.quantity} settled`);
    }

    const price = await this.marketPrice.getPrice(holding.instrument);
    const fillPrice = price.bid;
    const gross = round2(fillPrice * quantity);
    const charges = round2(gross * CHARGES_RATE);
    const realizedPnl = round2((fillPrice - Number(holding.avgCost)) * quantity);

    await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          userId,
          instrumentId,
          side: 'SELL',
          type: 'MARKET',
          validity: 'DAY',
          productType: 'CNC',
          status: 'FILLED',
          quantity,
          filledQuantity: quantity,
          avgFillPrice: fillPrice,
          charges,
        },
      });
      await tx.trade.create({
        // closedQuantity always equals quantity here — a holdings sale can
        // never flip through zero into a short (sell() already rejects
        // quantity > holding.quantity above), so there's no opening leg to
        // exclude the way a Position fill's flip case has (see
        // Trade.closedQuantity's schema comment).
        data: { orderId: order.id, userId, instrumentId, side: 'SELL', quantity, fillPrice, charges, realizedPnl, closedQuantity: quantity },
      });

      const newQuantity = holding.quantity - quantity;
      if (newQuantity === 0) {
        await tx.holding.delete({ where: { id: holding.id } });
      } else {
        await tx.holding.update({
          where: { id: holding.id },
          data: { quantity: newQuantity, realizedPnl: { increment: realizedPnl } },
        });
      }

      // No margin to release (a settled holding was never margined — see
      // SettlementService.settleUser) — just proceeds minus charges, same
      // wallet ledger a Position close credits.
      await tx.paperWallet.update({
        where: { userId },
        data: { cashBalance: { increment: gross - charges }, realizedPnl: { increment: realizedPnl } },
      });
    });

    const remaining = await this.prisma.holding.findUnique({ where: { id: holding.id }, include: { instrument: true } });
    return remaining ? this.toDto(remaining) : null;
  }
}
