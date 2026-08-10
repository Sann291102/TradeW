import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaderElectionService } from './leader-election';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Leader election decides whether the paper matching engine runs. Get it wrong
 * in the permissive direction and two instances fill the same resting order
 * twice — a duplicated position on a user's book. So the properties asserted
 * here are the ones where "fails safe" and "fails open" differ:
 *
 *  · A process that could not renew must STOP being leader once its own
 *    remembered deadline passes, whether the database said no or said nothing
 *    at all. A paused or partitioned process cannot tell those apart, and the
 *    only safe reading of both is "I am not the leader".
 *  · A database ERROR must not cost leadership immediately (a one-second blip
 *    would otherwise stop order matching), but must not extend it either.
 *  · An empty result set from the acquisition statement means someone else
 *    holds the lease, and leadership must drop at once rather than coasting to
 *    our own expiry — we know we lost, so waiting is a window where two
 *    processes both believe they lead.
 *  · Releasing must only ever delete OUR row.
 *
 * Backed by a structural PrismaService stub over the two raw-SQL calls the
 * service makes. Time is controlled with fake timers rather than by sleeping,
 * so expiry is asserted exactly at the boundary instead of approximately.
 */

type QueryResult = Array<{ expiresAt: Date }>;

interface Stub {
  prisma: PrismaService;
  /** What the next acquisition attempt does. */
  setAcquire(fn: () => QueryResult | Promise<QueryResult>): void;
  queryCalls: number;
  deletes: Array<{ sql: string; values: unknown[] }>;
}

function stubPrisma(): Stub {
  let acquire: () => QueryResult | Promise<QueryResult> = () => [{ expiresAt: new Date() }];
  const state: Stub = {
    queryCalls: 0,
    deletes: [],
    setAcquire(fn) {
      acquire = fn;
    },
    prisma: {
      async $queryRaw() {
        state.queryCalls += 1;
        return acquire();
      },
      async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        state.deletes.push({ sql: strings.join('?'), values });
        return 1;
      },
    } as unknown as PrismaService,
  };
  return state;
}

/** Matches the service's own defaults; kept local so the spec states the
 *  relationship it depends on rather than importing a constant that could
 *  change underneath it. */
const TTL_MS = 30_000;

describe('LeaderElectionService — acquiring and holding', () => {
  let stub: Stub;
  let svc: LeaderElectionService;

  beforeEach(() => {
    vi.useFakeTimers();
    stub = stubPrisma();
    svc = new LeaderElectionService(stub.prisma);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is not leader for a job it never registered', () => {
    expect(svc.isLeader('matching-engine')).toBe(false);
  });

  it('is not leader before the first acquisition completes', () => {
    svc.register('matching-engine');
    expect(svc.isLeader('matching-engine')).toBe(false);
  });

  it('becomes leader when the statement returns a row', async () => {
    svc.register('matching-engine');
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.isLeader('matching-engine')).toBe(true);
  });

  it('does not become leader when another instance holds the lease', async () => {
    stub.setAcquire(() => []);
    svc.register('matching-engine');
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.isLeader('matching-engine')).toBe(false);
  });

  it('reports only jobs it currently holds', async () => {
    svc.register('matching-engine');
    svc.register('settlement-sweep');
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.heldJobs().sort()).toEqual(['matching-engine', 'settlement-sweep']);
  });
});

describe('LeaderElectionService — losing leadership', () => {
  let stub: Stub;
  let svc: LeaderElectionService;

  beforeEach(async () => {
    vi.useFakeTimers();
    stub = stubPrisma();
    svc = new LeaderElectionService(stub.prisma);
    svc.register('matching-engine');
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.isLeader('matching-engine')).toBe(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops leadership immediately once another instance takes the lease', async () => {
    stub.setAcquire(() => []);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(svc.isLeader('matching-engine')).toBe(false);
  });

  it('keeps leadership through a brief database error — a blip must not stop matching', async () => {
    stub.setAcquire(() => {
      throw new Error('connection reset');
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(svc.isLeader('matching-engine')).toBe(true);
  });

  it('gives up leadership once the lease lapses during a sustained outage', async () => {
    stub.setAcquire(() => {
      throw new Error('connection reset');
    });
    await vi.advanceTimersByTimeAsync(TTL_MS + 1_000);
    // This is the property that makes a local check safe: no successful renewal
    // has happened, so the process stands down on its own without needing to be
    // told — which is exactly the case a partitioned instance is in.
    expect(svc.isLeader('matching-engine')).toBe(false);
  });

  it('treats the expiry as a hard boundary, not a hint', async () => {
    stub.setAcquire(() => {
      throw new Error('down');
    });
    // One millisecond before the deadline the process is still the leader...
    await vi.advanceTimersByTimeAsync(TTL_MS - 1);
    expect(svc.isLeader('matching-engine')).toBe(true);
    // ...and at the deadline it is not.
    await vi.advanceTimersByTimeAsync(1);
    expect(svc.isLeader('matching-engine')).toBe(false);
  });

  it('recovers leadership once the database comes back', async () => {
    stub.setAcquire(() => {
      throw new Error('down');
    });
    await vi.advanceTimersByTimeAsync(TTL_MS + 1_000);
    expect(svc.isLeader('matching-engine')).toBe(false);

    stub.setAcquire(() => [{ expiresAt: new Date() }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(svc.isLeader('matching-engine')).toBe(true);
  });
});

describe('LeaderElectionService — shutdown and configuration', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.JOB_LEASE_RENEW_MS;
    delete process.env.JOB_LEASE_TTL_MS;
  });

  it('releases held leases on shutdown, scoped to this holder', async () => {
    vi.useFakeTimers();
    const stub = stubPrisma();
    const svc = new LeaderElectionService(stub.prisma);
    svc.register('matching-engine');
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    await svc.onModuleDestroy();

    expect(stub.deletes).toHaveLength(1);
    expect(stub.deletes[0].sql).toContain('DELETE FROM "JobLease"');
    // The holder id is bound as a parameter, so a stale process can never
    // delete the row of whoever succeeded it.
    expect(stub.deletes[0].sql).toContain('"holder" =');
    expect(svc.isLeader('matching-engine')).toBe(false);
  });

  it('issues no delete when it held nothing', async () => {
    vi.useFakeTimers();
    const stub = stubPrisma();
    stub.setAcquire(() => []);
    const svc = new LeaderElectionService(stub.prisma);
    svc.register('matching-engine');
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    await svc.onModuleDestroy();
    expect(stub.deletes).toHaveLength(0);
  });

  it('refuses to start if renewal is not comfortably faster than expiry', () => {
    // A renew interval at or above the TTL means the lease lapses between
    // renewals by design: leadership flaps and two instances regularly overlap.
    // Failing at construction is the only honest response — the alternative is
    // a service that reports mutual exclusion it is not providing.
    process.env.JOB_LEASE_TTL_MS = '5000';
    process.env.JOB_LEASE_RENEW_MS = '5000';
    vi.resetModules();
    return import('./leader-election').then(({ LeaderElectionService: Reloaded }) => {
      expect(() => new Reloaded(stubPrisma().prisma)).toThrow(/must be well below/);
    });
  });
});
