import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    // Fault-tolerant boot: a DB outage must not crash-loop the whole API.
    // Endpoints that don't touch the DB (health, static plan lookups once
    // cached) keep working; DB-backed routes fail per-request with a clear
    // error instead of the process refusing to start.
    try {
      await this.$connect();
    } catch (err) {
      console.warn(`[api] database unavailable at boot — DB-backed routes will error until it recovers: ${err}`);
    }
  }
  async onModuleDestroy() { await this.$disconnect().catch(() => undefined); }
}
