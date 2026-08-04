import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
  app.use((_req: unknown, res: SecurityHeaderResponse, next: () => void) => {
    // An API response never legitimately loads a script, styles a document, or
    // frames anything, so its CSP can be as strict as CSP gets.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
            /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
          cb(null, ok);
        },
    credentials: true,
    // The broker callback and the admin routes are the only consumers of these
    // beyond the defaults; listed explicitly so a preflight for them is not
    // rejected in production.
    // X-Request-Id lets the web app correlate a browser-side action with the
    // server row the admin portal shows for it.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-Request-Id'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.PORT || 4000);
  await app.listen(port);
  console.log(`TradeW backend listening on ${port}`);
}

/** Only `setHeader` is used, so the response is typed structurally rather than
 *  pulling @types/express in for one middleware. */
interface SecurityHeaderResponse {
  setHeader(name: string, value: string): void;
}

bootstrap();
