import { describe, expect, it, vi } from 'vitest';
import { type OpenPositionReader, countProfileOpenPositions } from './execution-open-positions';

/**
 * These assertions pin the count that a limit and its own display must agree on.
 *
 * The bug this file exists to prevent had no symptom in the gate and no symptom
 * in the query — each was self-consistent. It appeared only where the two met:
 * the console rendered an account-wide numerator against a per-profile limit, so
 * a person holding their own positions made their agent read as over a limit the
 * agent was nowhere near. Nothing crashed, nothing logged, and the number was
 * wrong in the direction that makes an operator disarm a working profile.
 */

/** A stub shaped like the two Prisma delegates this reads, and nothing else. */
function reader(
  filled: Array<{ order: { instrumentId: string; productType: string } | null }>,
  positionCount = 0,
) {
  const count = vi.fn().mockResolvedValue(positionCount);
  const findMany = vi.fn().mockResolvedValue(filled);
  return {
    prisma: { executionIntent: { findMany }, position: { count } } as unknown as OpenPositionReader,
    count,
    findMany,
  };
}

describe('countProfileOpenPositions', () => {
  it('counts nothing, and touches no position row, when the profile has never filled', async () => {
    // The cheap path matters: this runs on every evaluate tick, for every armed
    // profile, whether or not the profile has ever traded.
    const { prisma, count } = reader([]);
    await expect(countProfileOpenPositions(prisma, 'profile-1', 'user-1')).resolves.toBe(0);
    expect(count).not.toHaveBeenCalled();
  });

  it('asks only about instruments THIS profile actually opened', async () => {
    const { prisma, count, findMany } = reader(
      [
        { order: { instrumentId: 'nifty-ce-24500', productType: 'MIS' } },
        { order: { instrumentId: 'nifty-pe-24000', productType: 'MIS' } },
      ],
      2,
    );

    await expect(countProfileOpenPositions(prisma, 'profile-1', 'user-1')).resolves.toBe(2);

    // Scoped to the profile's own filled intents...
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { profileId: 'profile-1', status: 'FILLED' } }),
    );
    // ...and the position query is bounded by those instruments, never a bare
    // "everything open on this account". That bound IS the fix: a human's
    // unrelated positions must not consume the agent's concurrency budget.
    const where = count.mock.calls[0][0].where;
    expect(where.userId).toBe('user-1');
    expect(where.quantity).toEqual({ not: 0 });
    expect(where.OR).toEqual([
      { instrumentId: 'nifty-ce-24500', productType: 'MIS' },
      { instrumentId: 'nifty-pe-24000', productType: 'MIS' },
    ]);
  });

  it('treats two intents on the same contract as one position', async () => {
    // `Position` is unique on (userId, instrumentId, productType), so the grain
    // here has to match — a concurrency limit that counted intents instead of
    // positions would refuse a profile holding one contract it added to twice.
    const { prisma, count } = reader(
      [
        { order: { instrumentId: 'nifty-ce-24500', productType: 'MIS' } },
        { order: { instrumentId: 'nifty-ce-24500', productType: 'MIS' } },
      ],
      1,
    );
    await expect(countProfileOpenPositions(prisma, 'profile-1', 'user-1')).resolves.toBe(1);
    expect(count.mock.calls[0][0].where.OR).toHaveLength(1);
  });

  it('separates the same contract held under different product types', async () => {
    const { prisma, count } = reader(
      [
        { order: { instrumentId: 'nifty-ce-24500', productType: 'MIS' } },
        { order: { instrumentId: 'nifty-ce-24500', productType: 'NRML' } },
      ],
      2,
    );
    await expect(countProfileOpenPositions(prisma, 'profile-1', 'user-1')).resolves.toBe(2);
    expect(count.mock.calls[0][0].where.OR).toHaveLength(2);
  });

  it('skips a filled intent with no linked order rather than throwing', async () => {
    // Structurally impossible (the link and the status are written in one
    // transaction), which is exactly why it must not take down an evaluate tick
    // if it ever happens — reconcile is what surfaces that inconsistency.
    const { prisma, count } = reader([{ order: null }]);
    await expect(countProfileOpenPositions(prisma, 'profile-1', 'user-1')).resolves.toBe(0);
    expect(count).not.toHaveBeenCalled();
  });
});
