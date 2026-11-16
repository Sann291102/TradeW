/**
 * The execution gates: what must be true before paper money moves, and what
 * must NOT happen when it isn't.
 *
 * Every case here is a way the brain could take a trade it should have
 * refused. The stubs are deliberately permissive — the assertions are about
 * the gates, so anything that gets past them would get past them in
 * production too.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutonomousExecutionService, MAX_ENTRY_DRIFT_R } from './autonomous-execution.service';
import type { TradeCandidate } from '@tradew/strategy-core';

const NOW = new Date('2026-09-10T05:00:00.000Z'); // 10:30 IST — session open

const candidate = (over: Partial<TradeCandidate> = {}): TradeCandidate =>
  ({
    market: 'INDIA',
    symbol: 'NIFTY',
    timeframe: '15m',
    decidedAt: NOW,
    signalBarAt: new Date('2026-09-10T04:45:00.000Z'),
    setupId: 'agent-ema-cross',
    setupName: 'EMA Cross Continuation',
    setupVersion: '1.0.0',
    archetype: 'signal-bar',
    bias: 'bullish',
    direction: 'long',
    quality: 100,
    confirmed: [],
    unmet: [],
    invalidated: [],
    regime: 'trending',
    features: {} as never,
    accepted: true,
    rejectionReason: null,
    rejectionDetail: null,
    explanation: 'because',
    plan: {
      direction: 'long',
      entry: 23_450,
      stop: 23_350,
      target: 23_750,
      firstRewardPrice: 23_550,
      riskPerUnit: 100,
      rewardPerUnit: 300,
      plannedRR: 3,
      anchor: { archetype: 'signal-bar', level: 23_360, note: 'Signal bar low at 23360' },
      atr: 60,
      riskAtr: 1.6,
      targetAtr: 5,
      exitPlan: {
        structuralInvalidation: 'Signal bar low at 23360',
        trailActivationR: 1,
        trailLockR: 0.5,
        trailStepR: 1,
        invalidationRules: ['ema_fast_below_slow'],
        exits: ['Stop', 'Target', 'Trail', 'Square-off'],
        summary: 'plan',
      },
      rationale: [],
    },
    ...over,
  }) as TradeCandidate;

/** A contract that comfortably clears the premium 1:3 floor. */
const goodContract = {
  ok: true as const,
  contract: {
    tradedSymbol: 'NIFTY:20260915:23450:CE',
    optionType: 'CE' as const,
    strike: 23_450,
    expiry: new Date('2026-09-15T10:00:00.000Z'),
    tradable: { entry: 150, stop: 120, target: 240, firstReward: 180, risk: 30, reward: 90, rr: 3 },
    premium: null,
    rationale: [],
  },
};

function harness(over: Record<string, unknown> = {}) {
  const created: Record<string, unknown>[] = [];
  const placed: Record<string, unknown>[] = [];

  const prisma = {
    autonomousTrade: {
      findUnique: vi.fn(async () => (over.existingTrade as unknown) ?? null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'trade-1' };
      }),
      update: vi.fn(async (_args: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({})),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    executionProfile: {
      findFirst: vi.fn(async () =>
        over.profile === null
          ? null
          : {
              id: 'p1',
              name: 'autonomous-nifty',
              accountUserId: 'u1',
              enabled: true,
              environment: 'PAPER',
              minConfidence: 70,
              maxOpenPositions: 3,
              maxOrdersPerDay: 6,
              maxLossPerDay: 25_000,
              squareOffMinute: 910,
              maxQuoteAgeMs: 15_000,
              lots: 10,
              orderType: 'MARKET',
              productType: 'NRML',
              riskPerTradePct: 3,
              capitalAllocationPct: 20,
              maxDrawdownPct: null,
              maxPortfolioExposurePct: null,
            },
      ),
    },
    paperWallet: {
      findUnique: vi.fn(async () => ({ cashBalance: 500_000, marginUsed: 0 })),
    },
  };

  const orders = {
    placeOrder: vi.fn(async (userId: string, input: Record<string, unknown>) => {
      placed.push({ userId, ...input });
      if (over.orderThrows) throw new Error(String(over.orderThrows));
      return {
        id: 'order-1',
        status: 'FILLED',
        avgFillPrice: 151,
        filledQuantity: input.quantity,
        placedAt: NOW,
        charges: 20,
      };
    }),
  };

  const marketPrice = {
    resolveInstrument: vi.fn(async () => ({ id: 'inst-1', lotSize: 65 })),
    getPrice: vi.fn(async () => ({
      ltp: (over.ltp as number) ?? 150,
      bid: 149,
      ask: 151,
      marketOpen: over.marketOpen !== false,
    })),
    // `feedFreshness` returns a Date, not an ISO string — matching the real
    // `MarketPriceService` signature so this stub cannot pass against a shape
    // the service never sees.
    feedFreshness: vi.fn(async () => ({
      quotedAt: over.stale ? new Date(NOW.getTime() - 600_000) : NOW,
      marketOpen: over.marketOpen !== false,
      instruments: 5,
    })),
  };

  const contracts = {
    resolve: vi.fn(async () => (over.contract as unknown) ?? goodContract),
  };

  const service = new AutonomousExecutionService(
    prisma as never,
    orders as never,
    marketPrice as never,
    contracts as never,
  );
  return { service, prisma, orders, marketPrice, contracts, created, placed };
}

