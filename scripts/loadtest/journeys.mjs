/**
 * The user journeys the load test actually exercises.
 *
 * These are deliberately written as JOURNEYS rather than as a list of
 * endpoints. A benchmark that hammers `/health` at 20,000 rps tells you nothing
 * about whether a person can use the product; what matters is whether the
 * sequence a real session performs — sign in, open the dashboard, poll it while
 * reading, check the portfolio, place an order — completes within a latency
 * anyone would call usable, at the target population size.
 *
 * The poll cadences below are copied from the frontend, not invented:
 *   quotes  5s   apps/web/src/lib/hooks/useLiveQuotes.ts
 *   crypto  10s  apps/web/src/lib/externalMarkets.ts CRYPTO_POLL_MS
 *   fx      60s  apps/web/src/lib/externalMarkets.ts FX_POLL_MS
 *   news    120s apps/web/src/lib/news.ts NEWS_POLL_MS
 * That matters more than it sounds: the dashboard's steady-state cost per user
 * is set by those intervals, so a target of N concurrent users implies a
 * specific background request rate whether anyone clicks anything or not.
 */

import { request, think } from './harness.mjs';

/** Records a step and returns the raw result so a journey can branch on it. */
async function step(recorder, name, opts) {
  const res = await request(opts);
  recorder.record(name, res);
  return res;
}

/**
 * Sign in and hold the token for the life of the virtual user.
 *
 * Real sessions log in once and then make hundreds of authenticated calls, so
 * re-authenticating every iteration would both overstate bcrypt's share of the
 * load and immediately trip the auth rate limiter — measuring the limiter
 * instead of the app.
 */
export async function login(recorder, { apiBase, email, password }) {
  const res = await step(recorder, 'POST /auth/login', {
    url: `${apiBase}/auth/login`,
    method: 'POST',
    body: { email, password },
  });
  if (!res.ok) return null;
  try {
    return JSON.parse(res.body).accessToken;
  } catch {
    return null;
  }
}

/** An anonymous visitor landing on the marketing page and nothing else. */
export function anonymousLanding({ webBase }) {
  return async ({ recorder }) => {
    await step(recorder, 'GET / (web landing)', { url: `${webBase}/` });
    await think(8_000);
  };
}

/**
 * The signed-in dashboard: one page load's worth of reads, then the polling
 * the page does on its own while the user reads it.
 *
 * Modelled as a single iteration ≈ 10 seconds of a real session, so the request
 * mix per unit time matches the frontend's cadence rather than a burst.
 */
export function dashboard({ apiBase, token }) {
  const auth = { authorization: `Bearer ${token}` };
  let tick = 0;
  return async ({ recorder }) => {
    tick += 1;
    // Indices + quotes are the 5s poll: twice per 10s iteration.
    await step(recorder, 'GET /market-data/indices', { url: `${apiBase}/market-data/indices`, headers: auth });
    await think(5_000, 1_000);
    await step(recorder, 'GET /market-data/indices', { url: `${apiBase}/market-data/indices`, headers: auth });

    // Crypto board: 10s poll, so once per iteration.
    await step(recorder, 'GET /crypto/quotes', { url: `${apiBase}/crypto/quotes`, headers: auth });

    // News: 120s poll — once every twelfth iteration, not every one. Getting
    // this wrong is how a load test invents traffic the product never sends.
    if (tick % 12 === 0) {
      await step(recorder, 'GET /news', { url: `${apiBase}/news?limit=40`, headers: auth });
    }
    await think(5_000, 1_000);
  };
}

/** Opening the portfolio and looking at it. Every read here is user-scoped, so
 *  none of it is cacheable across users — this is the flow that puts the most
 *  per-user work on Postgres. */
