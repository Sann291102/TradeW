import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// Root .env is the single source of truth for the monorepo (consolidated
// 2026-08-04 — see .env.example at the repo root). Resolved explicitly by
// path rather than relying on `dotenv/config`'s cwd-relative default, since
// this service is started from different working directories depending on
// how it's run (npm workspace scripts, ts-node directly, compiled dist/).
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { SWAGGER_PATH, isSwaggerEnabled, setupSwagger } from './swagger/swagger.setup';

async function bootstrap() {
  // `rawBody` is required by ControlGuard: the Admin Control Plane's Ed25519
  // signature covers the exact bytes sent, and re-serializing the parsed body
  // would not reproduce them (key order, unicode escaping, duplicate keys).
  // Nest keeps the parsed `req.body` behaviour unchanged for every other route.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  /**
   * Trust exactly as many reverse-proxy hops as are actually in front of this
   * process, and no more.
   *
   * Everything that identifies a caller — the rate-limit bucket in
   * common/throttling.ts, and the `ip` field on every row the security logger
   * writes — reads `req.ip`. Without this, Express reports the proxy's address
   * for every request: one shared rate-limit bucket for the entire internet
   * (so the first noisy client throttles everyone), and an audit trail that
   * records Caddy's IP for every login attempt.
   *
   * `true` would be worse than nothing: it makes Express believe the whole
   * `X-Forwarded-For` chain, so a client can prepend a fabricated address and
   * mint itself a fresh rate-limit bucket per request. The count must match the
   * deployment — 1 behind Caddy (infra/docker), 2 behind CloudFront→ALB. It is
   * 0 by default so a direct-exposure setup does not silently trust a header
   * that nothing is stripping.
   */
  const trustedProxyHops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);
  if (Number.isFinite(trustedProxyHops) && trustedProxyHops > 0) {
    app.getHttpAdapter().getInstance().set('trust proxy', trustedProxyHops);
  }

  /**
   * Terminate in-flight work before the process dies.
   *
   * Nest does not call `OnModuleDestroy` on SIGTERM unless shutdown hooks are
   * enabled, and every deploy sends SIGTERM. Without this, a rolling restart
   * killed the process mid-request and — worse — skipped `TelemetryService`'s
   * final flush (up to 2s of API/AI/agent telemetry silently lost per deploy)
   * and left `PrismaService` to have its sockets torn down by the OS rather
   * than disconnected.
   */
  app.enableShutdownHooks();

  // Allowed browser origins. FRONTEND_URL may be a comma-separated list.
  const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isProd = process.env.NODE_ENV === 'production';

  /**
   * Security response headers for the API.
   *
   * Written as a small middleware rather than pulling in `helmet`: this is a
   * fixed set of static headers, the API serves JSON rather than documents, and
   * adding a dependency to set them would need an install step before any of
   * this takes effect.
   *
   * These matter even for a JSON API. A browser that is talked into navigating
   * directly to an endpoint will render whatever comes back, so `nosniff` plus a
   * locked-down CSP stops a reflected value being treated as script or markup,
   * and `frame-ancestors`/X-Frame-Options stop an API response being framed as
   * part of a UI redress attack. The document-level policy for the app itself
   * lives in apps/web/next.config.mjs.
   */
  app.use((req: SecurityHeaderRequest, res: SecurityHeaderResponse, next: () => void) => {
    // An API response never legitimately loads a script, styles a document, or
    // frames anything, so its CSP can be as strict as CSP gets.
    //
    // Swagger UI is the one exception, and it has to be: it IS a document, and
    // `default-src 'none'` would refuse its own bundle and stylesheet and render
    // a blank page. It gets a policy scoped to what it actually needs — its own
    // same-origin assets, and the inline script/style tags swagger-ui-express
    // emits for its bootstrap config. Still no external origins, so a
    // compromised upstream package cannot phone anywhere, and the strict policy
    // above continues to cover every route that serves data.
    res.setHeader(
      'Content-Security-Policy',
      isSwaggerDocsRequest(req)
        ? "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
          "frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // API URLs carry instrument, order and user identifiers; do not put them in
    // a Referer header sent to a third party.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    // Responses are user-scoped; a shared cache must never serve one user's
    // portfolio to another.
    res.setHeader('Cache-Control', 'no-store');

    // HSTS in production only — see the note in apps/web/next.config.mjs on why
    // pinning this for localhost is harmful.
    if (isProd) {
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
    next();
  });

  app.enableCors({
    // Production: strict allowlist. Development: also accept any localhost/
    // 127.0.0.1 port (the web dev server uses a dynamic port) and non-browser
    // tools (no Origin header), so the frontend can reach the API regardless of
    // which port the dev server landed on.
    origin: isProd
      ? allowedOrigins
      : (origin, cb) => {
          const ok =
            !origin ||
            allowedOrigins.includes(origin) ||
            /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
            (typeof origin === 'string' && origin.endsWith('.trycloudflare.com'));
          cb(null, ok);
        },
    credentials: true,
    // The broker callback and the admin routes are the only consumers of these
    // beyond the defaults; listed explicitly so a preflight for them is not
    // rejected in production.
    // X-Request-Id lets the web app correlate a browser-side action with the
    // server row the admin portal shows for it.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-Request-Id'],
    // A response header the browser cannot read might as well not have been
    // sent: `fetch` hides everything not on this list when the response is
    // cross-origin, which every call from apps/web is. `Retry-After` is the
    // one the rate limiter emits on a 429 (see common/throttling.ts) and the
    // one the web client waits on before retrying — without it exposed, that
    // client falls back to guessing and retries into a window it was told the
    // exact length of.
    // X-Request-Id is on this list for the same reason Retry-After is: the web
    // app and the API are separate origins, so a header not named here is
    // invisible to `fetch` even though it arrived. It is the id that ties an
    // error the user is looking at to the stack trace in the API log — see
    // AllExceptionsFilter.
    exposedHeaders: ['Retry-After', 'X-Request-Id'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  /**
   * Every unhandled error becomes an HTTP response HERE, and nowhere else.
   *
   * Without it, Nest answers anything it does not recognise with a bare
   * `{"statusCode":500,"message":"Internal server error"}` — which is what an
   * un-migrated database looked like on `POST /auth/login`, for every account,
   * with nothing in the body to say so. The filter classifies the cause,
   * returns 503 for an environment fault rather than 500, and stamps every
   * error with a request id that also appears in the log line.
   */
  app.useGlobalFilters(new AllExceptionsFilter());

  // After the pipes and CORS so the document reflects the app as it actually
  // runs, and after the middleware above so the docs page is served with the
  // CSP that lets it render. No-op when disabled — see isSwaggerEnabled().
  setupSwagger(app);

  const port = Number(process.env.API_PORT || process.env.PORT || 4000);
  // Bind to loopback by default so a dev machine does not expose the API to its
  // whole LAN (the 2026-08-10 finding: `app.listen(port)` bound 0.0.0.0, making
  // every route — and, with the old forgeable JWT, every account — reachable
  // from any host on the network). Container/K8s deployments set HOST=0.0.0.0
  // explicitly, behind the private-network boundary. Mirrors services/sentinel.
  const host = process.env.HOST || '127.0.0.1';
  await app.listen(port, host);
  console.log(`TradeW backend listening on ${host}:${port}`);
  if (isSwaggerEnabled()) {
    console.log(`API reference on http://localhost:${port}/${SWAGGER_PATH}`);
  }
}

/** Only `setHeader` is used, so the response is typed structurally rather than
 *  pulling @types/express in for one middleware. */
interface SecurityHeaderResponse {
  setHeader(name: string, value: string): void;
}

/** Likewise — the CSP branch reads nothing but the path. */
interface SecurityHeaderRequest {
  url?: string;
}

/**
 * The Swagger UI document and the assets it pulls in, but NOT `/docs-json` or
 * `/docs-yaml`: those are data, and data keeps the strict policy.
 */
function isSwaggerDocsRequest(req: SecurityHeaderRequest): boolean {
  const path = (req.url ?? '').split('?')[0];
  return path === `/${SWAGGER_PATH}` || path.startsWith(`/${SWAGGER_PATH}/`);
}

bootstrap();
