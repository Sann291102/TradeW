import { describe, expect, it } from 'vitest';
import { mergeHoldingLot } from './settlement.service';

/**
 * The settlement transfer's only real arithmetic: merging a newly-settled
 * CNC lot into whatever Holding already exists for that instrument. Pure and
 * dependency-free by design, same reasoning as order-fill.spec.ts.
 */
describe('mergeHoldingLot — first settlement (no existing holding)', () => {
  it('opens the holding at the settled lot\'s own cost', () => {
    expect(mergeHoldingLot(0, 0, 10, 100)).toEqual({ newQuantity: 10, newAvgCost: 100 });
  });

  it('ignores a stale existingAvgCost when existingQty is 0', () => {
    // Mirrors applyFill's "ignores any stale avgPrice left on a flat
    // position" — a fully-sold-out holding row (if one ever exists) must not
    // taint a fresh settlement.
    expect(mergeHoldingLot(0, 999, 5, 50).newAvgCost).toBe(50);
  });
});

describe('mergeHoldingLot — merging into an existing holding', () => {
  it('averages up when the new lot cost more', () => {
    // (10x100 + 10x120) / 20 = 110
    expect(mergeHoldingLot(10, 100, 10, 120)).toEqual({ newQuantity: 20, newAvgCost: 110 });
  });

  it('averages down when the new lot cost less', () => {
    // (10x100 + 30x80) / 40 = 85
    expect(mergeHoldingLot(10, 100, 30, 80)).toEqual({ newQuantity: 40, newAvgCost: 85 });
  });

  it('is unchanged when the new lot costs exactly the existing average', () => {
    expect(mergeHoldingLot(10, 100, 5, 100)).toEqual({ newQuantity: 15, newAvgCost: 100 });
  });

  it('conserves quantity across a sequence of settlements', () => {
    let qty = 0;
    let avg = 0;
    for (const [lotQty, lotCost] of [[10, 100], [5, 110], [20, 90], [4, 95]] as const) {
      const r = mergeHoldingLot(qty, avg, lotQty, lotCost);
      qty = r.newQuantity;
      avg = r.newAvgCost;
    }
    expect(qty).toBe(39);
  });

  it('handles fractional prices without drifting beyond float noise', () => {
    const r = mergeHoldingLot(2, 10.5, 3, 20.5);
    expect(r.newAvgCost).toBeCloseTo(16.5, 10);
  });
});
