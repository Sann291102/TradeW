import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { MarketPriceService } from '../sim/market-price.service';
import { ExecutionHealthService } from './execution-health.service';
import type { ExecutionSchedulerService } from './execution-scheduler.service';
import type { SystemExecutionControlService } from './system-execution-control.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const loopStatus = (over: Partial<Any> = {}) => ({
  enabled: true,
  intervalMs: 60_000,
  reconcileMs: 15_000,
  isEvaluateLeader: true,
  isReconcileLeader: true,
  evaluating: false,
  reconciling: false,
  startedAt: '2026-01-05T03:45:00.000Z',
  lastEvaluateAt: '2026-01-05T05:00:00.000Z',
  lastReconcileAt: '2026-01-05T05:00:10.000Z',
  session: { phase: 'active', isOpen: true, isTradingDay: true, minuteOfDay: 630, dayKey: '2026-01-05', reason: 'open' },
  ...over,
});

function build(opts: { loop?: Partial<Any>; mode?: string; feedAvailable?: boolean } = {}) {
  const scheduler = { status: vi.fn(() => loopStatus(opts.loop)) } as unknown as ExecutionSchedulerService;
  const control = {
    current: vi.fn(async () => ({ mode: opts.mode ?? 'ON', reason: null, updatedBy: null, updatedAt: null, isDefault: true })),
  } as unknown as SystemExecutionControlService;
  const marketPrice = {
    feedHealth: vi.fn(async () => ({
      available: opts.feedAvailable ?? true,
      marketOpen: true,
      asOf: opts.feedAvailable === false ? null : 1,
      ageMs: opts.feedAvailable === false ? null : 500,
    })),
  } as unknown as MarketPriceService;

  const prisma = {
    executionProfile: { count: vi.fn(async () => 2) },
    executionIntent: {
      groupBy: vi.fn(async () => [
        { status: 'FILLED', _count: { _all: 3 } },
        { status: 'REJECTED', _count: { _all: 5 } },
        { status: 'CLOSED', _count: { _all: 1 } },
      ]),
      findFirst: vi.fn(async () => null),
    },
    executionOutcome: {
      findMany: vi.fn(async () => [{ realizedPnl: 1200 }, { realizedPnl: -400 }]),
    },
  } as unknown as PrismaService;

  return new ExecutionHealthService(prisma, scheduler, control, marketPrice);
}

describe('ExecutionHealthService.health — the status headline is DERIVED, never asserted', () => {
  it('DISABLED when the env flag is off (no timers exist)', async () => {
    const h = await build({ loop: { enabled: false } }).health();
    expect(h.status).toBe('DISABLED');
  });

  it('HALTED under EMERGENCY_STOP and PAUSED under OFF', async () => {
    expect((await build({ mode: 'EMERGENCY_STOP' }).health()).status).toBe('HALTED');
    expect((await build({ mode: 'OFF' }).health()).status).toBe('PAUSED');
  });

  it('RUNNING only when enabled, ON, and this process holds the evaluate lease', async () => {
    expect((await build({ mode: 'ON', loop: { isEvaluateLeader: true } }).health()).status).toBe('RUNNING');
    // A live process that is not the leader is IDLE, not a second "running" claim.
    expect((await build({ mode: 'ON', loop: { isEvaluateLeader: false } }).health()).status).toBe('IDLE');
  });
});

describe('ExecutionHealthService.health — every field is real state', () => {
  it("today's counts are derived from the intent status groups and closed outcomes", async () => {
    const h = await build().health();
    expect(h.today.armedProfiles).toBe(2);
    // orders = SUBMITTED + FILLED + CLOSED (3 filled + 1 closed here)
    expect(h.today.orders).toBe(4);
    expect(h.today.fills).toBe(4); // FILLED + CLOSED
    expect(h.today.openPositions).toBe(3); // FILLED only
    expect(h.today.rejections).toBe(5); // REJECTED + FAILED
    expect(h.today.realizedPnl).toBe(800); // 1200 + (−400)
    expect(h.today.closedOutcomes).toBe(2);
  });

  it('surfaces the live control mode and the feed probe verbatim, not a fixed label', async () => {
    const up = await build({ feedAvailable: true }).health();
    expect(up.control.mode).toBe('ON');
    expect(up.marketData.available).toBe(true);

    const down = await build({ feedAvailable: false }).health();
    expect(down.marketData.available).toBe(false);
    expect(down.marketData.asOf).toBeNull();
  });
});
