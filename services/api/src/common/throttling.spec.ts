import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { TradewThrottlerGuard } from './throttling';

/**
 * The two properties that make this rate limiter a limit rather than a
 * decoration, pinned directly because both are easy to break by accident and
 * neither fails loudly when broken:
 *
 *  1. The `global` bucket must NOT include the handler in its key. If it does,
 *     "300 requests per minute" silently becomes "300 per minute per route",
 *     which for ~40 routes is a 12,000/min ceiling — i.e. no ceiling. This is
 *     the default behaviour of @nestjs/throttler, so the override is the whole
 *     mechanism and a refactor that drops it looks like a simplification.
 *  2. Probe endpoints must never be throttled. A 429 on `/ready` under load
 *     pulls the instance out of the load balancer, and a 429 on `/health`
 *     gets the container killed — both convert a burst of traffic into an
 *     outage, which is the opposite of what a rate limiter is for.
 *
 * `generateKey` and `shouldSkip` are protected members of the base class; the
 * cast is deliberate and local to the test — they are the units under test, and
 * exercising them through a full Nest application context would test
 * @nestjs/throttler rather than this file's two decisions.
 */

type KeyFn = (context: ExecutionContext, suffix: string, name: string) => string;
type SkipFn = (context: ExecutionContext) => Promise<boolean>;
type ThrowFn = (context: ExecutionContext, detail: { timeToBlockExpire?: number }) => Promise<void>;

/** A guard instance with the DI arguments the base constructor never touches
 *  on these two code paths. */
function guard() {
  const g = new TradewThrottlerGuard({ throttlers: [] } as never, {} as never, {} as never);
  return g as unknown as { generateKey: KeyFn; shouldSkip: SkipFn; throwThrottlingException: ThrowFn };
}

/** Minimal structural ExecutionContext — only the members these paths read. */
function ctx(url: string, className = 'AuthController', handlerName = 'login'): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ url }) }),
    getClass: () => ({ name: className }),
    getHandler: () => ({ name: handlerName }),
  } as unknown as ExecutionContext;
}

/** As `ctx`, plus a response that records the headers the guard sets on a 429. */
function ctxWithResponse(): { context: ExecutionContext; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ url: '/sentinel/observe' }),
      getResponse: () => ({ setHeader: (k: string, v: string) => void (headers[k] = v) }),
    }),
    getClass: () => ({ name: 'SentinelController' }),
    getHandler: () => ({ name: 'observe' }),
  } as unknown as ExecutionContext;
  return { context, headers };
}

describe('TradewThrottlerGuard — bucket identity', () => {
  it('keys the global bucket by caller alone, so it spans every route', () => {
    const g = guard();
    const fromLogin = g.generateKey(ctx('/auth/login', 'AuthController', 'login'), '1.2.3.4', 'global');
    const fromOrders = g.generateKey(ctx('/sim/orders', 'SimController', 'createOrder'), '1.2.3.4', 'global');
    expect(fromLogin).toBe(fromOrders);
  });

  it('gives two different callers different global buckets', () => {
    const g = guard();
    expect(g.generateKey(ctx('/auth/login'), '1.2.3.4', 'global')).not.toBe(
      g.generateKey(ctx('/auth/login'), '5.6.7.8', 'global'),
    );
  });

  it('keys the route bucket per handler, so login and signup do not share a budget', () => {
    const g = guard();
    const login = g.generateKey(ctx('/auth/login', 'AuthController', 'login'), '1.2.3.4', 'route');
    const signup = g.generateKey(ctx('/auth/signup', 'AuthController', 'signup'), '1.2.3.4', 'route');
    expect(login).not.toBe(signup);
  });

  it('keeps the same handler on the same route bucket for one caller', () => {
    const g = guard();
    const a = g.generateKey(ctx('/auth/login', 'AuthController', 'login'), '1.2.3.4', 'route');
    const b = g.generateKey(ctx('/auth/login', 'AuthController', 'login'), '1.2.3.4', 'route');
    expect(a).toBe(b);
  });

  it('does not let a route bucket collide with the global one', () => {
    const g = guard();
    expect(g.generateKey(ctx('/auth/login'), '1.2.3.4', 'route')).not.toBe(
      g.generateKey(ctx('/auth/login'), '1.2.3.4', 'global'),
    );
  });
});

describe('TradewThrottlerGuard — unmetered probes', () => {
  it.each(['/health', '/ready', '/live'])('never throttles %s', async (path) => {
    expect(await guard().shouldSkip(ctx(path))).toBe(true);
  });

  it('ignores the query string when deciding', async () => {
    expect(await guard().shouldSkip(ctx('/ready?verbose=1'))).toBe(true);
  });

  it('skips nested probe paths', async () => {
    expect(await guard().shouldSkip(ctx('/health/db'))).toBe(true);
  });

  it('does not skip a route that merely starts with the same letters', async () => {
    // `/healthcheck-report` is a real route shape someone could add later; the
    // prefix test must not hand it a rate-limit exemption.
    expect(await guard().shouldSkip(ctx('/healthcheck-report'))).toBe(false);
  });

  it('throttles ordinary routes', async () => {
    expect(await guard().shouldSkip(ctx('/auth/login'))).toBe(false);
    expect(await guard().shouldSkip(ctx('/sim/orders'))).toBe(false);
  });

  it('skips non-HTTP contexts rather than reading a request that is not there', async () => {
    const rpc = { getType: () => 'rpc' } as unknown as ExecutionContext;
    expect(await guard().shouldSkip(rpc)).toBe(true);
  });
});

/**
 * A 429 has to say WHEN to come back.
 *
 * @nestjs/throttler suffixes the header with the throttler's name for anything
 * not literally called `default`, and both of this API's throttlers are named.
 * So without the override under test a rate-limited response carries
 * `Retry-After-global` / `Retry-After-route` and no canonical `Retry-After` at
 * all — leaving every client, including apps/web, to guess a delay the server
 * already knows exactly. Guessing short earns another 429; guessing long keeps
 * the Sentinel workspace showing "reconnecting" after the window has lifted.
 */
describe('TradewThrottlerGuard — Retry-After', () => {
  const detail = (timeToBlockExpire: number) => ({ timeToBlockExpire });

  async function retryAfter(timeToBlockExpire: number): Promise<string | undefined> {
    const { context, headers } = ctxWithResponse();
    // The base implementation's job is to throw; this asserts what was set on
    // the way out, not that it declined to throw.
    await guard()
      .throwThrottlingException(context, detail(timeToBlockExpire))
      .catch(() => undefined);
    return headers['Retry-After'];
  }

  it('sets the canonical header from the time left in the window', async () => {
    expect(await retryAfter(37)).toBe('37');
  });

  it('rounds up, never down', async () => {
    // Rounding 4.2s down to 4 names an instant still inside the window — a
    // retry guaranteed to be refused, which extends the block it is waiting on.
    expect(await retryAfter(4.2)).toBe('5');
  });

  it('never says zero seconds', async () => {
    // "Retry immediately" is not an answer a rate limiter can give.
    expect(await retryAfter(0)).toBe('1');
  });

  it('does not touch a non-HTTP context', async () => {
    const rpc = { getType: () => 'rpc' } as unknown as ExecutionContext;
    await expect(
      guard()
        .throwThrottlingException(rpc, detail(10))
        .catch(() => 'threw'),
    ).resolves.toBeDefined();
  });
});
