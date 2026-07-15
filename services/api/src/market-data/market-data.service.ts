import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MarketDataService {
  constructor(private readonly prisma: PrismaService) {}

  async quote(instrumentId: string) {
    const quote = await this.prisma.quote.findFirst({
      where: { instrumentId },
      orderBy: { updatedAt: 'desc' },
      include: { instrument: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    return {
      instrumentId,
      symbol: quote.instrument.symbol,
      displayName: quote.instrument.displayName,
      ltp: Number(quote.ltp),
      previousClose: quote.previousClose ? Number(quote.previousClose) : null,
      updatedAt: quote.updatedAt,
      mode: 'BRIDGE_SEEDED_QUOTE',
    };
  }
}
