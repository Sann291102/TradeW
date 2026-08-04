import { describe, expect, it } from 'vitest';
import { applyFill } from './order.service';

/**
 * Position averaging and realized P&L — the money arithmetic.
 *
 * `applyFill` is the single function in the platform that decides what a fill
 * does to a position: whether it opens, averages, closes part, closes flat, or
 * closes and flips direction, and how much P&L that fill locked in. Its output
 * feeds three things that are hard to unwind once wrong — `Position.avgPrice`,
 * the wallet cash movement (`marginDelta + charges - realizedPnlDelta`), and
 * the discipline loss-limit tripwire that decides whether a trader is allowed
 * to keep trading today.
 *
 * Pure and dependency-free by design, like `discipline-limits.spec.ts`: no
 * database, no Nest context, no clock. Every case below is stated as
 * (existing position) + (fill) => (new position, realized P&L) so the expected
 * numbers can be checked by hand against the formula.
 *
 * Sign convention under test: quantity is positive for long and negative for
 * short; `avgPrice` is always a positive price, never signed.
 */

/** Reads as the domain does: "10 @ 100, then SELL 4 @ 120". */
const fill = (
  qty: number,
  avg: number,
  side: 'BUY' | 'SELL',
  fillQty: number,
  fillPrice: number,
) => applyFill(qty, avg, side, fillQty, fillPrice);

describe('applyFill — opening a position from flat', () => {
  it('BUY from flat opens a long at the fill price, realizing nothing', () => {
    expect(fill(0, 0, 'BUY', 10, 100)).toEqual({
      newQuantity: 10,
      newAvgPrice: 100,
      realizedPnlDelta: 0,
    });
  });

  it('SELL from flat opens a short at the fill price, realizing nothing', () => {
    expect(fill(0, 0, 'SELL', 10, 100)).toEqual({
      newQuantity: -10,
      newAvgPrice: 100,
      realizedPnlDelta: 0,
    });
  });

  it('ignores any stale avgPrice left on a flat position', () => {
    // A closed position keeps its last avgPrice (see the flat-close case
    // below), so opening again must not average against that ghost.
    expect(fill(0, 999, 'BUY', 5, 50).newAvgPrice).toBe(50);
  });
});

describe('applyFill — adding to an existing position', () => {
  it('averages up when buying more of a long', () => {
    // (10x100 + 10x120) / 20 = 110
    expect(fill(10, 100, 'BUY', 10, 120)).toEqual({
      newQuantity: 20,
      newAvgPrice: 110,
      realizedPnlDelta: 0,
    });
  });

  it('averages down when buying more of a long at a lower price', () => {
    // (10x100 + 30x80) / 40 = 85
    expect(fill(10, 100, 'BUY', 30, 80)).toEqual({
      newQuantity: 40,
      newAvgPrice: 85,
      realizedPnlDelta: 0,
    });
  });

  it('averages a short using absolute sizes, keeping avgPrice positive', () => {
    // (10x100 + 10x120) / 20 = 110 — the short's cost basis, not -110.
    expect(fill(-10, 100, 'SELL', 10, 120)).toEqual({
      newQuantity: -20,
      newAvgPrice: 110,
      realizedPnlDelta: 0,
    });
  });

  it('never realizes P&L on a fill that only increases exposure', () => {
    expect(fill(10, 100, 'BUY', 1, 1_000).realizedPnlDelta).toBe(0);
    expect(fill(-10, 100, 'SELL', 1, 1).realizedPnlDelta).toBe(0);
  });
});

describe('applyFill — partial close keeps the remainder at its original cost', () => {
  it('long closed partially in profit', () => {
    // 4 x (120 - 100) x +1 = +80; the remaining 6 stay at 100, not 120.
    expect(fill(10, 100, 'SELL', 4, 120)).toEqual({
      newQuantity: 6,
      newAvgPrice: 100,
      realizedPnlDelta: 80,
    });
  });

  it('long closed partially at a loss', () => {
    // 4 x (90 - 100) x +1 = -40
    expect(fill(10, 100, 'SELL', 4, 90)).toEqual({
      newQuantity: 6,
      newAvgPrice: 100,
      realizedPnlDelta: -40,
    });
  });

  it('short closed partially in profit — a short profits when price falls', () => {
    // 4 x (90 - 100) x -1 = +40
    expect(fill(-10, 100, 'BUY', 4, 90)).toEqual({
      newQuantity: -6,
      newAvgPrice: 100,
      realizedPnlDelta: 40,
    });
  });

  it('short closed partially at a loss — a short loses when price rises', () => {
    // Sold at 100, bought back 20 higher: 4 x (120 - 100) x -1 = -80.
    expect(fill(-10, 100, 'BUY', 4, 120)).toEqual({
      newQuantity: -6,
      newAvgPrice: 100,
      realizedPnlDelta: -80,
    });
  });

  it('is symmetric — equal moves for and against a short cost the same', () => {
    const gain = fill(-10, 100, 'BUY', 4, 90).realizedPnlDelta;
    const loss = fill(-10, 100, 'BUY', 4, 110).realizedPnlDelta;
    expect(gain).toBe(40);
    expect(loss).toBe(-40);
  });
});

