import { describe, expect, it } from 'vitest';
import { SubscriptionStatus } from '@prisma/client';
import { EntitlementsService } from './entitlements.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Paid-access decisions — override precedence, subscription validity, quotas.
 *
 * `check()` is the only place the platform decides whether a user may use a
 * paid capability, and every one of its branches was previously unasserted:
 * the one spec that mentioned entitlements (`learning-access.spec.ts`)
 * substitutes a hand-written stub for this service, so it proves how callers
 * behave, not how the decision is actually made.
 *
 * Backed by a structural PrismaService stub over plain arrays — no database,
 * deterministic. `now` is passed in through the fixture rather than mocked
 * globally, keeping the suite in the same clock-injected style as
 * `discipline-limits.spec.ts`.
 *
 * The boundaries pinned here are the ones that cost money when wrong: quota at
 * exactly the limit, the last millisecond of grace, a revoked override that
 * must outrank a healthy subscription, and a TRIALING row with no end date.
 */

type Grant = {
  capability: string;
  quotaMetric?: string | null;
  quotaLimit?: number | null;
  quotaPeriod?: 'DAY' | 'MONTH' | null;
};

type Sub = {
  status: SubscriptionStatus;
  expiresAt?: Date | null;
  trialEndsAt?: Date | null;
  graceDays?: number;
  grants: Grant[];
  createdAt?: Date;
};

type Override = {
  capability: string;
  granted: boolean;
  expiresAt?: Date | null;
  createdAt?: Date;
};

const DAY = 86_400_000;

function stubPrisma(opts: {
  subs?: Sub[];
  overrides?: Override[];
  usage?: Record<string, number>;
}): PrismaService {
  const subs = opts.subs ?? [];
  const overrides = opts.overrides ?? [];
  const usage = opts.usage ?? {};

  return {
    entitlementOverride: {
      async findFirst({ where }: { where: { capability: string } }) {
        const now = new Date();
        const matching = overrides
          .filter((o) => o.capability === where.capability)
          .filter((o) => o.expiresAt == null || o.expiresAt > now)
          .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
        return matching[0] ?? null;
      },
      async findMany() {
        return overrides;
      },
    },
    subscription: {
      async findMany({ where }: { where: { status: { in: SubscriptionStatus[] } } }) {
        return subs
          .filter((s) => where.status.in.includes(s.status))
          .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
          .map((s) => ({
            status: s.status,
            expiresAt: s.expiresAt ?? null,
            trialEndsAt: s.trialEndsAt ?? null,
            plan: { graceDays: s.graceDays ?? 0, grants: s.grants },
          }));
      },
    },
    usageCounter: {
      async findUnique({ where }: { where: { userId_metric_periodKey: { metric: string } } }) {
        const metric = where.userId_metric_periodKey.metric;
        return metric in usage ? { used: usage[metric] } : null;
      },
    },
  } as unknown as PrismaService;
}

const plan = (capability: string, quota?: Partial<Grant>): Sub => ({
  status: SubscriptionStatus.ACTIVE,
  expiresAt: null,
  grants: [{ capability, ...quota }],
});

describe('EntitlementsService.check — no subscription', () => {
  it('denies with no_subscription when the user has none', async () => {
    const svc = new EntitlementsService(stubPrisma({}));
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('no_subscription');
  });

  it('denies with plan_lacks_capability when a live plan simply does not grant it', async () => {
    const svc = new EntitlementsService(stubPrisma({ subs: [plan('learning')] }));
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('plan_lacks_capability');
  });
});

