import { describe, expect, it } from 'vitest';
import {
  DEMO_PASSES,
  FREE_PAPER_ORDERS_PER_DAY,
  LEARNING_MONTHLY,
  SENTINEL_BASE_MONTHLY,
  SENTINEL_TERMS,
  WITHDRAWN_SENTINEL_MONTHS,
  inr,
  sentinelSaving,
} from '@tradew/types';

/**
 * Active pricing, pinned.
 *
 * Two different jobs here and both matter:
 *
 * 1. The prices are what the product says they are. A price that silently
 *    drifts is a billing incident with a UI in front of it.
 * 2. The withdrawn annual Sentinel term stays withdrawn. Removing a plan is
 *    easy; keeping it removed through six months of refactors is what needs a
 *    test. These assertions are written against the exported list rather than
 *    against a rendered screen, because the requirement is that no code path
 *    can produce an annual term — not merely that one screen doesn't show it.
 */

describe('Sentinel pricing', () => {
  it('offers exactly three terms', () => {
    expect(SENTINEL_TERMS).toHaveLength(3);
    expect(SENTINEL_TERMS.map((t) => t.months)).toEqual([1, 3, 6]);
  });

  it('is ₹2,399 for one month', () => {
    const t = SENTINEL_TERMS.find((x) => x.months === 1)!;
    expect(t.monthly).toBe(2399);
    expect(t.total).toBe(2399);
  });

  it('is ₹2,199 a month on the three-month term', () => {
    const t = SENTINEL_TERMS.find((x) => x.months === 3)!;
    expect(t.monthly).toBe(2199);
    expect(t.total).toBe(6597);
  });

  it('is ₹1,999 a month on the six-month term', () => {
    const t = SENTINEL_TERMS.find((x) => x.months === 6)!;
    expect(t.monthly).toBe(1999);
    expect(t.total).toBe(11994);
  });

  it('derives total from monthly × months, so the two cannot disagree', () => {
    for (const t of SENTINEL_TERMS) expect(t.total).toBe(t.monthly * t.months);
  });

  it('gets cheaper per month as the term lengthens', () => {
    const monthly = SENTINEL_TERMS.map((t) => t.monthly);
    expect([...monthly].sort((a, b) => b - a)).toEqual(monthly);
  });

  it('computes the saving against the one-month rate', () => {
    expect(SENTINEL_BASE_MONTHLY).toBe(2399);
    expect(sentinelSaving(SENTINEL_TERMS.find((t) => t.months === 1)!)).toBe(0);
    expect(sentinelSaving(SENTINEL_TERMS.find((t) => t.months === 3)!)).toBe(600);
    expect(sentinelSaving(SENTINEL_TERMS.find((t) => t.months === 6)!)).toBe(2400);
  });
});

describe('the annual Sentinel plan does not exist', () => {
  it.each(WITHDRAWN_SENTINEL_MONTHS)('has no %i-month term', (months) => {
    expect(SENTINEL_TERMS.some((t) => t.months === months)).toBe(false);
  });

  it('has no term longer than six months', () => {
    expect(Math.max(...SENTINEL_TERMS.map((t) => t.months))).toBe(6);
  });

  it('carries none of the withdrawn ladder prices', () => {
    // The old ladder: 1399 / 1299 / 1199 / 1099 / 999.
    const withdrawnPrices = [1399, 1299, 1199, 1099, 999];
    for (const p of withdrawnPrices) {
      expect(SENTINEL_TERMS.some((t) => t.monthly === p)).toBe(false);
    }
  });

  it('exposes no id that could be used to request an annual term', () => {
    for (const t of SENTINEL_TERMS) {
      expect(t.id).not.toMatch(/12m|9m|annual|year/i);
    }
  });
});

describe('Learning pricing', () => {
  it('is ₹299 a month', () => {
    expect(LEARNING_MONTHLY).toBe(299);
  });
});

describe('unchanged tiers', () => {
  it('keeps the demo passes at ₹99 and ₹199', () => {
    expect(DEMO_PASSES.map((d) => d.price)).toEqual([99, 199]);
  });

  it('keeps the free allowance at two paper orders a day', () => {
    expect(FREE_PAPER_ORDERS_PER_DAY).toBe(2);
  });
});

describe('inr formatting', () => {
  it('groups the Indian way', () => {
    expect(inr(11994)).toBe('₹11,994');
    expect(inr(2399)).toBe('₹2,399');
    expect(inr(0)).toBe('₹0');
  });
});
