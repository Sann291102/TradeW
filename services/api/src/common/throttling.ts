import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail, ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';

/**
 * Request rate limiting — the availability boundary in front of every route.
 *
 * WHY THIS EXISTS (2026-08-10 production-readiness audit)
 *
 * Before this file, `services/api` had no rate limiting of any kind. Three
 * concrete consequences, none of them theoretical:
 *
 *  1. `POST /auth/login` accepted unlimited attempts from one source, so an
 *     online password-guessing run against a known email was bounded only by
 *     bcrypt's cost factor — and bcrypt protects the *hash*, not the endpoint.
 *  2. `POST /auth/signup`, `/auth/phone/request` and `/auth/password/forgot`
 *     each spend real money or reputation per call (a row, an SMS, an email).
 *     Unmetered, they are a billing and deliverability incident waiting for
 *     someone to notice they exist.
 *  3. The unauthenticated market proxies (`/crypto/*`, `/forex/*`, `/us-stocks/*`,
 *     `/news`) forward to third-party APIs on TradeW's key and quota. Anyone
 *     could drain that quota for every real user with a `while true` loop.
 *
 * TWO BUCKETS, ON PURPOSE
 *
 * `@nestjs/throttler` keys every bucket per handler by default, which means a
 * single "global" limit is really a separate budget for each of ~40 routes —
 * not a ceiling at all. So there are two named throttlers and every request is
 * measured against both:
 *
 *   · `global` — keyed by CALLER ONLY, so it is a true per-caller ceiling
 *     across the whole API. This is what stops a scraper that spreads its load
 *     evenly across many endpoints.
 *   · `route`  — keyed by caller AND handler, deliberately inert by default
 *     (a high limit no real client reaches) and tightened per sensitive route
 *     with `@Throttle(AUTH_LIMIT)` and friends. Separate buckets mean burning
 *     login attempts does not also burn signup attempts.
 *
 * WHAT IS AND IS NOT KEYED BY USER
 *
 * Global guards run BEFORE route guards in Nest, so `AuthGuard` has not
 * populated `req.user` by the time this guard decides. Buckets are therefore
 * keyed by client IP, deliberately — decoding a bearer token here to key by
 * subject would mean trusting an unverified token to choose a rate-limit
 * bucket, which is a way to escape the limit rather than a way to apply it.
 *
 * The IP has to be the real client IP. Behind Caddy (or an ALB) every request
 * arrives from the proxy, so without `trust proxy` set on the Express adapter
 * the entire internet shares one bucket and the first noisy client locks out
 * everybody. That setting lives in `main.ts` next to the other transport-level
 * configuration, and `TRUSTED_PROXY_HOPS` bounds how many `X-Forwarded-For`
 * entries are believed so a client cannot spoof its way into a fresh bucket.
 *
 * SINGLE PROCESS, NOT A CLUSTER
 *
 * Counters live in this process's memory. That is correct for the Stage 0
 * single-VM deployment (one API container) and WRONG the moment a second
 * replica exists: N replicas means N× the limit, and a bucket resets whenever a
 * container restarts. `docs/CLOUD-ARCHITECTURE.md` tracks the Redis-backed
 * storage swap as a Stage 1 prerequisite, not a nice-to-have — it is listed
 * there rather than stubbed here because a half-wired distributed limiter reads
 * as protection while providing none.
 */

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Per-caller budget across the whole API, per minute. */
export const GLOBAL_PER_MIN = num(process.env.RATE_LIMIT_GLOBAL_PER_MIN, 300);

/**
 * Default ceiling for the per-route bucket. Set high on purpose: routes that
 * need a real limit declare one, and everything else is governed by `global`.
 * It is not `Infinity` because a per-route runaway (a client stuck in a retry
 * loop on one endpoint) should still be dampened before it reaches the DB.
 */
export const ROUTE_DEFAULT_PER_MIN = num(process.env.RATE_LIMIT_ROUTE_PER_MIN, 240);

/**
 * Credential-handling endpoints: login, signup, password reset verification.
 * Low enough to make online guessing useless, high enough that a person who
 * genuinely mistypes a password four times is not locked out of their evening.
 */
