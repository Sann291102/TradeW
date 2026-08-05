import { describe, expect, it } from 'vitest';
import { mergePositionForConversion } from './position.service';

/**
 * Position Management's "Convert product type" merge math. Pure and
 * dependency-free by design, same reasoning as applyFill/mergeHoldingLot.
 */
describe('mergePositionForConversion — no existing target', () => {
  it('carries the source over unchanged', () => {
    expect(mergePositionForConversion(10, 100, 0, 0)).toEqual({ quantity: 10, avgPrice: 100, conflict: false });
  });

  it('carries a short source over unchanged', () => {
    expect(mergePositionForConversion(-10, 100, 0, 0)).toEqual({ quantity: -10, avgPrice: 100, conflict: false });
  });
});

describe('mergePositionForConversion — same-direction target merges', () => {
  it('averages two longs', () => {
    // (10x100 + 10x120) / 20 = 110
    expect(mergePositionForConversion(10, 120, 10, 100)).toEqual({ quantity: 20, avgPrice: 110, conflict: false });
  });

  it('averages two shorts using absolute sizes', () => {
    // (10x100 + 10x120) / 20 = 110 — cost basis stays positive for a short.
    expect(mergePositionForConversion(-10, 120, -10, 100)).toEqual({ quantity: -20, avgPrice: 110, conflict: false });
  });
});

describe('mergePositionForConversion — opposite-direction target is a conflict, never netted', () => {
  it('flags a long source converting into an existing short target', () => {
    const result = mergePositionForConversion(10, 100, -5, 90);
    expect(result.conflict).toBe(true);
    // Reports the target's own state — nothing was changed, this is a refusal.
    expect(result).toEqual({ quantity: -5, avgPrice: 90, conflict: true });
  });

  it('flags a short source converting into an existing long target', () => {
    const result = mergePositionForConversion(-10, 100, 5, 90);
    expect(result.conflict).toBe(true);
  });
});
