import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// Root .env is the single source of truth for the monorepo (consolidated
// 2026-08-04). `override: true` for the same reason services/sentinel does it:
// a pre-set empty SERVICE_TOKEN in the environment otherwise wins over the
// file and silently disables the guard.
loadEnv({ path: resolve(__dirname, '../../../.env'), override: true });

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * TradeW AI (Research) runtime — AI-OPERATING-SYSTEM.md §3, layer 1.
 *
 * The conversation brain. `apps/web` never calls this: the only caller is
 * `services/api`, which holds the user session, checks entitlement and writes
 * the audit record (ARCHITECTURE.md §1's one public ingress). That is why this
 * binds to localhost by default and is guarded by a shared service token rather
 * than by a user JWT — it has no concept of a user session and must not grow
 * one.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  // Local dev only, matching services/sentinel: in staging/production this
  // service is internal and cross-origin never applies because nothing in a
  // browser is allowed to reach it.
  app.enableCors({
    origin: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(','),
    allowedHeaders: ['content-type', 'x-service-token'],
  });

  const port = Number(process.env.TRADEW_AI_PORT || 4020);
  // Internal service: localhost by default. The 2026-08-10 production-readiness
  // audit found services bound to 0.0.0.0 and exposed to the whole LAN; K8s and
  // container deployments override with HOST=0.0.0.0 behind a private network.
  const host = process.env.HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`TradeW AI (internal) listening on ${host}:${port}`);
}

void bootstrap();