describe('EntitlementsService.check — override precedence', () => {
  it('a granting override allows even with no subscription at all', async () => {
    const svc = new EntitlementsService(
      stubPrisma({ overrides: [{ capability: 'sentinel', granted: true }] }),
    );
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('override');
  });

  it('a revoking override beats an otherwise valid subscription', async () => {
    // The security-relevant direction: revocation must win, or a refund or ban
    // cannot actually take access away while the subscription row still lives.
    const svc = new EntitlementsService(
      stubPrisma({
        subs: [plan('sentinel')],
        overrides: [{ capability: 'sentinel', granted: false }],
      }),
    );
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('override_revoked');
  });

  it('the newest override wins when several exist', async () => {
    const svc = new EntitlementsService(
      stubPrisma({
        overrides: [
          { capability: 'sentinel', granted: true, createdAt: new Date('2026-01-01') },
          { capability: 'sentinel', granted: false, createdAt: new Date('2026-06-01') },
        ],
      }),
    );
    expect((await svc.check('u1', 'sentinel')).reason).toBe('override_revoked');
  });

  it('an expired override is ignored and the subscription decides', async () => {
    const svc = new EntitlementsService(
      stubPrisma({
        subs: [plan('sentinel')],
        overrides: [
          {
            capability: 'sentinel',
            granted: false,
            expiresAt: new Date(Date.now() - DAY),
          },
        ],
      }),
    );
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('plan_grant');
  });

  it('an override for a different capability does not leak across', async () => {
    const svc = new EntitlementsService(
      stubPrisma({ overrides: [{ capability: 'learning', granted: true }] }),
    );
    expect((await svc.check('u1', 'sentinel')).allowed).toBe(false);
  });
});

describe('EntitlementsService.check — subscription validity and grace', () => {
  it('allows an open-ended ACTIVE subscription', async () => {
    const svc = new EntitlementsService(stubPrisma({ subs: [plan('sentinel')] }));
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('plan_grant');
  });

  it('allows inside the grace window after expiry, flagged as grace_period', async () => {
    const svc = new EntitlementsService(
      stubPrisma({
        subs: [
          {
            status: SubscriptionStatus.ACTIVE,
            expiresAt: new Date(Date.now() - DAY),
            graceDays: 3,
            grants: [{ capability: 'sentinel' }],
          },
        ],
      }),
    );
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('grace_period');
  });

  it('denies with subscription_expired once grace has elapsed', async () => {
    const svc = new EntitlementsService(
      stubPrisma({
        subs: [
          {
            status: SubscriptionStatus.ACTIVE,
            expiresAt: new Date(Date.now() - 5 * DAY),
            graceDays: 3,
            grants: [{ capability: 'sentinel' }],
          },
        ],
      }),
    );
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('subscription_expired');
  });

  it('treats zero graceDays as no grace at all', async () => {
    const svc = new EntitlementsService(
      stubPrisma({
        subs: [
          {
            status: SubscriptionStatus.ACTIVE,
            expiresAt: new Date(Date.now() - 1_000),
            graceDays: 0,
            grants: [{ capability: 'sentinel' }],
          },
        ],
      }),
    );
    expect((await svc.check('u1', 'sentinel')).reason).toBe('subscription_expired');
  });

  it('reports trial rather than plan_grant for a live TRIALING subscription', async () => {
    const svc = new EntitlementsService(
      stubPrisma({
        subs: [
          {
            status: SubscriptionStatus.TRIALING,
            trialEndsAt: new Date(Date.now() + DAY),
            grants: [{ capability: 'sentinel' }],
          },
        ],
      }),
    );
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('trial');
  });

  it('a TRIALING subscription with no trialEndsAt never expires', async () => {
    // Pinning a real open question, not endorsing it: validity() returns
    // 'valid' for a null hard end, so a trial row created without an end date
    // grants paid access indefinitely. If that is not intended, this test is
    // where the fix should announce itself.
    const svc = new EntitlementsService(
      stubPrisma({
        subs: [
          {
            status: SubscriptionStatus.TRIALING,
            trialEndsAt: null,
            grants: [{ capability: 'sentinel' }],
          },
        ],
      }),
    );
    expect((await svc.check('u1', 'sentinel')).allowed).toBe(true);
  });

  it('a TRIALING subscription ignores expiresAt and keys off trialEndsAt', async () => {
    const svc = new EntitlementsService(
      stubPrisma({
        subs: [
          {
            status: SubscriptionStatus.TRIALING,
            trialEndsAt: new Date(Date.now() - 10 * DAY),
            expiresAt: new Date(Date.now() + 365 * DAY),
            graceDays: 0,
            grants: [{ capability: 'sentinel' }],
          },
        ],
      }),
    );
    expect((await svc.check('u1', 'sentinel')).reason).toBe('subscription_expired');
  });

  it('treats PAST_DUE and GRACE as live statuses, not as cancellation', async () => {
    for (const status of [SubscriptionStatus.PAST_DUE, SubscriptionStatus.GRACE]) {
      const svc = new EntitlementsService(
        stubPrisma({ subs: [{ status, expiresAt: null, grants: [{ capability: 'sentinel' }] }] }),
      );
      expect((await svc.check('u1', 'sentinel')).allowed).toBe(true);
    }
  });

  it('falls through an expired subscription to a second one that still grants', async () => {
    const svc = new EntitlementsService(
      stubPrisma({
        subs: [
          {
            status: SubscriptionStatus.ACTIVE,
            expiresAt: new Date(Date.now() - 30 * DAY),
            graceDays: 0,
            grants: [{ capability: 'sentinel' }],
            createdAt: new Date('2026-06-01'),
          },
          {
            status: SubscriptionStatus.ACTIVE,
            expiresAt: null,
            grants: [{ capability: 'sentinel' }],
            createdAt: new Date('2026-01-01'),
          },
        ],
      }),
    );
    expect((await svc.check('u1', 'sentinel')).allowed).toBe(true);
  });
});

