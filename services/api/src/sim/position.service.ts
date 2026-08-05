import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Position, Prisma, ProductType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MarketPriceService } from './market-price.service';
import { SettlementService } from './settlement.service';
import { computeMargin } from './order.service';
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
 * Weighted-average merge of a source position into an optional existing
 * target — same reasoning as SettlementService.mergeHoldingLot, but signed
 * (a position can be short) so a same-direction merge averages correctly
 * while an opposite-direction target is flagged rather than netted (see
 * PositionService.convert's docstring on why netting is refused, not
 * computed). `targetQty: 0` means "no existing target position".
 *
 * Exported for position-convert.spec.ts only — pure, no database.
 */
export function mergePositionForConversion(
  sourceQty: number,
  sourceAvgPrice: number,
  targetQty: number,
  targetAvgPrice: number,
): { quantity: number; avgPrice: number; conflict: boolean } {
  if (targetQty === 0) return { quantity: sourceQty, avgPrice: sourceAvgPrice, conflict: false };
  if (Math.sign(targetQty) !== Math.sign(sourceQty)) return { quantity: targetQty, avgPrice: targetAvgPrice, conflict: true };
  const quantity = targetQty + sourceQty;
  const avgPrice = (Math.abs(targetQty) * targetAvgPrice + Math.abs(sourceQty) * sourceAvgPrice) / Math.abs(quantity);
  return { quantity, avgPrice, conflict: false };
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketPrice: MarketPriceService,
    private readonly settlement: SettlementService,
  ) {}

  async list(userId: string): Promise<PositionDto[]> {
    // Lazy settlement, same reasoning as HoldingsService.list — a user's own
    // view must never lag the periodic sweep between its ticks.
    await this.settlement.settleUser(userId);

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

  /**
   * Position Management's "Convert product type" — moves a position's whole
   * quantity from `from` to `to` for the same instrument. No trade, no
   * price: this is a relabeling of existing exposure, not a fill. If `to`
   * already holds a same-direction position, the two merge (weighted-average
   * cost, like Holding settlement); an opposite-direction target is refused
   * rather than silently netted — netting through zero is exactly what a
   * real closing trade does, and reimplementing that here would blur "closed
   * by conversion" into "closed by trade" for no benefit a paper platform's
   * Position Management dialog actually needs.
   */
  async convert(userId: string, instrumentId: string, from: ProductType, to: ProductType): Promise<PositionDto> {
    if (from === to) throw new BadRequestException('Source and target product type are the same');

    return this.prisma.$transaction(async (tx) => {
      const source = await tx.position.findUnique({
        where: { userId_instrumentId_productType: { userId, instrumentId, productType: from } },
        include: { instrument: true },
      });
      if (!source || source.quantity === 0) throw new NotFoundException('No open position to convert');

      const target = await tx.position.findUnique({
        where: { userId_instrumentId_productType: { userId, instrumentId, productType: to } },
      });
      const merged = this.mergeForConversion(source, target);
      if (merged.conflict) {
        throw new BadRequestException(`Cannot convert into an existing opposite-direction ${to} position — square that off first`);
      }

      const newMargin = computeMargin(
        source.instrument,
        merged.quantity >= 0 ? 'BUY' : 'SELL',
        to,
        Math.abs(merged.avgPrice),
        Math.abs(merged.quantity),
      );
      const releasedMargin = Number(source.marginUsed) + (target ? Number(target.marginUsed) : 0);

      let resultId: string;
      if (target) {
        const updated = await tx.position.update({
          where: { id: target.id },
          data: { quantity: merged.quantity, avgPrice: merged.avgPrice, marginUsed: newMargin, realizedPnl: { increment: source.realizedPnl } },
        });
        resultId = updated.id;
      } else {
        const created = await tx.position.create({
          data: {
            userId,
            instrumentId,
            productType: to,
            quantity: merged.quantity,
            avgPrice: merged.avgPrice,
            realizedPnl: source.realizedPnl,
            marginUsed: newMargin,
            sessionOpenQty: 0,
            sessionOpenAvgPrice: merged.avgPrice,
            sessionOpenMarketPrice: merged.avgPrice,
            sessionAnchorAt: new Date(),
            // Deliberately NOT carried over from source: converting into CNC
            // doesn't restart or preserve a T+1 cohort — see convert()'s own
            // docstring on why this is a relabeling, not a new acquisition.
            // A CNC target's settlesAt stays null; the shares this row
            // represents already settled (or are still mid-cohort) under
            // their ORIGINAL productType's history, which conversion doesn't
            // rewrite. Known simplification: a same-day CNC position
            // converted before it settles loses its pending settlesAt and
            // won't reach Holding until traded again — rare enough on a
            // paper platform not to warrant carrying settlement state across
            // a product-type relabel.
          },
        });
        resultId = created.id;
      }

      await tx.position.update({
        where: { id: source.id },
        data: { quantity: 0, marginUsed: 0, settlesAt: null, closeReason: 'CONVERTED' },
      });

      const marginDelta = newMargin - releasedMargin;
      if (marginDelta !== 0) {
        await tx.paperWallet.update({
          where: { userId },
          data: { marginUsed: { increment: marginDelta }, cashBalance: { decrement: marginDelta } },
        });
      }

      const final = await tx.position.findUniqueOrThrow({ where: { id: resultId }, include: { instrument: true } });
      return this.toDto(final);
    });
  }

  /** Margin impact of a proposed conversion, without performing it — what
   *  Position Management's confirm dialog shows before the user commits. */
  async previewConvert(
    userId: string,
    instrumentId: string,
    from: ProductType,
    to: ProductType,
  ): Promise<{ currentMargin: number; projectedMargin: number; marginDelta: number }> {
    const source = await this.prisma.position.findUnique({
      where: { userId_instrumentId_productType: { userId, instrumentId, productType: from } },
      include: { instrument: true },
    });
    if (!source || source.quantity === 0) throw new NotFoundException('No open position to convert');
    const target = await this.prisma.position.findUnique({
      where: { userId_instrumentId_productType: { userId, instrumentId, productType: to } },
    });

    const merged = this.mergeForConversion(source, target);
    if (merged.conflict) {
      throw new BadRequestException(`Cannot convert into an existing opposite-direction ${to} position — square that off first`);
    }

    const projectedMargin = round2(
      computeMargin(source.instrument, merged.quantity >= 0 ? 'BUY' : 'SELL', to, Math.abs(merged.avgPrice), Math.abs(merged.quantity)),
    );
    const currentMargin = round2(Number(source.marginUsed) + (target ? Number(target.marginUsed) : 0));
    return { currentMargin, projectedMargin, marginDelta: round2(projectedMargin - currentMargin) };
  }

  private mergeForConversion(source: Position, target: Position | null): { quantity: number; avgPrice: number; conflict: boolean } {
    return mergePositionForConversion(
      source.quantity,
      Number(source.avgPrice),
      target?.quantity ?? 0,
      target ? Number(target.avgPrice) : 0,
    );
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
