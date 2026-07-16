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
    // Lazy/fault-tolerant connect: Sentinel's observation pipeline is fully
    // functional without persistence (ComplianceService already tolerates
    // write failures and logs the audit gap loudly). An internal intelligence
    // service must not crash-loop because the database is briefly away.
    try {
      await this.$connect();
    } catch (err) {
      console.warn(`[sentinel] database unavailable at boot — running without persistence: ${err}`);
    }
  }
  async onModuleDestroy() {
    await this.$disconnect().catch(() => undefined);
  }
}
