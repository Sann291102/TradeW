import type { PrismaClient, ProductType } from '@prisma/client';

/**
 * How many positions ONE PROFILE currently has open.
 *
 * ## Why this is a shared function and not a method on either service
 *
 * There were two implementations of this count, and they disagreed.
 *
 * `PaperExecutionService` walked the profile's own FILLED intents to their
 * orders' instruments and asked the position table which were still non-zero —
 * the profile's own concurrency, which is what `maxOpenPositions` is documented
 * to bound. `ExecutionQueryService.profiles()` counted every non-zero position
 * on the ACCOUNT. On a dedicated machine account those are the same number. On
 * a `USER_PAPER` account bound to a real trader they are not, and the console
 * rendered the account-wide numerator against the per-profile limit: a person
 * holding two positions of their own made their agent read `2/1` — visibly
 * over its limit — while the gate that actually decides was looking at a
 * different number entirely and letting the pass through.
 *
 * A limit and the display of that limit disagreeing is worse than either being
 * wrong on its own, because the console is where an operator goes to find out
 * why the loop did what it did. So there is now one function, and both callers
 * are that function.
 *
 * ## What it counts
 *
 * Distinct (instrument, productType) pairs this profile is holding — the same
 * grain as the `Position` table's own unique key, so "one position" here means
 * exactly what it means everywhere else in the OMS. A profile that has never
 * filled anything returns 0 without touching the position table at all.
 */

/** The narrow slice of the client this needs. Named off Prisma's own type so it
 *  cannot drift from the real signatures, and narrow so nothing here can reach
 *  a table it has no business reading. */
export type OpenPositionReader = Pick<PrismaClient, 'executionIntent' | 'position'>;

export async function countProfileOpenPositions(
  prisma: OpenPositionReader,
  profileId: string,
  userId: string,
): Promise<number> {
  const filled = await prisma.executionIntent.findMany({
    where: { profileId, status: 'FILLED' },
    select: { order: { select: { instrumentId: true, productType: true } } },
  });

  const keys = new Map<string, { instrumentId: string; productType: ProductType }>();
  for (const intent of filled) {
    if (!intent.order) continue;
    keys.set(`${intent.order.instrumentId}::${intent.order.productType}`, {
      instrumentId: intent.order.instrumentId,
      productType: intent.order.productType,
    });
  }
  if (keys.size === 0) return 0;

  return prisma.position.count({
    where: {
      userId,
      quantity: { not: 0 },
      OR: [...keys.values()].map((k) => ({ instrumentId: k.instrumentId, productType: k.productType })),
    },
  });
}
