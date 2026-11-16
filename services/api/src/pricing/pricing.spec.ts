import { afterEach, describe, expect, it } from 'vitest';
import { PricingController } from './pricing.controller';
import { StripeGateway } from '../billing/stripe.gateway';

/**
 * The server's view of pricing.
 *
 * The client-side pinning lives in `apps/web/src/lib/pricing.test.ts`; this
 * asserts the same properties across the API boundary, because the product
 * requirement is that *no route* can hand a caller an annual Sentinel term.
 *
 * Amounts are US cents (Stripe billing, 2026-11-16).
 */

const STRIPE_ENV = ['STRIPE_MODE', 'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'] as const;
const saved = Object.fromEntries(STRIPE_ENV.map((k) => [k, process.env[k]]));

/** `StripeGateway` reads its configuration once, at construction. */
function controllerWithBilling(enabled: boolean): PricingController {
  delete process.env.STRIPE_MODE;
  if (enabled) {
    // Syntactically valid test-mode keys; nothing here calls Stripe.
    process.env.STRIPE_SECRET_KEY = 'sk_test_pricing_spec';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_pricing_spec';
  } else {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PUBLISHABLE_KEY;
  }
  return new PricingController(new StripeGateway());
}

afterEach(() => {
  for (const k of STRIPE_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('GET /pricing', () => {
  const body = controllerWithBilling(false).get();

  it('serves exactly the three active Sentinel terms, in USD cents', () => {
    expect(body.currency).toBe('USD');
    expect(body.sentinel).toHaveLength(3);
    expect(body.sentinel.map((t) => t.months)).toEqual([1, 3, 6]);
    expect(body.sentinel.map((t) => t.monthly)).toEqual([4900, 4499, 4099]);
  });

  it('never returns an annual or nine-month term', () => {
    for (const t of body.sentinel) {
      expect(t.months).toBeLessThanOrEqual(6);
      expect(t.id).not.toMatch(/9m|12m|annual|year/i);
    }
  });

  it('returns totals that match monthly × months', () => {
    for (const t of body.sentinel) expect(t.total).toBe(t.monthly * t.months);
  });

  it('includes the saving so a client cannot compute it wrongly', () => {
    const six = body.sentinel.find((t) => t.months === 6)!;
    expect(six.saving).toBe((4900 - 4099) * 6);
  });

  it('prices Learning at $4.99 a month', () => {
    expect(body.learning.monthly).toBe(499);
  });

  it('states plainly that billing is off, in the payload not just the UI', () => {
    expect(body.billingEnabled).toBe(false);
    expect(body.notice).toMatch(/not enabled/i);
  });

  it('leaks no entitlement or user state — it is the same list for everyone', () => {
    const json = JSON.stringify(body);
    expect(json).not.toMatch(/userId|capabilit|entitle|token|email/i);
  });
});

describe('GET /pricing — billing state tracks the server, not a constant', () => {
  it('reports billing ON once Stripe is configured with matching test keys', () => {
    expect(controllerWithBilling(true).get().billingEnabled).toBe(true);
  });

  it('drops the "not enabled" notice once billing is on', () => {
    expect(controllerWithBilling(true).get().notice).toBeUndefined();
  });

  it('reports billing OFF with no credentials, and says why', () => {
    const off = controllerWithBilling(false).get();
    expect(off.billingEnabled).toBe(false);
    expect(off.notice).toMatch(/not enabled/i);
  });

  it('reports billing OFF when a live key is set on a test-mode server', () => {
    delete process.env.STRIPE_MODE;
    process.env.STRIPE_SECRET_KEY = 'sk_live_wrong_mode';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_live_wrong_mode';
    expect(new PricingController(new StripeGateway()).get().billingEnabled).toBe(false);
  });
});
