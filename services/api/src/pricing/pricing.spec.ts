import { describe, expect, it } from 'vitest';
import { PricingController } from './pricing.controller';

/**
 * The server's view of pricing.
 *
 * The client-side pinning lives in `apps/web/src/lib/pricing.test.ts`; this
 * asserts the same properties across the API boundary, because the product
 * requirement is that *no route* can hand a caller an annual Sentinel term.
 * A frontend that no longer renders one is not the same thing as an endpoint
 * that can no longer produce one, and the spec asked for the latter.
 */
describe('GET /pricing', () => {
  const body = new PricingController().get();

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
