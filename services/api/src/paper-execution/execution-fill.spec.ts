import { describe, expect, it } from 'vitest';
import { modelPaperFill, reconcileFill, type FillModelInput } from './execution-fill';

/**
 * A paper fill with a stated model.
 *
 * The load-bearing assertion here is the synthetic-spread detection. When a
 * Dhan quote-mode tick carries no depth, `MarketPriceService` substitutes
 * `ltp × 0.9995 / 1.0005`, and a P&L measured against that invented 10bp
 * spread is systematically better than the same trade against a real option
 * book. A journal that cannot tell the two apart overstates the strategy.
 */

const BASE: FillModelInput = {
  side: 'BUY',
  ltp: 120,
  bid: 119.5,
  ask: 120.6,
  quantity: 75,
  quoteAgeMs: 800,
  marketOpen: true,
  orderType: 'MARKET',
};

describe('modelPaperFill', () => {
  it('fills a BUY at the ask and a SELL at the bid — it crosses, never mids', () => {
    expect(modelPaperFill(BASE).fillPrice).toBe(120.6);
    expect(modelPaperFill({ ...BASE, side: 'SELL' }).fillPrice).toBe(119.5);
  });

  it('records the spread and the slippage crossing it costs', () => {
    const model = modelPaperFill(BASE);
    expect(model.spread).toBeCloseTo(1.1, 4);
    expect(model.slippage).toBeCloseTo(0.6, 4);
    expect(model.slippagePct).toBeCloseTo(0.5, 3);
    expect(model.notional).toBe(9045);
  });

  it('reports a real book spread as quoted', () => {
    const model = modelPaperFill(BASE);
    expect(model.spreadSource).toBe('quoted');
    expect(model.assumptions.join(' ')).toContain('published book');
  });

  it('DETECTS the synthetic spread the price service fabricates', () => {
    // Exactly what `getOptionPrice` substitutes when leg.bid/leg.ask are 0.
    const ltp = 120;
    const model = modelPaperFill({ ...BASE, ltp, bid: ltp * 0.9995, ask: ltp * 1.0005 });
    expect(model.spreadSource).toBe('synthetic-from-ltp');
    const text = model.assumptions.join(' ');
    expect(text).toContain('SYNTHETIC');
    // And it says so in the direction that matters: the modelled cost is a
    // FLOOR, so the recorded P&L is optimistic rather than conservative.
    expect(text).toContain('FLOOR');
  });

  it('detects the synthetic spread across the whole premium range', () => {
    for (const ltp of [5.5, 18.25, 120, 640.75, 990]) {
      const model = modelPaperFill({ ...BASE, ltp, bid: ltp * 0.9995, ask: ltp * 1.0005 });
      expect(model.spreadSource, `ltp ${ltp}`).toBe('synthetic-from-ltp');
    }
  });

  it('always states what it does NOT model', () => {
    const text = modelPaperFill(BASE).assumptions.join(' ');
    expect(text).toContain('no partial fills');
    expect(text).toContain('No market impact');
    expect(text).toContain('No latency');
  });

  it('records that the session was closed, when it was', () => {
    const model = modelPaperFill({ ...BASE, marketOpen: false });
    expect(model.assumptions.join(' ')).toContain('NOT open');
  });

  it('says so when feed age could not be measured, rather than implying freshness', () => {
    const model = modelPaperFill({ ...BASE, quoteAgeMs: null });
    expect(model.assumptions.join(' ')).toContain('could not be measured');
  });

  it('does not divide by zero on a zero LTP', () => {
    const model = modelPaperFill({ ...BASE, ltp: 0, bid: 0, ask: 0 });
    expect(Number.isFinite(model.spreadPct)).toBe(true);
    expect(Number.isFinite(model.slippagePct)).toBe(true);
  });
});

describe('reconcileFill', () => {
  it('confirms agreement when the OMS filled where the model said', () => {
    const model = modelPaperFill(BASE);
    const check = reconcileFill(model, 120.6);
    expect(check.matchesOms).toBe(true);
    expect(check.difference).toBe(0);
  });

  it('reports a drift rather than hiding it', () => {
    const model = modelPaperFill(BASE);
    const check = reconcileFill(model, 121.4);
    expect(check.matchesOms).toBe(false);
    expect(check.difference).toBeCloseTo(0.8, 4);
    expect(check.note).toContain('above');
  });

  it('handles an order that has not filled yet', () => {
    const model = modelPaperFill(BASE);
    const check = reconcileFill(model, null);
    expect(check.matchesOms).toBe(false);
    expect(check.actualFillPrice).toBeNull();
    expect(check.note).toContain('did not fill');
  });
});