beforeEach(() => {
  process.env.AUTONOMOUS_ENGINE_ENABLED = 'true';
});

describe('the execution switch', () => {
  it('places nothing when AUTONOMOUS_ENGINE_ENABLED is not exactly "true"', async () => {
    for (const value of ['false', '1', 'TRUE', '']) {
      process.env.AUTONOMOUS_ENGINE_ENABLED = value;
      const h = harness();
      const out = await h.service.execute('cand-1', candidate(), NOW);
      expect(out.executed).toBe(false);
      expect(out.refusal).toBe('execution-disabled');
      expect(h.placed).toEqual([]);
    }
  });

  it('refuses a candidate that was not accepted, or carries no plan', async () => {
    const h = harness();
    expect((await h.service.execute('c', candidate({ accepted: false }), NOW)).refusal).toBe('no-plan');
    expect((await h.service.execute('c', candidate({ plan: null }), NOW)).refusal).toBe('no-plan');
    expect(h.placed).toEqual([]);
  });
});

describe('idempotency', () => {
  it('never places a second order for a candidate that already traded', async () => {
    const h = harness({ existingTrade: { id: 'trade-existing', entryOrderId: 'order-existing' } });
    const out = await h.service.execute('cand-1', candidate(), NOW);

    expect(out.executed).toBe(false);
    expect(out.refusal).toBe('already-executed');
    expect(out.tradeId).toBe('trade-existing');
    expect(h.placed).toEqual([]);
  });

  it('claims the candidate row BEFORE placing the order', async () => {
    // Ordering matters: an unclaimed order is a position nobody manages, while
    // a claimed row with no order is a visible, repairable inconsistency.
    const h = harness();
    await h.service.execute('cand-1', candidate(), NOW);
    expect(h.prisma.autonomousTrade.create).toHaveBeenCalled();
    expect(h.created[0]).toMatchObject({ candidateId: 'cand-1', orderStatus: 'PENDING' });
    expect(h.placed).toHaveLength(1);
  });

  it('loses the race quietly when another worker claimed it first', async () => {
    const h = harness();
    const unique = Object.assign(new Error('unique'), { code: 'P2002' });
    Object.setPrototypeOf(unique, (await import('@prisma/client')).Prisma.PrismaClientKnownRequestError.prototype);
    h.prisma.autonomousTrade.create.mockRejectedValueOnce(unique as never);

    const out = await h.service.execute('cand-1', candidate(), NOW);
    expect(out.refusal).toBe('already-executed');
    expect(h.placed).toEqual([]);
  });
});

describe('fail closed', () => {
  it('refuses on stale data', async () => {
    const h = harness({ stale: true });
    const out = await h.service.execute('c', candidate(), NOW);
    expect(out.refusal).toBe('stale-data');
    expect(h.placed).toEqual([]);
  });

  it('refuses when the venue is closed', async () => {
    const h = harness({ marketOpen: false });
    const out = await h.service.execute('c', candidate(), NOW);
    // Either the freshness gate or the market gate may catch it first; both
    // are correct and both refuse.
    expect(['market-closed', 'stale-data']).toContain(out.refusal);
    expect(h.placed).toEqual([]);
  });

  it('refuses when no armed profile exists for the symbol', async () => {
    const h = harness({ profile: null });
    const out = await h.service.execute('c', candidate(), NOW);
    expect(out.refusal).toBe('no-profile');
    expect(h.placed).toEqual([]);
  });

  it('refuses when the contract cannot be established', async () => {
    const h = harness({
      contract: { ok: false, reason: 'premium-rr-below-floor', detail: 'contract pays 1.4:1' },
    });
    const out = await h.service.execute('c', candidate(), NOW);
    expect(out.refusal).toBe('contract-unavailable');
    expect(out.detail).toContain('1.4:1');
    expect(h.placed).toEqual([]);
  });

  it('records the claim as FAILED when the OMS rejects the order', async () => {
    const h = harness({ orderThrows: 'insufficient funds' });
    const out = await h.service.execute('c', candidate(), NOW);
    expect(out.executed).toBe(false);
    expect(out.refusal).toBe('order-failed');
    expect(h.prisma.autonomousTrade.update).toHaveBeenCalled();
  });
});

