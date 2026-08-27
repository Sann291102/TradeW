import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// Root .env is the single source of truth for the monorepo (consolidated
// 2026-08-04 — see .env.example at the repo root).
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Company intelligence ingestion runtime.
 *
 * HORIZONTALLY SCALABLE, unlike services/market-data. That service is a
 * singleton because a broker feed connection set is a per-account resource; this
 * one has no such constraint. Work is claimed per job row by an atomic
 * conditional UPDATE, so a second replica takes different jobs rather than
 * duplicating the first's — see IngestionSchedulerService for why the exclusion
 * is per row rather than the service-wide JobLease used elsewhere in this repo.
 *
 * Ingestion is OFF unless COMPANY_DATA_INGESTION_ENABLED=true. A loop that
 * started itself on boot would call an external exchange from every developer
 * laptop and every CI run.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Without this, SIGTERM kills the process before OnModuleDestroy runs, so an
  // in-flight job keeps its claim until the claim expires rather than being
  // released promptly.
  app.enableShutdownHooks();
  const port = Number(process.env.COMPANY_DATA_PORT || process.env.PORT || 4030);
  // Internal service: localhost by default; container deployments override with
  // HOST=0.0.0.0 behind the private network boundary.
  const host = process.env.HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`Company data ingestor (internal) listening on ${host}:${port}`);
}
bootstrap();
