/**
 * Market isolation and adapter materialisation.
 *
 * The requirement under test, stated as the brief states it:
 *
 *   > A BTC experiment must NEVER accidentally place an Indian-market order or
 *   > share an incompatible position/account state.
 *
 * Before the adapter port, that held only because one implementation existed —
 * `PaperExecutionService` could only build option contracts, so it could only
 * produce NSE orders. Safe by accident of arity, and it stops being safe at
 * two implementations. These assertions are what replaces that accident.
 *
 * Every case here is a SILENT failure without the check: a mislabelled profile
 * row that places a real order on the wrong exchange, an agent sized to zero
 * lots that looks like an agent finding no setup, or a bearish crypto signal
 * quietly discarded so the win rate is computed on a filtered sample.
 */

import { describe, expect, it } from 'vitest';
import { tradableSpec } from '@tradew/market-data';
import { resolveAdapter, type ExecutionAdapter } from './execution-adapter';
import { SpotExecutionAdapter } from './spot-adapter';
import { FuturesExecutionAdapter } from './futures-adapter';
import type { StrategySignal } from './strategy-signal';

const ADAPTERS: readonly ExecutionAdapter[] = [
  new SpotExecutionAdapter(),
  new FuturesExecutionAdapter(),
];

function signal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  return {
    symbol: 'BTCUSDT',
    market: 'CRYPTO',
    executionStyle: 'spot',
    bias: 'bullish',
    confidence: 82,
    strategyId: 'orb-breakout',
    strategyName: 'Opening Range Breakout',
    strategyVersion: 'v3',
    regime: 'trending',
    referencePrice: 60_000,
    entryReference: null,
    stopLoss: null,
    target: null,
    signalBarAt: new Date('2026-09-07T10:00:00Z'),
    evidence: [],
    rationale: [],
    decidedAt: new Date('2026-09-07T10:00:00Z'),
    ...overrides,
  };
}

const CONTEXT = {
  profileId: 'p1',
  accountUserId: 'u1',
  declaredVenue: 'BINANCE' as const,
  availableCapital: 10_000,
  capitalAllocationPct: 20,
  riskPerTradePct: 3,
  rewardPerTradePct: 9,
};

describe('market isolation', () => {
  it('refuses a BTC profile that claims an Indian venue', async () => {
    // THE HEADLINE CASE. A profile row edited to say NSE while trading BTCUSDT
    // must not reach ANY adapter — least of all the Indian one.
    const result = resolveAdapter('BTCUSDT', 'NSE', ADAPTERS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.checkId).toBe('venue-mismatch');
      expect(result.refusal.reason).toContain('BINANCE');
    }
  });

  it('refuses an Indian symbol claimed for Binance', async () => {
    const result = resolveAdapter('NIFTY', 'BINANCE', ADAPTERS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.checkId).toBe('venue-mismatch');
  });

  it('refuses an unknown symbol rather than defaulting to the Indian path', async () => {
    // Defaulting an unrecognised symbol to Dhan/NSE is exactly how a crypto
    // agent would place an equity order.
    const result = resolveAdapter('DOGECOIN-PERP', 'BINANCE', ADAPTERS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.checkId).toBe('symbol-unknown');
  });

  it('refuses a registered-but-not-tradable instrument', async () => {
    // GOLDM is in the registry (so it can be named and charted) but has no feed
    // subscription, so no order may be built for it.
    expect(tradableSpec('GOLDM')?.tradeable).toBe(false);
    const result = resolveAdapter('GOLDM', 'MCX', ADAPTERS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.checkId).toBe('symbol-not-tradable');
  });

  it('routes each tradable symbol to exactly one adapter', async () => {
    const btc = resolveAdapter('BTCUSDT', 'BINANCE', ADAPTERS);
    expect(btc.ok).toBe(true);
    if (btc.ok) expect(btc.adapter.id).toBe('spot-binance');

    const gold = resolveAdapter('GOLD', 'MCX', ADAPTERS);
    expect(gold.ok).toBe(true);
    if (gold.ok) expect(gold.adapter.id).toBe('futures-mcx');
  });

  it('has no adapter for the option style, so NIFTY cannot route here', async () => {
    // The option path is deliberately NOT registered in this list — it stays
    // where it is, untouched. This asserts the separation rather than assuming
    // it: NIFTY resolves to no adapter, instead of falling into a spot one.
    const result = resolveAdapter('NIFTY', 'NSE', ADAPTERS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.checkId).toBe('adapter-style-mismatch');
  });
});

