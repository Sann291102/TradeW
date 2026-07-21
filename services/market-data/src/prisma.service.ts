import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * The ingestor's Prisma client. Table ownership (ARCHITECTURE.md §1.4):
 * this service is the sole writer of `Quote` and the sole writer of
 * broker-metadata columns on `Instrument`. It never touches trading tables.
 *
 * Fault-tolerant connect, matching services/sentinel: an ingestor that
 * crash-loops because Postgres blinked would drop the feed connection too, and
 * reconnecting to the broker is far more expensive than retrying a write.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    try {
      await this.$connect();
    } catch (err) {
      console.warn(`[market-data] database unavailable at boot — ingestion will retry: ${err}`);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect().catch(() => undefined);
  }
}