describe('applyFill — closing flat', () => {
  it('long closed exactly flat realizes the whole move', () => {
    // 10 x (120 - 100) x +1 = +200
    expect(fill(10, 100, 'SELL', 10, 120)).toEqual({
      newQuantity: 0,
      newAvgPrice: 100,
      realizedPnlDelta: 200,
    });
  });

  it('short closed exactly flat realizes the whole move', () => {
    // 10 x (90 - 100) x -1 = +100
    expect(fill(-10, 100, 'BUY', 10, 90)).toEqual({
      newQuantity: 0,
      newAvgPrice: 100,
      realizedPnlDelta: 100,
    });
  });

  it('retains the entry price on a flat position rather than zeroing it', () => {
    // Deliberate: a zero avgPrice would render as "avg 0.00" in the blotter
    // and would corrupt any P&L recomputed from a flat row. Pinned so the
    // choice cannot be reverted silently.
    expect(fill(10, 100, 'SELL', 10, 120).newAvgPrice).toBe(100);
  });
});

describe('applyFill — close and flip through zero', () => {
  it('long flipping short realizes only the closed leg and rebases the rest', () => {
    // Close 10 @ 120 => 10 x (120-100) x +1 = +200 realized.
    // The 5 that remain are a NEW short opened at 120, not at 100.
    expect(fill(10, 100, 'SELL', 15, 120)).toEqual({
      newQuantity: -5,
      newAvgPrice: 120,
      realizedPnlDelta: 200,
    });
  });

  it('short flipping long realizes only the closed leg and rebases the rest', () => {
    // Close 10 @ 90 => 10 x (90-100) x -1 = +100 realized; 5 long @ 90.
    expect(fill(-10, 100, 'BUY', 15, 90)).toEqual({
      newQuantity: 5,
      newAvgPrice: 90,
      realizedPnlDelta: 100,
    });
  });

  it('does not realize P&L on the newly opened leg of a flip', () => {
    // The flip above realizes 200 for the 10 closed. Were the residual 5
    // wrongly included, the figure would be 300.
    expect(fill(10, 100, 'SELL', 15, 120).realizedPnlDelta).toBe(200);
  });
});

describe('applyFill — invariants across sequences', () => {
  it('conserves quantity across an arbitrary sequence of fills', () => {
    const fills: Array<['BUY' | 'SELL', number, number]> = [
      ['BUY', 10, 100],
      ['BUY', 5, 110],
      ['SELL', 3, 130],
      ['SELL', 20, 90],
      ['BUY', 4, 95],
    ];
    let qty = 0;
    let avg = 0;
    let signedTotal = 0;
    for (const [side, q, p] of fills) {
      const r = applyFill(qty, avg, side, q, p);
      qty = r.newQuantity;
      avg = r.newAvgPrice;
      signedTotal += side === 'BUY' ? q : -q;
    }
    expect(qty).toBe(signedTotal);
  });

  it('a full round trip realizes exactly (exit - entry) x size for a long', () => {
    const open = applyFill(0, 0, 'BUY', 7, 250);
    const close = applyFill(open.newQuantity, open.newAvgPrice, 'SELL', 7, 262.5);
    expect(close.newQuantity).toBe(0);
    expect(close.realizedPnlDelta).toBeCloseTo((262.5 - 250) * 7, 10);
  });

  it('a full round trip realizes exactly (entry - exit) x size for a short', () => {
    const open = applyFill(0, 0, 'SELL', 7, 250);
    const close = applyFill(open.newQuantity, open.newAvgPrice, 'BUY', 7, 240);
    expect(close.newQuantity).toBe(0);
    expect(close.realizedPnlDelta).toBeCloseTo((250 - 240) * 7, 10);
  });

  it('scaling out in pieces realizes the same total as closing at once', () => {
    const atOnce = applyFill(12, 100, 'SELL', 12, 115).realizedPnlDelta;

    let qty = 12;
    let avg = 100;
    let sum = 0;
    for (const piece of [5, 4, 3]) {
      const r = applyFill(qty, avg, 'SELL', piece, 115);
      qty = r.newQuantity;
      avg = r.newAvgPrice;
      sum += r.realizedPnlDelta;
    }
    expect(qty).toBe(0);
    expect(sum).toBeCloseTo(atOnce, 10);
  });

  it('averaging then closing flat realizes against the blended cost, not the last price', () => {
    const a = applyFill(0, 0, 'BUY', 10, 100);
    const b = applyFill(a.newQuantity, a.newAvgPrice, 'BUY', 10, 200); // avg 150
    expect(b.newAvgPrice).toBe(150);
    const c = applyFill(b.newQuantity, b.newAvgPrice, 'SELL', 20, 150);
    expect(c.realizedPnlDelta).toBeCloseTo(0, 10); // sold at the blended cost
  });
});

describe('applyFill — fractional and large values', () => {
  it('handles fractional prices without drifting beyond float noise', () => {
    const r = applyFill(3, 100.05, 'SELL', 3, 100.1);
    expect(r.realizedPnlDelta).toBeCloseTo(0.15, 10);
  });

  it('averages fractional lots correctly', () => {
    // (2 x 10.5 + 3 x 20.5) / 5 = 16.5
    expect(applyFill(2, 10.5, 'BUY', 3, 20.5).newAvgPrice).toBeCloseTo(16.5, 10);
  });
});
