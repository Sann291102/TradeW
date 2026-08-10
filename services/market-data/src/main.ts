import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// Root .env is the single source of truth for the monorepo (consolidated
// 2026-08-04 — see .env.example at the repo root).
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Market data ingestion runtime.
 *
 * SINGLETON BY DESIGN — do not scale this service horizontally. The broker feed
 * connection set is a per-account resource (Dhan allows five connections per
 * user and evicts the oldest with disconnect code 805 on a sixth), so a second
 * replica would fight the first for connections. Scale `services/api` instead;
 * it is stateless and reads what this writes.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Without this, SIGTERM kills the process before `OnModuleDestroy` runs, so
  // `TickPipelineService` never flushes its buffer and the feed socket is torn
  // down by the OS rather than closed — which, on a broker that counts live
  // connections per account, can leave the slot occupied until it times out.
  app.enableShutdownHooks();
  const port = Number(process.env.MARKET_DATA_PORT || process.env.PORT || 4020);
  // Internal service: localhost by default; container deployments override with
  // HOST=0.0.0.0 behind the private network boundary.
  await app.listen(port, process.env.HOST || '127.0.0.1');
  console.log(`Market data ingestor (internal) listening on ${process.env.HOST || '127.0.0.1'}:${port}`);
}
bootstrap();
