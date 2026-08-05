import { describe, expect, it } from 'vitest';
import { deriveEntryPrice } from './trade-history.service';
import { applyFill } from './order.service';

/**
 * The algebraic entry-price recovery that lets Trade History pair
 * entry/exit without simulating FIFO lots. Each case is cross-checked
 * against `applyFill` itself — the formula being inverted — so these tests
 * fail if the two ever drift apart.
 */
describe('deriveEntryPrice — ordinary closes (closedQuantity === trade quantity)', () => {
  it('recovers the entry price of a SELL that closes a long', () => {
    // 10 @ 100, sold 4 @ 120 => realizedPnl = 4*(120-100) = 80.
    const fill = applyFill(10, 100, 'SELL', 4, 120);
    expect(deriveEntryPrice('SELL', 120, 4, fill.realizedPnlDelta)).toBeCloseTo(100, 10);
  });

  it('recovers the entry price of a BUY that closes a short', () => {
    // -10 @ 100, bought back 4 @ 90 => realizedPnl = 4*(90-100)*(-1) = 40.
    const fill = applyFill(-10, 100, 'BUY', 4, 90);
    expect(deriveEntryPrice('BUY', 90, 4, fill.realizedPnlDelta)).toBeCloseTo(100, 10);
  });

  it('recovers the entry price of an exact full close', () => {
    const fill = applyFill(10, 100, 'SELL', 10, 120);
    expect(deriveEntryPrice('SELL', 120, 10, fill.realizedPnlDelta)).toBeCloseTo(100, 10);
  });

  it('recovers a loss the same way as a gain', () => {
    const fill = applyFill(10, 100, 'SELL', 4, 90);
    expect(deriveEntryPrice('SELL', 90, 4, fill.realizedPnlDelta)).toBeCloseTo(100, 10);
  });
});

describe('deriveEntryPrice — close-and-flip: closedQuantity must be the closing leg, not the full fill', () => {
  it('is exact when given closedQuantity, wrong when given the full fill quantity', () => {
    // Long 10 @ 100, SELL 15 @ 120 flips to short 5 @ 120. Only 10 closed —
    // applyFill.realizedPnlDelta is computed over that 10, not the full 15.
    const fill = applyFill(10, 100, 'SELL', 15, 120);
    expect(fill.newQuantity).toBe(-5); // confirms this really is a flip
    const closedQuantity = 10; // what Trade.closedQuantity would store

    // Correct: divide by the actual closing quantity.
    expect(deriveEntryPrice('SELL', 120, closedQuantity, fill.realizedPnlDelta)).toBeCloseTo(100, 10);

    // Demonstrates the bug this column exists to prevent: dividing by the
    // full 15-unit fill instead gives a wrong entry price.
    const wrongEntryPrice = deriveEntryPrice('SELL', 120, 15, fill.realizedPnlDelta);
    expect(wrongEntryPrice).not.toBeCloseTo(100, 10);
  });

  it('is exact for a short flipping long the same way', () => {
    // Short 10 @ 100, BUY 15 @ 90 flips to long 5 @ 90. Only 10 closed.
    const fill = applyFill(-10, 100, 'BUY', 15, 90);
    expect(fill.newQuantity).toBe(5);
    expect(deriveEntryPrice('BUY', 90, 10, fill.realizedPnlDelta)).toBeCloseTo(100, 10);
  });
});

describe('deriveEntryPrice — round trip with fractional prices', () => {
  it('recovers a fractional entry price without drifting beyond float noise', () => {
    const fill = applyFill(3, 100.05, 'SELL', 3, 100.1);
    expect(deriveEntryPrice('SELL', 100.1, 3, fill.realizedPnlDelta)).toBeCloseTo(100.05, 8);
  });
});
