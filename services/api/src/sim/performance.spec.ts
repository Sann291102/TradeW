import { describe, expect, it } from 'vitest';
import { pctReturn } from './performance.service';

describe('pctReturn', () => {
  it('computes a positive return', () => {
    expect(pctReturn(100, 110)).toBe(10);
  });

  it('computes a negative return', () => {
    expect(pctReturn(100, 90)).toBe(-10);
  });

  it('returns 0 rather than dividing by zero when from is 0', () => {
    // A brand-new account's "opening value" can legitimately be 0 before its
    // first trade — this must never throw or return Infinity/NaN.
    expect(pctReturn(0, 500)).toBe(0);
    expect(pctReturn(0, 0)).toBe(0);
  });

  it('returns 0 for no change', () => {
    expect(pctReturn(1000, 1000)).toBe(0);
  });

  it('rounds to 2 decimal places', () => {
    expect(pctReturn(3, 10)).toBeCloseTo(233.33, 2);
  });
});