export function portfolio({ apiBase, token }) {
  const auth = { authorization: `Bearer ${token}` };
  return async ({ recorder }) => {
    await step(recorder, 'GET /sim/portfolio', { url: `${apiBase}/sim/portfolio`, headers: auth });
    await step(recorder, 'GET /sim/positions', { url: `${apiBase}/sim/positions`, headers: auth });
    await step(recorder, 'GET /sim/holdings', { url: `${apiBase}/sim/holdings`, headers: auth });
    await step(recorder, 'GET /sim/orders', { url: `${apiBase}/sim/orders`, headers: auth });
    await think(12_000, 4_000);
    await step(recorder, 'GET /sim/trade-history', { url: `${apiBase}/sim/trade-history`, headers: auth });
    await step(recorder, 'GET /sim/performance/overview', {
      url: `${apiBase}/sim/performance/overview`,
      headers: auth,
    });
    await think(15_000, 5_000);
  };
}

/** Browsing the learning platform — the read-heavy, highly cacheable end of
 *  the product, included so the mix is not entirely trading. */
export function learning({ apiBase, token }) {
  const auth = { authorization: `Bearer ${token}` };
  return async ({ recorder }) => {
    await step(recorder, 'GET /learning/courses', { url: `${apiBase}/learning/courses`, headers: auth });
    await think(10_000, 4_000);
    await step(recorder, 'GET /learning/progress', { url: `${apiBase}/learning/progress`, headers: auth });
    await think(20_000, 8_000);
  };
}

/**
 * Placing and immediately cancelling a resting LIMIT order.
 *
 * A LIMIT far from the market is used on purpose: it rests instead of filling,
 * so the journey exercises the write path and the matching engine's scan
 * without accumulating positions that would change the portfolio journey's cost
 * halfway through a run. It is cancelled in the same iteration so the resting
 * book does not grow without bound over a long test.
 */
export function trading({ apiBase, token, symbol }) {
  const auth = { authorization: `Bearer ${token}` };
  return async ({ recorder }) => {
    const placed = await step(recorder, 'POST /sim/orders', {
      url: `${apiBase}/sim/orders`,
      method: 'POST',
      headers: auth,
      body: {
        // `symbol`, not an instrument id — PlaceOrderDto resolves the
        // instrument server-side (sim.controller.ts). The first version of this
        // journey posted `instrumentId` and got a 400 on every single request,
        // which the run reported as a 100% failure rate on the order path. Worth
        // recording: a load test that sends a contract the API rejects measures
        // the validation pipe, and it does so while looking like a load result.
        symbol,
        side: 'BUY',
        type: 'LIMIT',
        quantity: 1,
        // Deliberately far below any plausible market price so it never fills.
        price: 1,
        productType: 'CNC',
      },
    });

    let orderId = null;
    try {
      orderId = JSON.parse(placed.body)?.id ?? null;
    } catch {
      /* the status code already recorded the failure */
    }

    await think(3_000, 1_000);

    if (orderId) {
      await step(recorder, 'DELETE /sim/orders/:id', {
        url: `${apiBase}/sim/orders/${orderId}`,
        method: 'DELETE',
        headers: auth,
      });
    }
    await think(20_000, 8_000);
  };
}

/**
 * A Sentinel observation — by a wide margin the most expensive request in the
 * product, and the one whose cost does not fall on Postgres.
 *
 * Kept at a low share of the population deliberately: Sentinel is a premium
 * capability behind an entitlement and a quota, so a mix in which every user
 * observes continuously would be a stress test of a scenario the product's own
 * billing prevents.
 */
export function sentinel({ apiBase, token, symbols = ['NIFTY', 'BANKNIFTY'] }) {
  const auth = { authorization: `Bearer ${token}` };
  let i = 0;
  return async ({ recorder }) => {
    const symbol = symbols[i++ % symbols.length];
    await step(recorder, 'POST /sentinel/observe', {
      url: `${apiBase}/sentinel/observe`,
      method: 'POST',
      headers: auth,
      body: { symbol },
      timeoutMs: 60_000,
    });
    await think(30_000, 10_000);
  };
}
