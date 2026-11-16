/**
 * Managing an open autonomous paper position.
 *
 * The two things that matter: the stop only ever ratchets forward, and the
 * manager may only execute the plan it was given. Both are asserted against
 * the REAL service with stubbed price and OMS, so the logic under test is the
 * logic that runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutonomousPositionManagerService } from './autonomous-position-manager.service';

const NOW = new Date('2026-09-10T05:00:00.000Z'); // 10:30 IST — NSE open

/** Entry 79, stop 69, target 109 — the brief's own worked example. */
const openTrade = (over: Record<string, unknown> = {}) => ({
  id: 'trade-1',
  symbol: 'NIFTY',
  tradedSymbol: 'NIFTY:20260915:23450:CE',
  direction: 'long',
  quantity: 65,
  filledQuantity: 65,
  lotSize: 65,
  plannedEntry: 79,
  actualFillPrice: 79,
  initialStop: 69,
  initialTarget: 109,
  firstRewardPrice: 89,
  currentStop: 69,
  highWaterPrice: 79,
  trailSteps: 0,
  trailActivated: false,
  positionStatus: 'OPEN',
  plannedRR: 3,
  entryAt: new Date(NOW.getTime() - 3_600_000),
  ...over,
});

function harness(over: Record<string, unknown> = {}) {
  const updates: Record<string, unknown>[] = [];
  const placed: Record<string, unknown>[] = [];

  const prisma = {
    autonomousTrade: {
      findMany: vi.fn(async () => (over.trades as unknown[]) ?? [openTrade()]),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args.data);
        return {};
      }),
    },
    executionProfile: {
      findFirst: vi.fn(async () => ({ accountUserId: 'u1', productType: 'NRML' })),
    },
  };

  const orders = {
    placeOrder: vi.fn(async (userId: string, input: Record<string, unknown>) => {
      placed.push({ userId, ...input });
      return { id: 'exit-1', status: 'FILLED', avgFillPrice: over.exitFill ?? over.ltp ?? 100, charges: 10 };
    }),
  };

  const marketPrice = {
    resolveInstrument: vi.fn(async () => {
      if (over.unpriceable) throw new Error('no such instrument');
      return { id: 'i1', lotSize: 65 };
    }),
    getPrice: vi.fn(async () => ({
      ltp: (over.ltp as number) ?? 85,
      bid: 0,
      ask: 0,
      marketOpen: over.marketOpen !== false,
    })),
  };

  const service = new AutonomousPositionManagerService(prisma as never, orders as never, marketPrice as never);
  return { service, prisma, orders, updates, placed };
}

beforeEach(() => vi.clearAllMocks());

describe('the ratchet, on the brief’s worked example', () => {
  it('does not trail below 1R', async () => {
    // 85 is 0.6R. The structural stop stands.
    const h = harness({ ltp: 85 });
    await h.service.manageAll(NOW);
    const stopWrites = h.updates.filter((u) => u.currentStop !== undefined);
    expect(stopWrites).toHaveLength(0);
  });

  it('moves the stop to 84 when price reaches 1R (89)', async () => {
    const h = harness({ ltp: 89 });
    const summary = await h.service.manageAll(NOW);
    expect(summary.trailed).toBe(1);
    expect(Number(h.updates[0].currentStop)).toBe(84);
    expect(h.updates[0].trailActivated).toBe(true);
  });

  it('moves to 94 at 2R and 104 at 3R', async () => {
    const at2R = harness({ trades: [openTrade({ currentStop: 84, highWaterPrice: 89, trailActivated: true })], ltp: 99 });
    await at2R.service.manageAll(NOW);
    expect(Number(at2R.updates[0].currentStop)).toBe(94);

    // 3R is also the TARGET here, so reaching it exits rather than trails —
    // which is correct: the plan's target takes precedence over the ratchet.
    const at3R = harness({ trades: [openTrade({ currentStop: 94, highWaterPrice: 99, trailActivated: true })], ltp: 109 });
    const summary = await at3R.service.manageAll(NOW);
    expect(summary.exited).toBe(1);
    expect(at3R.updates[0].exitReason).toBe('TARGET');
  });

  it('never moves the stop backwards on a pullback', async () => {
    const h = harness({
      trades: [openTrade({ currentStop: 94, highWaterPrice: 99, trailActivated: true })],
      ltp: 92, // back below the last step, but above the stop
    });
    await h.service.manageAll(NOW);
    const stopWrites = h.updates.filter((u) => u.currentStop !== undefined);
    expect(stopWrites).toHaveLength(0);
  });

  it('advances the high-water mark even when the stop does not move', async () => {
    // The mark is what the NEXT evaluation ratchets from.
    const h = harness({ trades: [openTrade({ highWaterPrice: 79 })], ltp: 85 });
    await h.service.manageAll(NOW);
    expect(Number(h.updates[0].highWaterPrice)).toBe(85);
    expect(h.updates[0].currentStop).toBeUndefined();
  });

  it('stamps lastManagedAt on EVERY pass, even one that changed nothing', async () => {
    // Writing only on a change made "managed, nothing to do" and "not managed
    // at all" indistinguishable — the same blindness that hid a frozen
    // scheduler for three hours.
    const h = harness({ trades: [openTrade({ highWaterPrice: 85 })], ltp: 85 });
    await h.service.manageAll(NOW);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].lastManagedAt).toEqual(NOW);
    expect(h.updates[0].currentStop).toBeUndefined();
  });
});