describe('spot adapter', () => {
  const adapter = new SpotExecutionAdapter();

  it('sizes a fractional position the rupee OMS could not represent', async () => {
    const result = await adapter.materialise(signal(), CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 20% of 10,000 USD = 2,000 USD at 60,000 = 0.03333333 BTC.
    // The load-bearing property: it is FRACTIONAL. `Order.quantity Int` would
    // floor this to 0, which is why crypto routes to CryptoOrder instead.
    expect(result.order.quantity).toBeCloseTo(0.03333333, 8);
    expect(Number.isInteger(result.order.quantity)).toBe(false);
    expect(result.order.currency).toBe('USD');
    expect(result.order.side).toBe('BUY');
  });

  it('floors size rather than rounding, so the wallet is never oversized', async () => {
    const result = await adapter.materialise(signal({ referencePrice: 3 }), CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Rounding to nearest would size a position the wallet cannot fund; the
    // shortfall would then surface as a failed submission rather than as the
    // slightly smaller position it should have been.
    expect(result.order.quantity * 3).toBeLessThanOrEqual(2_000);
  });

  it('REFUSES a bearish signal, loudly and with a counted reason', async () => {
    // Not skipped. A silently-dropped signal would make the crypto win rate a
    // filtered statistic presented as a complete one.
    const result = await adapter.materialise(signal({ bias: 'bearish' }), CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.checkId).toBe('spot-long-only');
      expect(result.refusal.reason).toMatch(/short/i);
    }
  });

  it('refuses a neutral signal — it is not a weak buy', async () => {
    const result = await adapter.materialise(signal({ bias: 'neutral' }), CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.checkId).toBe('signal-not-directional');
  });

  it('refuses below the venue minimum notional', async () => {
    const result = await adapter.materialise(signal(), { ...CONTEXT, availableCapital: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.checkId).toBe('size-below-minimum');
  });

  it('passes a strategy stop through untranslated, and marks a derived one', async () => {
    const declared = await adapter.materialise(signal({ stopLoss: 58_000 }), CONTEXT);
    expect(declared.ok).toBe(true);
    if (declared.ok) {
      // Analysed instrument IS the traded one — no premium-space translation.
      expect(declared.order.stopLoss).toBe(58_000);
      expect(declared.order.explanation).toContain('(strategy)');
    }

    const derived = await adapter.materialise(signal(), CONTEXT);
    expect(derived.ok).toBe(true);
    if (derived.ok) {
      // A derived level must be readable AS derived, or a journal makes the
      // strategy look more specific than it was.
      expect(derived.order.explanation).toContain('derived from riskPerTradePct');
    }
  });
});

describe('futures adapter', () => {
  const adapter = new FuturesExecutionAdapter();
  const goldSignal = signal({
    symbol: 'GOLD',
    market: 'GOLD',
    executionStyle: 'futures',
    referencePrice: 100_000, // ₹1,00,000 per 10g
  });
  const goldContext = { ...CONTEXT, declaredVenue: 'MCX' as const, availableCapital: 1_000_000 };

  it('names the lot-size problem instead of silently sizing to zero', async () => {
    // One GOLD lot is 100g = ₹10,00,000 at this price. A 20% allocation of a
    // ₹10,00,000 wallet is ₹2,00,000 — nowhere near one lot. Without this
    // refusal the agent evaluates all day and produces nothing, which looks
    // exactly like an agent that found no setup.
    const result = await adapter.materialise(goldSignal, goldContext);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.checkId).toBe('lot-exceeds-allocation');
      expect(result.refusal.reason).toContain('GOLDM');
    }
  });

  it('sizes in whole lots when the allocation can carry one', async () => {
    const result = await adapter.materialise(goldSignal, {
      ...goldContext,
      availableCapital: 20_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number.isInteger(result.order.quantity)).toBe(true);
    expect(result.order.quantity).toBeGreaterThanOrEqual(1);
    expect(result.order.currency).toBe('INR');
  });

  it('trades BOTH directions, unlike spot', async () => {
    const short = await adapter.materialise(
      { ...goldSignal, bias: 'bearish' },
      { ...goldContext, availableCapital: 20_000_000 },
    );
    expect(short.ok).toBe(true);
    if (short.ok) expect(short.order.side).toBe('SELL');
  });

  it("puts a short's stop ABOVE entry and its target BELOW", async () => {
    // Deriving both from one side-blind expression would place a short's stop
    // into profit — a structurally guaranteed instant loss that every
    // downstream check would happily accept.
    const result = await adapter.materialise(
      { ...goldSignal, bias: 'bearish' },
      { ...goldContext, availableCapital: 20_000_000 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.stopLoss!).toBeGreaterThan(result.order.referencePrice);
    expect(result.order.target!).toBeLessThan(result.order.referencePrice);
  });
});
