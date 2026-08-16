import { afterEach, describe, expect, it } from 'vitest';
import { PricingController } from './pricing.controller';
import { RazorpayClient } from '../payments/razorpay.client';

/**
 * The server's view of pricing.
 *
 * The client-side pinning lives in `apps/web/src/lib/pricing.test.ts`; this
 * asserts the same properties across the API boundary, because the product
 * requirement is that *no route* can hand a caller an annual Sentinel term.
 * A frontend that no longer renders one is not the same thing as an endpoint
 * that can no longer produce one, and the spec asked for the latter.
 */

/**
 * `RazorpayClient` reads its credentials once, at construction, so a test
 * controls `configured` by setting the environment BEFORE building one.
 */
function controllerWithBilling(enabled: boolean): PricingController {
  if (enabled) {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_pricing_spec';
    process.env.RAZORPAY_KEY_SECRET = 'secret_pricing_spec';
  } else {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  }
  return new PricingController(new RazorpayClient());
}

describe('GET /pricing', () => {
  const body = controllerWithBilling(false).get();

  it('serves exactly the three active Sentinel terms', () => {
    expect(body.sentinel).toHaveLength(3);
    expect(body.sentinel.map((t) => t.months)).toEqual([1, 3, 6]);
    expect(body.sentinel.map((t) => t.monthly)).toEqual([2399, 2199, 1999]);
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
    expect(six.saving).toBe(2400);
  });

  it('prices Learning at ₹299 a month', () => {
    expect(body.learning.monthly).toBe(299);
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

/**
 * `billingEnabled` used to be the constant `false`, which meant this route kept
 * telling signed-out visitors that no account could be charged on a server that
 * had Razorpay credentials and was charging them. These tests exist so that the
 * payload cannot drift from the server's real state again — the earlier suite
 * above passes just as happily against a hardcoded `false`, so it could never
 * have caught it.
 */
describe('GET /pricing — billing state tracks the server, not a constant', () => {
  const savedId = process.env.RAZORPAY_KEY_ID;
  const savedSecret = process.env.RAZORPAY_KEY_SECRET;

  afterEach(() => {
    // Restore, rather than delete: this process's env is shared with every
    // other spec in the run.
    if (savedId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = savedId;
    if (savedSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = savedSecret;
  });

  it('reports billing ON once Razorpay is configured', () => {
    expect(controllerWithBilling(true).get().billingEnabled).toBe(true);
  });

  it('drops the "not enabled" notice once billing is on, rather than contradicting itself', () => {
    expect(controllerWithBilling(true).get().notice).toBeUndefined();
  });

  it('reports billing OFF with no credentials, and says why', () => {
    const off = controllerWithBilling(false).get();
    expect(off.billingEnabled).toBe(false);
    expect(off.notice).toMatch(/not enabled/i);
  });

  it('agrees with the payments surface, which reads the same RazorpayClient', () => {
    // The defect was these two disagreeing. Assert the shared source directly:
    // whatever `RazorpayClient.configured` says is what /pricing must publish.
    process.env.RAZORPAY_KEY_ID = 'rzp_test_agreement';
    process.env.RAZORPAY_KEY_SECRET = 'secret_agreement';
    const razorpay = new RazorpayClient();
    expect(new PricingController(razorpay).get().billingEnabled).toBe(razorpay.configured);
  });
});
