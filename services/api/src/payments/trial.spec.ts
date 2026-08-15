import { describe, expect, it, vi } from 'vitest';
import { SENTINEL_TRIAL, SENTINEL_BASE_MONTHLY } from '@tradew/types';
import { PaymentService } from './payment.service';
import { CATALOG, catalogItem, TRIAL_ITEM, TRIAL_PERIOD_KEY, TRIAL_CLAIM_METRIC } from './payment.catalog';

/**
 * The paid 7-day trial.
 *
 * What is pinned here is the set of properties that make a one-time offer
 * actually one-time, and the day-length grant actually seven days. A test that
 * asserted the rendered price would have passed against a version that charged
 * ₹275 and granted a month.
 *
 * Structural stubs over plain objects, matching coupon-redeem.spec.ts — no
 * database, no network, deterministic.
 */

const SENTINEL_PLAN = { id: 'plan-sentinel', code: 'sentinel_pro', active: true, trialDays: 7, graceDays: 3 };

function makeService(opts: { claims?: string[]; subscriptions?: Record<string, unknown>[] } = {}) {
  // The unique constraint on (userId, metric, periodKey), modelled as a Set —
  // it is the mechanism the once-per-user guarantee actually rests on.
  const claims = new Set(opts.claims ?? []);
  const subscriptions: Record<string, unknown>[] = [...(opts.subscriptions ?? [])];
  const key = (userId: string, metric: string, periodKey: string) => `${userId}::${metric}::${periodKey}`;

  const prisma = {
    subscription: {
      findFirst: async ({ where }: { where: { billingReference?: string } }) =>
        subscriptions.find((s) => s.billingReference === where.billingReference) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = subscriptions.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    usageCounter: {
      findUnique: async ({ where }: { where: { userId_metric_periodKey: { userId: string; metric: string; periodKey: string } } }) => {
        const k = key(
          where.userId_metric_periodKey.userId,
          where.userId_metric_periodKey.metric,
          where.userId_metric_periodKey.periodKey,
        );
        return claims.has(k) ? { userId: '', metric: '', periodKey: '', used: 1 } : null;
      },
      create: async ({ data }: { data: { userId: string; metric: string; periodKey: string } }) => {
        const k = key(data.userId, data.metric, data.periodKey);
        if (claims.has(k)) throw new Error('Unique constraint failed'); // what Prisma P2002 does here
        claims.add(k);
        return data;
      },
    },
    user: { findUnique: async () => null },
  };

  const activate = vi.fn(async (userId: string, planCode: string, o: { trial?: boolean; expiresAt?: Date | null }) => {
    const row = {
      id: `sub-${subscriptions.length + 1}`,
      userId,
      planCode,
      status: o.trial && SENTINEL_PLAN.trialDays > 0 ? 'TRIALING' : 'ACTIVE',
      expiresAt: o.expiresAt ?? null,
      trialEndsAt: o.trial ? new Date(Date.now() + SENTINEL_PLAN.trialDays * 86400_000) : null,
    };
    subscriptions.push(row);
    return row;
  });

  const entitlements = { activate, check: vi.fn(async () => ({ allowed: false })) };
  const razorpay = {
    configured: true,
    publicKeyId: 'rzp_test_x',
    createOrder: vi.fn(async () => ({ id: 'order_1', amount: 1, currency: 'INR' })),
    // Signature verification is exercised by its own suite; these tests are
    // about what happens AFTER a payment is proven genuine.
    verifyWebhookSignature: vi.fn(() => true),
    verifyPaymentSignature: vi.fn(() => true),
  };

  const service = new PaymentService(
    prisma as never,
    entitlements as never,
    { send: vi.fn(async () => undefined) } as never,
    { create: vi.fn(async () => undefined) } as never,
    razorpay as never,
  );

  return { service, subscriptions, claims, activate, entitlements, razorpay };
}

/** `fulfil` is private; the webhook is the real path that reaches it. */
function webhookBody(userId: string, itemId: string, paymentId: string) {
  return JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, notes: { userId, itemId } } } },
  });
}

