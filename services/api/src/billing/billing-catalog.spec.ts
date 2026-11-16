import { describe, expect, it } from 'vitest';
import { LEARNING_MONTHLY, LEARNING_MONTHLY_INR } from '@tradew/types';
import { BILLING_ITEMS, LEARNING_ITEM, TRIAL_ITEM, billingItem, chargeFor } from './billing.catalog';

describe('billing catalog', () => {
  it('sells Learning at $4.99, or ₹499 to an Indian billing address', () => {
    expect(LEARNING_MONTHLY).toBe(499);
    expect(LEARNING_MONTHLY_INR).toBe(49900);
    expect(chargeFor(LEARNING_ITEM, 'US')).toEqual({ currency: 'usd', amountMinor: 499 });
    expect(chargeFor(LEARNING_ITEM, 'IN')).toEqual({ currency: 'inr', amountMinor: 49900 });
    expect(chargeFor(LEARNING_ITEM, 'in')).toEqual({ currency: 'inr', amountMinor: 49900 });
    expect(chargeFor(LEARNING_ITEM, null)).toEqual({ currency: 'usd', amountMinor: 499 });
  });

  it('charges Sentinel and the pass in USD everywhere', () => {
    for (const id of ['sentinel_1m', 'sentinel_3m', 'sentinel_6m', TRIAL_ITEM.id]) {
      expect(chargeFor(billingItem(id)!, 'IN').currency).toBe('usd');
    }
  });

  it('prices Sentinel terms as monthly × months, renewing every 1, 3 or 6 months', () => {
    const terms = BILLING_ITEMS.filter((i) => i.product === 'sentinel_pro' && i.kind === 'recurring');
    expect(terms.map((t) => [t.intervalCount, t.amountMinor])).toEqual([
      [1, 4900],
      [3, 4499 * 3],
      [6, 4099 * 6],
    ]);
  });

  it('keeps the 7-day pass one-time and derived from the $49 month', () => {
    expect(TRIAL_ITEM.kind).toBe('one_time');
    expect(TRIAL_ITEM.amountMinor).toBe(560);
    expect(TRIAL_ITEM.days).toBe(7);
  });

  it('gives every recurring item a unique lookup key', () => {
    const keys = BILLING_ITEMS.filter((i) => i.kind === 'recurring').map((i) => i.lookupKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
