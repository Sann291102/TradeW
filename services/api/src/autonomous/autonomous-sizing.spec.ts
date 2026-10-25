import { describe, expect, it } from 'vitest';
import { sizeFromRisk, type SizingInput } from './autonomous-sizing';

/** A NIFTY option: premium 150, stop 120, lot 65, ₹5,00,000 account. */
const base: SizingInput = {
  walletEquity: 500_000,
  riskPerTradePct: 3,
  capitalAllocationPct: 20,
  entryPrice: 150,
  stopPrice: 120,
  lotSize: 65,
  maxLots: 10,
};

describe('sizing comes from the STOP DISTANCE', () => {
  it('derives quantity from risk budget ÷ (stop distance × lot size)', () => {
    const out = sizeFromRisk(base);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // 3% of 500,000 = 15,000 of allowed risk.
    // One lot risks (150 − 120) × 65 = 1,950.
    // 15,000 / 1,950 = 7.69 → 7 lots.
    expect(out.riskBudget).toBe(15_000);
    expect(out.stopDistance).toBe(30);
    expect(out.riskPerLot).toBe(1_950);
    expect(out.lots).toBe(7);
    expect(out.quantity).toBe(7 * 65);
  });

  it('sizes LARGER when the stop is tighter, for the same budget', () => {
    // The property that distinguishes this from `planRisk`, which risks the
    // whole premium and would return the same size for both.
    const tight = sizeFromRisk({ ...base, stopPrice: 135 });
    const wide = sizeFromRisk({ ...base, stopPrice: 100 });
    expect(tight.ok && wide.ok).toBe(true);
    if (!tight.ok || !wide.ok) return;
    expect(tight.lots).toBeGreaterThan(wide.lots);
  });

  it('shows its work, so a quantity can always be audited', () => {
    const out = sizeFromRisk(base);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const ids = out.steps.map((s) => s.id);
    expect(ids).toContain('stop-distance');
    expect(ids).toContain('risk-budget');
    expect(ids).toContain('risk-per-lot');
    expect(ids).toContain('allocation-cap');
    expect(ids).toContain('quantity');
  });
});

describe('the caps', () => {
  it('is capped by the capital allocation, not only by risk', () => {
    // Risk and cost are different limits: a tight stop can pass the risk
    // budget while the position still ties up more capital than allowed.
    const out = sizeFromRisk({ ...base, stopPrice: 149, capitalAllocationPct: 5 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 5% of 500,000 = 25,000; one lot costs 150 × 65 = 9,750 → 2 lots.
    expect(out.lots).toBe(2);
  });

  it('is capped by the profile lot ceiling', () => {
    const out = sizeFromRisk({ ...base, stopPrice: 149, maxLots: 1 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lots).toBe(1);
  });

  it('records what risk alone would have bought, before the caps', () => {
    const out = sizeFromRisk({ ...base, stopPrice: 149, maxLots: 1 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.calculatedQuantity).toBeGreaterThan(out.quantity);
  });
});

describe('it refuses rather than bending the plan', () => {
  it('refuses when one lot risks more than the budget allows', () => {
    // The tempting alternative is to tighten the stop until it fits. That
    // would be inventing an invalidation the setup never claimed.
    const out = sizeFromRisk({ ...base, walletEquity: 20_000 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('risk-budget-below-one-lot');
    expect(out.detail).toContain('rather than tightening the stop');
  });

  it('refuses when one lot costs more than the allocation', () => {
    const out = sizeFromRisk({ ...base, capitalAllocationPct: 1 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('allocation-below-one-lot');
  });

  it('refuses a zero stop distance rather than dividing by it', () => {
    // This would otherwise produce an unbounded position.
    const out = sizeFromRisk({ ...base, stopPrice: base.entryPrice });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('no-stop-distance');
  });

  it('refuses an empty account, a bad lot size and a non-positive entry', () => {
    expect(sizeFromRisk({ ...base, walletEquity: 0 }).ok).toBe(false);
    expect(sizeFromRisk({ ...base, lotSize: 0 }).ok).toBe(false);
    expect(sizeFromRisk({ ...base, lotSize: 2.5 }).ok).toBe(false);
    expect(sizeFromRisk({ ...base, entryPrice: 0 }).ok).toBe(false);
  });

  it('never returns a fractional or non-lot-aligned quantity', () => {
    for (const equity of [50_000, 123_456, 500_000, 2_500_000]) {
      const out = sizeFromRisk({ ...base, walletEquity: equity });
      if (out.ok) {
        expect(Number.isInteger(out.lots)).toBe(true);
        expect(out.quantity % base.lotSize).toBe(0);
        // And it never exceeds the risk budget it was given.
        expect(out.stopDistance * out.quantity).toBeLessThanOrEqual(out.riskBudget);
      }
    }
  });
});
