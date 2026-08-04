import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// Root .env is the single source of truth for the monorepo (consolidated
// 2026-08-04 — see .env.example at the repo root). `override: true` because
// dotenv otherwise leaves any already-set process.env value alone (even an
// empty one) — this dev host pre-sets SERVICE_TOKEN to '' before this process
// starts, which silently defeated ServiceTokenGuard until this was added.
loadEnv({ path: resolve(__dirname, '../../../.env'), override: true });

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Local-dev only: lets the Terminal app (localhost:3000) call this service
  // directly from the browser. In staging/production the service stays
  // internal — only services/api reaches it — so cross-origin never applies.
  app.enableCors({
    origin: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(','),
    allowedHeaders: ['content-type', 'x-service-token'],
  });
  const port = Number(process.env.SENTINEL_PORT || process.env.PORT || 4010);
  // internal service: bind to localhost by default; container/K8s deployments
  // override with HOST=0.0.0.0 behind the private network boundary
  await app.listen(port, process.env.HOST || '127.0.0.1');
  console.log(`Sentinel (internal) listening on ${process.env.HOST || '127.0.0.1'}:${port}`);
}
bootstrap();