describe('trial price', () => {
  it('is derived from the one-month term, not typed by hand', () => {
    // 2399 / 7 = 342.71/day, less 20%, rounded to a clean ₹5 step.
    const expected = Math.round(((SENTINEL_BASE_MONTHLY / 7) * 0.8) / 5) * 5;
    expect(SENTINEL_TRIAL.price).toBe(expected);
  });

  it('is ₹275 at the current one-month price', () => {
    expect(SENTINEL_BASE_MONTHLY).toBe(2399);
    expect(SENTINEL_TRIAL.price).toBe(275);
  });

  it('never costs more than the term it samples', () => {
    expect(SENTINEL_TRIAL.price).toBeLessThan(SENTINEL_BASE_MONTHLY);
  });

  it('is genuinely cheaper than seven days at the undiscounted rate', () => {
    expect(SENTINEL_TRIAL.price).toBeLessThan(SENTINEL_TRIAL.dailyRate * SENTINEL_TRIAL.days);
  });
});

describe('trial catalog entry', () => {
  it('is resolvable for checkout, so it fulfils through the normal path', () => {
    expect(catalogItem(SENTINEL_TRIAL.id)).toBeDefined();
  });

  it('is NOT in CATALOG — a zero-month row renders ₹Infinity/mo on /checkout', () => {
    expect(CATALOG.some((i) => i.id === SENTINEL_TRIAL.id)).toBe(false);
    for (const i of CATALOG) expect(i.months).toBeGreaterThan(0);
  });

  it('grants days, not months', () => {
    expect(TRIAL_ITEM.days).toBe(7);
    expect(TRIAL_ITEM.months).toBe(0);
  });

  it('charges what the shared pricing says', () => {
    expect(TRIAL_ITEM.amountInr).toBe(SENTINEL_TRIAL.price);
  });

  it('is marked one-time and names the metric that records the claim', () => {
    expect(TRIAL_ITEM.oncePerUser).toBe(true);
    expect(TRIAL_ITEM.claimMetric).toBe(TRIAL_CLAIM_METRIC);
  });
});

describe('the trial can only be claimed once', () => {
  it('refuses a second checkout before any order is created', async () => {
    const { service, razorpay } = makeService({
      claims: [`u1::${TRIAL_CLAIM_METRIC}::${TRIAL_PERIOD_KEY}`],
    });
    await expect(service.createCheckout('u1', SENTINEL_TRIAL.id)).rejects.toThrow(/already used/i);
    // The point of the early gate: no money moved.
    expect(razorpay.createOrder).not.toHaveBeenCalled();
  });

  it('lets a first-time account through', async () => {
    const { service, razorpay } = makeService();
    await expect(service.createCheckout('u1', SENTINEL_TRIAL.id)).resolves.toBeDefined();
    expect(razorpay.createOrder).toHaveBeenCalledOnce();
  });

  it('does not grant a second trial even if two payments reach fulfilment', async () => {
    const { service, subscriptions, activate } = makeService();
    await service.handleWebhook(webhookBody('u1', SENTINEL_TRIAL.id, 'pay_1'), 'sig');
    await service.handleWebhook(webhookBody('u1', SENTINEL_TRIAL.id, 'pay_2'), 'sig');
    expect(activate).toHaveBeenCalledOnce();
    expect(subscriptions).toHaveLength(1);
  });

  it('is still idempotent on the payment id, as every other item is', async () => {
    const { service, activate } = makeService();
    await service.handleWebhook(webhookBody('u1', SENTINEL_TRIAL.id, 'pay_1'), 'sig');
    await service.handleWebhook(webhookBody('u1', SENTINEL_TRIAL.id, 'pay_1'), 'sig');
    expect(activate).toHaveBeenCalledOnce();
  });

  it('does not consume the claim when a FULL TERM is bought', async () => {
    const { service, claims } = makeService();
    await service.handleWebhook(webhookBody('u1', 'sentinel_1m', 'pay_1'), 'sig');
    expect(claims.size).toBe(0);
  });
});

