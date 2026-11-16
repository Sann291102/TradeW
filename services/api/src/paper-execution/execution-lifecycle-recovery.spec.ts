import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrderService } from '../sim/order.service';
import type { ExecutionJournalService } from './execution-journal.service';
import { ExecutionLifecycleService, STALE_PROPOSED_MS } from './execution-lifecycle.service';

/**
 * Restart recovery: a PROPOSED intent that never became an order — the process
 * died between claiming the decision and submitting it — must be failed out on
 * the next reconcile, under its own countable id, and NEVER an intent that has
 * since become an order — nor one whose order was placed but never linked.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = any;

function makeService(
  findManyResult: unknown[],
  updateCount: (id: string) => number,
  unlinkedOrderFor: (contractSymbol: string) => { id: string } | null = () => null,
) {
  const updateMany = vi.fn(async (args: AnyArgs) => ({ count: updateCount(args.where.id) }));
  const findMany = vi.fn(async (_args?: AnyArgs) => findManyResult);
  const findFirst = vi.fn(async (args: AnyArgs) => unlinkedOrderFor(args.where.instrument.symbol));
  const prisma = {
    executionIntent: { findMany, updateMany },
    order: { findFirst },
  } as unknown as PrismaService;
  const orders = {} as OrderService;
  const journal = {} as ExecutionJournalService;
  return { svc: new ExecutionLifecycleService(prisma, orders, journal), findMany, findFirst, updateMany };
}

const decidedAt = new Date('2026-01-05T10:20:00+05:30');
const orphan = (id: string, contractSymbol: string) => ({
  id,
  decidedAt,
  contractSymbol,
  profile: { accountUserId: 'acct-1', name: 'alpha' },
});

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
    expect(STALE_PROPOSED_MS).toBe(2 * 60_000);
  });

  it('fails each orphan under the recovery-orphaned id, guarded on PROPOSED status', async () => {
    const orphans = [orphan('i1', 'NIFTY:20260129:23800:CE'), orphan('i2', 'NIFTY:20260129:23850:CE')];
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
    const orphans = [orphan('won', 'NIFTY:20260129:23800:CE'), orphan('lost-race', 'NIFTY:20260129:23850:CE')];
    // 'lost-race' became SUBMITTED between the read and the guarded write, so its
    // guarded update matches zero rows and it is not counted as recovered.
    const { svc } = makeService(orphans, (id) => (id === 'lost-race' ? 0 : 1));
    expect(await svc.recoverStuckIntents(now)).toBe(1);
  });

  it('leaves an orphan PROPOSED when an unlinked order for its contract was placed after the decision', async () => {
    // A crash between placeOrder returning and the link transaction leaves a
    // real order with no intent link. Failing the intent would let createIntent
    // re-claim it into a SECOND order in the same window, so it is left alone.
    const orphans = [orphan('placed', 'NIFTY:20260129:23800:CE'), orphan('clean', 'NIFTY:20260129:23850:CE')];
    const { svc, updateMany, findFirst } = makeService(
      orphans,
      () => 1,
      (contract) => (contract === 'NIFTY:20260129:23800:CE' ? { id: 'order-unlinked' } : null),
    );
    expect(await svc.recoverStuckIntents(now)).toBe(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect((updateMany.mock.calls[0]![0] as AnyArgs).where.id).toBe('clean');
    const where = (findFirst.mock.calls[0]![0] as AnyArgs).where;
    expect(where).toMatchObject({ userId: 'acct-1', executionIntentId: null, exitOfIntentId: null });
    expect(where.placedAt.gte).toEqual(decidedAt);
  });

  it('reports a held-back orphan once, not on every reconcile', async () => {
    const orphans = [orphan('placed', 'NIFTY:20260129:23800:CE')];
    const { svc, updateMany } = makeService(orphans, () => 1, () => ({ id: 'order-unlinked' }));
    const error = vi.spyOn((svc as unknown as { logger: { error: (m: string) => void } }).logger, 'error').mockImplementation(() => {});
    expect(await svc.recoverStuckIntents(now)).toBe(0);
    expect(await svc.recoverStuckIntents(now)).toBe(0);
    expect(await svc.recoverStuckIntents(now)).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