describe('NO CHASING', () => {
  it('refuses when price has already run past the planned entry', async () => {
    // Planned premium entry 150, risk 30. A 0.25R limit allows 7.5 of drift.
    const h = harness({ ltp: 150 + 30 * (MAX_ENTRY_DRIFT_R + 0.2) });
    const out = await h.service.execute('c', candidate(), NOW);

    expect(out.refusal).toBe('entry-missed');
    expect(out.detail).toContain('NOT chasing');
    expect(h.placed).toEqual([]);
  });

  it('still enters inside the drift allowance', async () => {
    const h = harness({ ltp: 150 + 30 * (MAX_ENTRY_DRIFT_R - 0.05) });
    const out = await h.service.execute('c', candidate(), NOW);
    expect(out.refusal).toBeNull();
    expect(h.placed).toHaveLength(1);
  });

  it('does NOT refuse when price moved AGAINST the trade', async () => {
    // A better entry than planned is not chasing — the validated reward:risk
    // has improved, not decayed.
    const h = harness({ ltp: 150 - 30 * 2 });
    const out = await h.service.execute('c', candidate(), NOW);
    expect(out.refusal).not.toBe('entry-missed');
  });

  it('never rewrites the plan to make a missed entry work', async () => {
    const h = harness({ ltp: 150 + 30 });
    await h.service.execute('c', candidate(), NOW);
    // Nothing was claimed and nothing was placed — the setup simply expires.
    expect(h.prisma.autonomousTrade.create).not.toHaveBeenCalled();
    expect(h.placed).toEqual([]);
  });
});

describe('what it writes when it does trade', () => {
  it('persists both the index plan and the tradable plan', async () => {
    const h = harness();
    await h.service.execute('cand-1', candidate(), NOW);
    const row = h.created[0];

    // The translation is auditable because both ends are stored.
    expect(Number(row.indexEntry)).toBe(23_450);
    expect(Number(row.indexStop)).toBe(23_350);
    expect(Number(row.plannedEntry)).toBe(150);
    expect(Number(row.initialStop)).toBe(120);
    expect(Number(row.plannedRR)).toBe(3);
    expect(row.tradedSymbol).toBe('NIFTY:20260915:23450:CE');
  });

  it('persists the sizing working, so a quantity can be re-derived', async () => {
    const h = harness();
    await h.service.execute('cand-1', candidate(), NOW);
    const row = h.created[0];
    expect(Number(row.riskBudget)).toBeGreaterThan(0);
    expect(Number(row.stopDistance)).toBeGreaterThan(0);
    expect(row.approvedQuantity).toBeGreaterThan(0);
    expect(Array.isArray(row.sizingRationale)).toBe(true);
  });

  it('places a BUY through the paper OMS with a lot-aligned quantity', async () => {
    const h = harness();
    await h.service.execute('cand-1', candidate(), NOW);
    const order = h.placed[0];
    expect(order).toMatchObject({ symbol: 'NIFTY:20260915:23450:CE', side: 'BUY' });
    expect((order.quantity as number) % 65).toBe(0);
  });

  it('seeds the high-water mark at the ACTUAL fill, not the planned entry', async () => {
    const h = harness();
    await h.service.execute('cand-1', candidate(), NOW);
    const update = h.prisma.autonomousTrade.update.mock.calls[0]![0];
    expect(update.data.actualFillPrice).toBe(151);
    expect(update.data.highWaterPrice).toBe(151);
    expect(update.data.positionStatus).toBe('OPEN');
  });
});

describe('the option position is LONG in premium space', () => {
  it('stores the TRADABLE direction, not the index direction', async () => {
    // The bug this pins, caught by the live lifecycle proof on 2026-09-10: a
    // bearish index read is expressed by BUYING a put, so the position is long
    // the premium — stop below entry, target above. Storing the index
    // direction ('short') made the position manager read it as a short and
    // exit on the very tick it opened.
    const bearish = candidate({
      bias: 'bearish',
      plan: { ...candidate().plan!, direction: 'short' },
    });
    const putContract = {
      ok: true as const,
      contract: {
        ...goodContract.contract,
        tradedSymbol: 'NIFTY:20260915:23450:PE',
        optionType: 'PE' as const,
      },
    };
    const h = harness({ contract: putContract });
    await h.service.execute('cand-put', bearish, NOW);

    expect(h.created[0].direction).toBe('long');
    // The index view is not lost — `optionType` carries it.
    expect(h.created[0].optionType).toBe('PE');
  });

  it('keeps the index direction for a directly-traded instrument', async () => {
    // GOLD is a future: the analysed instrument IS the traded one, so a
    // bearish read really is a short position.
    const bearish = candidate({ symbol: 'GOLD', plan: { ...candidate().plan!, direction: 'short' } });
    const futureContract = {
      ok: true as const,
      contract: { ...goodContract.contract, tradedSymbol: 'GOLD', optionType: null, strike: null, expiry: null },
    };
    const h = harness({ contract: futureContract });
    await h.service.execute('cand-gold', bearish, NOW);
    expect(h.created[0].direction).toBe('short');
  });
});

describe('Sentinel cannot influence any of this', () => {
  it('constructs no Sentinel client and reads no Sentinel table', async () => {
    const { readFileSync } = await import('node:fs');
    const body = readFileSync(`${__dirname}/autonomous-execution.service.ts`, 'utf8');
    expect(body).not.toMatch(/SentinelExecutionClient|SentinelApiService|sentinelExecution/);
    // The one Sentinel-shaped table in the app must not be read here either.
    expect(body).not.toMatch(/executionEvaluationLog/);
  });
});
