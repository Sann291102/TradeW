import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderSide } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MarketDataService } from '../market-data/market-data.service';

@Injectable()
export class SimService {
  constructor(private readonly prisma: PrismaService, private readonly marketData: MarketDataService) {}

  async placeOrder(userId: string, instrumentId: string, side: OrderSide, quantity: number) {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('Quantity must be positive integer');
    const instrument = await this.prisma.instrument.findUnique({ where: { id: instrumentId } });
    if (!instrument) throw new NotFoundException('Instrument not found');
    if (quantity % instrument.lotSize !== 0) throw new BadRequestException(`Quantity must be multiple of lot size ${instrument.lotSize}`);

    const quote = await this.marketData.quote(instrumentId);
    const ltp = quote.ltp;
    const slippage = Number((ltp * 0.0005).toFixed(2));
    const fillPrice = side === 'BUY' ? ltp + slippage : ltp - slippage;
    const gross = fillPrice * quantity;
    const charges = Number((gross * 0.0003).toFixed(2));

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({ data: { userId, instrumentId, side, quantity, fillPrice, slippage, charges } });
      const trade = await tx.trade.create({ data: { orderId: order.id, userId, instrumentId, side, quantity, fillPrice, charges } });

      const existing = await tx.position.findUnique({ where: { userId_instrumentId: { userId, instrumentId } } });
      const signedQty = side === 'BUY' ? quantity : -quantity;
      if (!existing) {
        await tx.position.create({ data: { userId, instrumentId, quantity: signedQty, avgPrice: fillPrice } });
      } else {
        const oldQty = existing.quantity;
        const newQty = oldQty + signedQty;
        let avgPrice = Number(existing.avgPrice);
        if (newQty !== 0 && Math.sign(oldQty) === Math.sign(signedQty)) {
          avgPrice = Number(((Math.abs(oldQty) * Number(existing.avgPrice) + Math.abs(signedQty) * fillPrice) / Math.abs(newQty)).toFixed(2));
        }
        await tx.position.update({ where: { id: existing.id }, data: { quantity: newQty, avgPrice } });
      }

      return { order, trade };
    });
  }

  async positions(userId: string) {
    const positions = await this.prisma.position.findMany({
      where: { userId, quantity: { not: 0 } },
      include: { instrument: { include: { quotes: { orderBy: { updatedAt: 'desc' }, take: 1 } } } },
      orderBy: { updatedAt: 'desc' },
    });
    return positions.map((p) => {
      const ltp = p.instrument.quotes[0] ? Number(p.instrument.quotes[0].ltp) : Number(p.avgPrice);
      const avg = Number(p.avgPrice);
      const pnl = Number(((ltp - avg) * p.quantity + Number(p.realizedPnl)).toFixed(2));
      return {
        id: p.id,
        instrumentId: p.instrumentId,
        symbol: p.instrument.symbol,
        displayName: p.instrument.displayName,
        quantity: p.quantity,
        avgPrice: avg,
        ltp,
        pnl,
      };
    });
  }
}
