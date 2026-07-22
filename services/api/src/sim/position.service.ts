import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MarketPriceService } from './market-price.service';
import { startOfIstDay } from './ist-time.util';

type PositionWithInstrument = Prisma.PositionGetPayload<{ include: { instrument: true } }>;

export interface PositionDto {
  id: string;
  instrumentId: string;
  symbol: string;
  displayName: string;
  productType: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  dailyPnl: number;
  /** Mark-to-market — the open position's P&L at the current price. Same
   *  number as unrealizedPnl; kept as a separate field because "MTM" is the
   *  term traders expect on a positions screen. */
  mtm: number;
  positionValue: number;
  marginUsed: number;
  positionStatus: 'OPEN' | 'CLOSED';
  /** 'stale' when the live bridge couldn't price this symbol just now — the
   *  row still renders (using avgPrice as a placeholder) rather than
   *  disappearing or erroring the whole list. */
  priceStatus: 'live' | 'stale';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Reads paper positions and computes their P&L. Extends the original
 * `sim.service.ts#positions()` (archived — see archive/README.md) with the
 * fuller breakdown a real positions screen needs: realized vs. unrealized
 * vs. daily P&L, MTM, position value, margin used, and closed-position
 * history, instead of just a single blended `pnl` number.
 */
@Injectable()
export class PositionService {
  private readonly logger = new Logger(PositionService.name);

  constructor(private readonly prisma: PrismaService, private readonly marketPrice: MarketPriceService) {}

  async list(userId: string): Promise<PositionDto[]> {
    const positions = await this.prisma.position.findMany({
      where: { userId, quantity: { not: 0 } },
      include: { instrument: true },
      orderBy: { updatedAt: 'desc' },
    });
    return Promise.all(positions.map((p) => this.toDto(p)));
  }

  /** Flattened-to-zero positions — kept (never deleted) as history rather
   *  than dropped once quantity returns to 0. */
  async closed(userId: string): Promise<PositionDto[]> {
    const positions = await this.prisma.position.findMany({
      where: { userId, quantity: 0 },
      include: { instrument: true },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return Promise.all(positions.map((p) => this.toDto(p)));
  }

  private async toDto(p: PositionWithInstrument): Promise<PositionDto> {
    const avgPrice = Number(p.avgPrice);
    let ltp = avgPrice;
    let priceStatus: PositionDto['priceStatus'] = 'stale';
    if (p.quantity !== 0) {
      try {
        const price = await this.marketPrice.getPrice(p.instrument);
        ltp = price.ltp;
        priceStatus = 'live';
      } catch (err) {
        // Never let one unpriceable symbol break the whole positions list —
        // fall back to avgPrice (unrealizedPnl reads as 0 for that row,
        // clearly stale via priceStatus, not silently wrong).
        this.logger.warn(`toDto(${p.instrument.symbol}): live price unavailable, using avgPrice — ${(err as Error).message}`);
      }
    }

    const unrealizedPnl = round2((ltp - avgPrice) * p.quantity);
    const realizedPnl = Number(p.realizedPnl);
    const todaysRealized = await this.todaysRealizedPnl(p.userId, p.instrumentId);

    // Daily P&L = today's realized + the CHANGE in unrealized P&L since the
    // session-open snapshot (see order.service.ts's sessionOpen* fields) —
    // isolates today's contribution from P&L carried in from prior sessions.
    const sessionOpenUnrealized =
      p.sessionOpenAvgPrice != null
        ? (Number(p.sessionOpenMarketPrice ?? p.sessionOpenAvgPrice) - Number(p.sessionOpenAvgPrice)) * p.sessionOpenQty
        : 0;
    const dailyPnl = round2(todaysRealized + (unrealizedPnl - sessionOpenUnrealized));

    return {
      id: p.id,
      instrumentId: p.instrumentId,
      symbol: p.instrument.symbol,
      displayName: p.instrument.displayName,
      productType: p.productType,
      quantity: p.quantity,
      avgPrice,
      currentPrice: ltp,
      unrealizedPnl,
      realizedPnl,
      dailyPnl,
      mtm: unrealizedPnl,
      positionValue: round2(Math.abs(p.quantity) * ltp),
      marginUsed: Number(p.marginUsed),
      positionStatus: p.quantity === 0 ? 'CLOSED' : 'OPEN',
      priceStatus,
    };
  }

  /** Sum of Trade.realizedPnl for this instrument today (IST).
   *
   *  Known simplification: scoped by (userId, instrumentId) only, not also
   *  productType — Trade doesn't carry productType (only its parent Order
   *  does). A user running both an MIS and an NRML position on the same
   *  instrument on the same day would see today's realized P&L blended
   *  across both instead of split — an edge case rare enough for a paper
   *  platform that splitting it wasn't worth another schema migration in
   *  this phase; flagged here rather than silently wrong. */
  private async todaysRealizedPnl(userId: string, instrumentId: string): Promise<number> {
    const agg = await this.prisma.trade.aggregate({
      where: { userId, instrumentId, executedAt: { gte: startOfIstDay() }, realizedPnl: { not: null } },
      _sum: { realizedPnl: true },
    });
    return Number(agg._sum.realizedPnl ?? 0);
  }
}
