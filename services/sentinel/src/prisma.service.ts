import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Sentinel's own Prisma client. Table ownership (ARCHITECTURE.md §1.4):
 * Sentinel owns SentinelObservation and reads/writes MemoryRecord/GraphNode
 * rows only within the 'sentinel' namespace. It NEVER touches trading tables
 * (orders/trades/positions) — services/api passes trade summaries per request.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