export const AUTH_LIMIT = {
  route: { ttl: 60_000, limit: num(process.env.RATE_LIMIT_AUTH_PER_MIN, 8) },
};

/**
 * Endpoints that send a message (SMS/email) or otherwise cost money per call.
 * Stricter than AUTH_LIMIT because the cost is external and per-request.
 */
export const OTP_LIMIT = {
  route: { ttl: 60_000, limit: num(process.env.RATE_LIMIT_OTP_PER_MIN, 3) },
};

/**
 * Unauthenticated third-party proxies. Sized against the frontend's own poll
 * cadence (crypto 10s, FX 60s, news 120s — see apps/web/src/lib/externalMarkets.ts)
 * with generous headroom for a user with several tabs open, and far below what
 * a scraper needs to be worth running.
 */
export const PUBLIC_PROXY_LIMIT = {
  route: { ttl: 60_000, limit: num(process.env.RATE_LIMIT_PUBLIC_PER_MIN, 60) },
};

/**
 * Expensive AI/analysis endpoints. One Sentinel observation fans out to the
 * intelligence engines, the Brain and (when configured) a provider call, so a
 * caller looping this costs orders of magnitude more than a portfolio read.
 */
export const EXPENSIVE_LIMIT = {
  route: { ttl: 60_000, limit: num(process.env.RATE_LIMIT_EXPENSIVE_PER_MIN, 30) },
};

/** Paths that must answer even while a caller is being throttled. */
const UNMETERED_PREFIXES = ['/health', '/ready', '/live'];

@Injectable()
export class TradewThrottlerGuard extends ThrottlerGuard {
  constructor(options: ThrottlerModuleOptions, storageService: ThrottlerStorage, reflector: Reflector) {
    super(options, storageService, reflector);
  }

  /**
   * Liveness and readiness are how the orchestrator decides whether to kill this
   * container. A probe that gets a 429 during a traffic spike would take the
   * instance down at exactly the moment it is under load, converting a
   * rate-limiting event into an outage.
   */
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest();
    const path: string = String(req?.url ?? '').split('?')[0];
    return UNMETERED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  }

  /**
   * Bucket identity. `global` drops the handler from the key so it spans the
   * whole API; `route` keeps it so each endpoint is metered on its own.
   */
  protected generateKey(context: ExecutionContext, suffix: string, name: string): string {
    if (name === 'global') return `global:${suffix}`;
    return `${name}:${context.getClass().name}.${context.getHandler().name}:${suffix}`;
  }

  /**
   * Emit a STANDARD `Retry-After` alongside whatever the base guard set.
   *
   * ── WHY THIS IS NOT REDUNDANT ──────────────────────────────────────────────
   *
   * `@nestjs/throttler` suffixes the header with the throttler's name for every
   * throttler not literally called `default`. Both of ours are named — `global`
   * and `route`, deliberately, because the two-bucket design in the header of
   * this file depends on telling them apart. The consequence nobody notices
   * until a client tries to be well-behaved: a 429 from this API carries
   * `Retry-After-global` or `Retry-After-route` and NO `Retry-After` at all.
   *
   * So every HTTP client on earth, ours included, falls back to guessing when
   * the server already knows the answer to the second. Guessing short means
   * another 429 that extends the window; guessing long means the workspace
   * sits in a "reconnecting" state after the limit has already lifted. The
   * named headers stay — they say WHICH bucket tripped, which is genuinely
   * useful — and the canonical one is added next to them.
   *
   * Reading it in the browser also needs it in `exposedHeaders` on the CORS
   * config (services/api/src/main.ts): the API and the web app are separate
   * origins, and a response header not on that list is invisible to `fetch`
   * even though it arrived.
   */
  protected async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    if (context.getType() === 'http') {
      const res = context.switchToHttp().getResponse();
      // Seconds, rounded UP: rounding down names an instant that is still
      // inside the window, which is a retry guaranteed to be refused.
      const seconds = Math.max(1, Math.ceil((throttlerLimitDetail.timeToBlockExpire ?? 0) || 1));
      res?.setHeader?.('Retry-After', String(seconds));
    }
    return super.throwThrottlingException(context, throttlerLimitDetail);
  }
}
