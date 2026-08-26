import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrderService } from '../sim/order.service';
import { ExecutionLifecycleService } from './execution-lifecycle.service';

/**
 * Restart recovery: a PROPOSED intent that never became an order — the process
 * died between claiming the decision and submitting it — must be failed out on
 * the next reconcile, under its own countable id, and NEVER an intent that has
 * since become an order.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = any;

function makeService(findManyResult: unknown[], updateCount: (id: string) => number) {
  const updateMany = vi.fn(async (args: AnyArgs) => ({ count: updateCount(args.where.id) }));
  const findMany = vi.fn(async (_args?: AnyArgs) => findManyResult);
  const prisma = {
    executionIntent: { findMany, updateMany },
  } as unknown as PrismaService;
  const orders = {} as OrderService;
  return { svc: new ExecutionLifecycleService(prisma, orders), findMany, updateMany };
}

describe('ExecutionLifecycleService.recoverStuckIntents', () => {
  const now = new Date('2026-01-05T10:30:00+05:30');

  it('does nothing when there are no orphans', async () => {
    const { svc, updateMany } = makeService([], () => 1);
    expect(await svc.recoverStuckIntents(now)).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('queries only PROPOSED, order-less intents older than the staleness window', async () => {
    const { svc, findMany } = makeService([], () => 1);
    await svc.recoverStuckIntents(now);
    const where = (findMany.mock.calls[0]![0] as AnyArgs).where;
    expect(where.status).toBe('PROPOSED');
    expect(where.order).toEqual({ is: null });
    // Older than a 2-minute window before `now`.
    expect(where.decidedAt.lt.getTime()).toBe(now.getTime() - 2 * 60_000);
  });

  it('fails each orphan under the recovery-orphaned id, guarded on PROPOSED status', async () => {
    const orphans = [
      { id: 'i1', profileId: 'p1', contractSymbol: 'NIFTY:20260129:23800:CE' },
      { id: 'i2', profileId: 'p1', contractSymbol: 'NIFTY:20260129:23850:CE' },
    ];
    const { svc, updateMany } = makeService(orphans, () => 1);
    expect(await svc.recoverStuckIntents(now)).toBe(2);
    expect(updateMany).toHaveBeenCalledTimes(2);
    const firstCall = updateMany.mock.calls[0]![0] as AnyArgs;
    // The status guard is the real safety: the write only lands while the row
    // is still PROPOSED.
    expect(firstCall.where).toEqual({ id: 'i1', status: 'PROPOSED' });
    expect(firstCall.data.status).toBe('FAILED');
    expect(firstCall.data.rejectCheckId).toBe('recovery-orphaned');
    expect(firstCall.data.rejectReason).toContain('no order was ever submitted');
  });

  it('does not count an orphan that a concurrent submission claimed first (0 rows updated)', async () => {
    const orphans = [
      { id: 'won', profileId: 'p1', contractSymbol: 'NIFTY:20260129:23800:CE' },
      { id: 'lost-race', profileId: 'p1', contractSymbol: 'NIFTY:20260129:23850:CE' },
    ];
    // 'lost-race' became SUBMITTED between the read and the guarded write, so its
    // guarded update matches zero rows and it is not counted as recovered.
    const { svc } = makeService(orphans, (id) => (id === 'lost-race' ? 0 : 1));
    expect(await svc.recoverStuckIntents(now)).toBe(1);
  });
});