describe('what the trial actually grants', () => {
  it('expires in seven days, not a month', async () => {
    const { service, subscriptions } = makeService();
    const before = Date.now();
    await service.handleWebhook(webhookBody('u1', SENTINEL_TRIAL.id, 'pay_1'), 'sig');

    const expiresAt = subscriptions[0]!.expiresAt as Date;
    const days = (expiresAt.getTime() - before) / 86400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('restates trialEndsAt from the term PAID FOR, not from Plan.trialDays', async () => {
    // activate() derives trialEndsAt from a seed value. Editing the seed must
    // never silently change what a charge buys, so fulfil overwrites it.
    const { service, subscriptions } = makeService();
    await service.handleWebhook(webhookBody('u1', SENTINEL_TRIAL.id, 'pay_1'), 'sig');
    const row = subscriptions[0]!;
    expect(row.trialEndsAt).toEqual(row.expiresAt);
  });

  it('is activated as a trial, so entitlements report it as one', async () => {
    const { service, activate } = makeService();
    await service.handleWebhook(webhookBody('u1', SENTINEL_TRIAL.id, 'pay_1'), 'sig');
    expect(activate).toHaveBeenCalledWith('u1', 'sentinel_pro', expect.objectContaining({ trial: true }));
  });

  it('records the Razorpay payment id, so it is auditable and idempotent', async () => {
    const { service, subscriptions } = makeService();
    await service.handleWebhook(webhookBody('u1', SENTINEL_TRIAL.id, 'pay_1'), 'sig');
    expect(subscriptions[0]!.billingReference).toBe('pay_1');
    expect(subscriptions[0]!.billingProvider).toBe('razorpay');
  });

  it('still grants MONTHS for a normal term', async () => {
    const { service, activate } = makeService();
    await service.handleWebhook(webhookBody('u1', 'sentinel_3m', 'pay_1'), 'sig');
    expect(activate).toHaveBeenCalledWith('u1', 'sentinel_pro', expect.objectContaining({ trial: false }));
  });
});

describe('eligibility', () => {
  it('is available to a fresh account', async () => {
    const { service } = makeService();
    await expect(service.trialStatus('u1')).resolves.toEqual({ eligible: true, reason: 'available' });
  });

  it('reports a consumed claim', async () => {
    const { service } = makeService({ claims: [`u1::${TRIAL_CLAIM_METRIC}::${TRIAL_PERIOD_KEY}`] });
    await expect(service.trialStatus('u1')).resolves.toEqual({ eligible: false, reason: 'already_claimed' });
  });

  it('does not sell a trial to someone who already has Sentinel', async () => {
    const { service, entitlements } = makeService();
    entitlements.check = vi.fn(async () => ({ allowed: true })) as never;
    await expect(service.trialStatus('u1')).resolves.toEqual({
      eligible: false,
      reason: 'already_subscribed',
    });
  });

  it('survives the subscription it granted expiring — the claim is durable', async () => {
    // The failure this prevents: enforcing "once" by looking for a LIVE
    // subscription makes the offer repeatable the moment the first one lapses.
    const { service, claims } = makeService();
    await service.handleWebhook(webhookBody('u1', SENTINEL_TRIAL.id, 'pay_1'), 'sig');
    expect(claims.has(`u1::${TRIAL_CLAIM_METRIC}::${TRIAL_PERIOD_KEY}`)).toBe(true);
    await expect(service.trialStatus('u1')).resolves.toMatchObject({ eligible: false });
  });
});

describe('the public catalog leaks no account state', () => {
  it('carries the trial price but no eligibility', () => {
    const { service } = makeService();
    const body = service.catalog();
    expect(body.trial.amountLabel).toBe('₹275');
    expect(JSON.stringify(body)).not.toMatch(/eligib|userId|claim/i);
  });
});