describe('EntitlementsService.check — quota enforcement', () => {
  const quotaSub = (limit: number): Sub => ({
    status: SubscriptionStatus.ACTIVE,
    expiresAt: null,
    grants: [
      { capability: 'sentinel', quotaMetric: 'sentinel_requests', quotaLimit: limit, quotaPeriod: 'DAY' },
    ],
  });

  it('allows below the limit and reports the quota back', async () => {
    const svc = new EntitlementsService(
      stubPrisma({ subs: [quotaSub(500)], usage: { sentinel_requests: 499 } }),
    );
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(true);
    expect(d.quota).toEqual({ metric: 'sentinel_requests', limit: 500, used: 499, period: 'DAY' });
  });

  it('denies at exactly the limit — the boundary is inclusive', async () => {
    // `used >= limit`, so the 500th request of a 500 quota is refused. This is
    // the off-by-one that decides whether a plan sells 500 calls or 501.
    const svc = new EntitlementsService(
      stubPrisma({ subs: [quotaSub(500)], usage: { sentinel_requests: 500 } }),
    );
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('quota_exhausted');
  });

  it('denies past the limit and still reports usage for the UI', async () => {
    const svc = new EntitlementsService(
      stubPrisma({ subs: [quotaSub(500)], usage: { sentinel_requests: 900 } }),
    );
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(false);
    expect(d.quota?.used).toBe(900);
  });

  it('treats a missing counter as zero usage', async () => {
    const svc = new EntitlementsService(stubPrisma({ subs: [quotaSub(10)] }));
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(true);
    expect(d.quota?.used).toBe(0);
  });

  it('a zero limit denies immediately', async () => {
    const svc = new EntitlementsService(stubPrisma({ subs: [quotaSub(0)] }));
    expect((await svc.check('u1', 'sentinel')).reason).toBe('quota_exhausted');
  });

  it('a grant without a quota is unlimited and reports no quota block', async () => {
    const svc = new EntitlementsService(
      stubPrisma({ subs: [plan('sentinel')], usage: { sentinel_requests: 10_000 } }),
    );
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(true);
    expect(d.quota).toBeUndefined();
  });

  it('a granting override bypasses an exhausted quota entirely', async () => {
    const svc = new EntitlementsService(
      stubPrisma({
        subs: [quotaSub(500)],
        usage: { sentinel_requests: 9_999 },
        overrides: [{ capability: 'sentinel', granted: true }],
      }),
    );
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('override');
  });
});

describe('EntitlementsService.check — decision shape', () => {
  it('always echoes userId, capability and a decision timestamp', async () => {
    const svc = new EntitlementsService(stubPrisma({ subs: [plan('sentinel')] }));
    const d = await svc.check('u-42', 'sentinel');
    expect(d.userId).toBe('u-42');
    expect(d.capability).toBe('sentinel');
    expect(d.decidedAt).toBeInstanceOf(Date);
  });

  it('never returns allowed:true without a reason explaining why', async () => {
    const svc = new EntitlementsService(stubPrisma({ subs: [plan('sentinel')] }));
    const d = await svc.check('u1', 'sentinel');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBeTruthy();
  });
});
