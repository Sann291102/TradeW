import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InstrumentsService {
  constructor(private readonly prisma: PrismaService) {}

  search(q = '') {
    const query = q.trim();
    return this.prisma.instrument.findMany({
      where: query ? {
        OR: [
          { symbol: { contains: query, mode: 'insensitive' } },
          { displayName: { contains: query, mode: 'insensitive' } },
          { underlying: { contains: query, mode: 'insensitive' } },
        ],
      } : {},
      orderBy: [{ type: 'asc' }, { symbol: 'asc' }],
      take: 25,
    });
  }
}