describe('exits', () => {
  it('exits at the stop and records it as STOP before trailing activates', async () => {
    const h = harness({ ltp: 68, exitFill: 68 });
    const summary = await h.service.manageAll(NOW);
    expect(summary.exited).toBe(1);
    expect(h.updates[0].exitReason).toBe('STOP');
    expect(h.updates[0].positionStatus).toBe('CLOSED');
  });

  it('records a trailing exit as TRAIL once the ratchet has moved', async () => {
    const h = harness({
      trades: [openTrade({ currentStop: 94, highWaterPrice: 99, trailActivated: true })],
      ltp: 93,
      exitFill: 93,
    });
    await h.service.manageAll(NOW);
    expect(h.updates[0].exitReason).toBe('TRAIL');
  });

  it('closes through the paper OMS with a SELL of the filled quantity', async () => {
    const h = harness({ ltp: 68, exitFill: 68 });
    await h.service.manageAll(NOW);
    expect(h.placed[0]).toMatchObject({
      symbol: 'NIFTY:20260915:23450:CE',
      side: 'SELL',
      quantity: 65,
    });
  });

  it('measures realised R from the ACTUAL fill, not the planned entry', async () => {
    // Filled at 82 rather than the planned 79 — the 3 points of slippage must
    // show up in R, not be folded away.
    const h = harness({
      trades: [openTrade({ actualFillPrice: 82, currentStop: 69 })],
      ltp: 69,
      exitFill: 69,
    });
    await h.service.manageAll(NOW);
    // risk = |82 − 69| = 13; move = 69 − 82 = −13 → −1R exactly.
    expect(Number(h.updates[0].realizedR)).toBeCloseTo(-1, 2);
  });

  it('squares off before the venue closes rather than holding overnight', async () => {
    // 15:20 IST — inside the square-off window before the 15:30 NSE close.
    const closing = new Date('2026-09-10T09:50:00.000Z');
    const h = harness({ ltp: 95, exitFill: 95 });
    const summary = await h.service.manageAll(closing);
    expect(summary.exited).toBe(1);
    expect(h.updates[0].exitReason).toBe('SQUARE_OFF');
  });
});

describe('it fails safe', () => {
  it('holds rather than exiting when the contract cannot be priced', async () => {
    // An exit at a made-up price is worse than a late one.
    const h = harness({ unpriceable: true });
    const summary = await h.service.manageAll(NOW);
    expect(summary.held).toBe(1);
    expect(summary.exited).toBe(0);
    expect(h.placed).toEqual([]);
  });

  it('holds when the venue reports closed mid-session rather than guessing', async () => {
    const h = harness({ ltp: 85, marketOpen: false });
    const summary = await h.service.manageAll(NOW);
    expect(summary.exited + summary.trailed).toBe(0);
  });

  it('keeps managing the other positions when one throws', async () => {
    const h = harness({ trades: [openTrade({ id: 'a' }), openTrade({ id: 'b' })], ltp: 89 });
    h.prisma.autonomousTrade.update.mockRejectedValueOnce(new Error('deadlock') as never);
    const summary = await h.service.manageAll(NOW);
    expect(summary.errors).toBe(1);
    expect(summary.evaluated).toBe(2);
  });
});

describe('restart recovery', () => {
  it('discovers open positions from the DATABASE, not from memory', async () => {
    // A process that comes up mid-session must find its positions on the first
    // tick — which is automatic when the query IS the discovery.
    const h = harness({ ltp: 89 });
    await h.service.manageAll(NOW);
    expect(h.prisma.autonomousTrade.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { positionStatus: 'OPEN' } }),
    );
  });

  it('resumes the ratchet from the persisted state, not from the entry', async () => {
    // The row already locked +1.5R. A restart must not reset that.
    const h = harness({
      trades: [openTrade({ currentStop: 94, highWaterPrice: 99, trailSteps: 2, trailActivated: true })],
      ltp: 109,
      exitFill: 109,
    });
    const summary = await h.service.manageAll(NOW);
    // Reaching the target exits; the point is that the stop was never reset to 69.
    expect(summary.exited).toBe(1);
    const reset = h.updates.find((u) => Number(u.currentStop) < 94);
    expect(reset).toBeUndefined();
  });
});

describe('it may only execute the plan', () => {
  it('holds no scanner, selector or level deriver', async () => {
    // §14/§15, structurally: an engine that can re-derive a setup mid-trade is
    // arguing with its earlier self, and the earlier self had a risk gate.
    const { readFileSync } = await import('node:fs');
    const body = readFileSync(`${__dirname}/autonomous-position-manager.service.ts`, 'utf8');

    // IMPORTS only. The file's own documentation names these precisely because
    // it explains why it must not use them, and matching prose would make the
    // test fail on the comment that states the rule.
    const imported = (body.match(/^import[\s\S]*?from\s+'[^']+';$/gm) ?? []).join(' ');
    expect(imported).not.toMatch(/SetupScannerService|ContractSelectorService|deriveLevels|scanForCandidates/);

    // And no runtime call to them either.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/deriveLevels\(|scanForCandidates\(/);
  });
});
