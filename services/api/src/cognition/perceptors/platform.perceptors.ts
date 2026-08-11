import { NewPercept, SenseContext } from '@tradew/ai-core';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaPerceptor, clamp01 } from './shared';

/**
 * The platform's own plumbing — the background work nobody watches.
 *
 * Everything here is infrastructure that fails quietly by design. A singleton
 * job whose lease expires does not error; it simply stops being held, and the
 * work it was doing stops happening. An authentication anomaly does not error
 * either — every individual failed login is a correct, expected response.
 *
 * These are separated from the `application` domain because the fix is
 * different in kind. An application percept sends someone to a stack trace; a
 * platform percept sends someone to a process, a container, or a security
 * decision.
 */

// ---------------------------------------------------------------------------

/**
 * Singleton jobs whose lease has lapsed with nobody taking it.
 *
 * `LeaderElectionService` makes losing a lease fail-safe: the job pauses rather
 * than risking two writers. That is the correct trade and it has a consequence
 * nobody is watching — a job can pause *indefinitely* if every replica has died
 * or wedged, and the platform stays up while the matching engine, settlement,
 * or the EOD sweep quietly does nothing.
 *
 * An expired lease within the ordinary renewal window is normal (the holder is
 * between renewals). Expired by a wide margin means nothing has come to take it,
 * which is the finding.
 */
export class JobLeasePerceptor extends PrismaPerceptor {
  /**
   * How far past expiry counts as abandoned. Well beyond the 30s TTL and 10s
   * renewal cadence in LeaderElectionService, so an ordinary failover — which
   * takes at most TTL + the acquire interval — never reads as a fault.
   */
  private static readonly ABANDONED_AFTER_MS = 2 * 60_000;

  constructor(prisma: PrismaService) {
    super(
      {
        id: 'platform.job-leases',
        domain: 'platform',
        label: 'Singleton job leases',
        description: 'Leases expired long enough that nothing has taken them. Losing a lease is fail-safe, so a stopped job produces no error at all.',
        cadence: 'interval',
        expectedIntervalMs: 60_000,
        emits: ['job_lease_abandoned'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const cutoff = new Date(context.until.getTime() - JobLeasePerceptor.ABANDONED_AFTER_MS);
    const abandoned = await this.prisma.jobLease.findMany({
      where: { expiresAt: { lt: cutoff } },
      select: { name: true, holder: true, expiresAt: true, renewedAt: true },
    });

    return abandoned.map((lease) => {
      const lapsedMs = context.until.getTime() - lease.expiresAt.getTime();
      return this.percept({
        kind: 'job_lease_abandoned',
        subject: { type: 'job', id: lease.name, label: lease.name },
        observedAt: context.until,
        // High floor: a background job that has stopped is one of the few
        // faults here that silently corrupts user-visible state over time —
        // unsettled trades, missing snapshots, unsent summaries.
        salience: clamp01(0.6 + lapsedMs / (30 * 60_000)),
        confidence: 1,
        features: { lapsedMs },
        summary: `Job '${lease.name}' has had no leader for ${Math.round(lapsedMs / 1000)}s (last holder ${lease.holder.slice(0, 8)})`,
        tags: ['platform', 'job', 'lease'],
      });
    });
  }
}

// ---------------------------------------------------------------------------

/**
 * Authentication anomalies from the audit trail.
 *
 * Every failed login is individually a correct response, which is exactly why
 * this needs a perceptor: the signal is in the *shape* of the failures, and no
 * single row carries it. Two shapes are worth separating, because they call for
 * different responses:
 *
 *   · **many failures spread across many IPs** — usually a broken client or a
 *     deploy that invalidated sessions. An engineering problem.
 *   · **many failures concentrated on few IPs** — credential stuffing. A
 *     security problem.
 *
 * A single "failed logins are up" signal cannot distinguish them, and the two
 * responses are almost opposites.
 */
export class AuthAnomalyPerceptor extends PrismaPerceptor {
  private static readonly MIN_FAILURES = 10;

  constructor(prisma: PrismaService) {
    super(
      {
        id: 'platform.auth-anomaly',
        domain: 'platform',
        label: 'Authentication anomalies',
        description: 'Failed-auth volume and its spread across source IPs — separates a broken client from credential stuffing.',
        cadence: 'interval',
        expectedIntervalMs: 5 * 60_000,
        emits: ['auth_failure_burst', 'auth_concentrated_source'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const failures = await this.prisma.auditEvent.findMany({
      where: {
        createdAt: { gte: context.since, lt: context.until },
        eventType: { contains: 'fail' },
      },
      select: { ip: true, eventType: true },
      take: 2_000,
    });
    if (failures.length < AuthAnomalyPerceptor.MIN_FAILURES) return [];

    const byIp = new Map<string, number>();
    for (const failure of failures) {
      const ip = failure.ip ?? 'unknown';
      byIp.set(ip, (byIp.get(ip) ?? 0) + 1);
    }
    const top = [...byIp.entries()].sort((a, b) => b[1] - a[1])[0];
    const concentration = top[1] / failures.length;
    // Over 60% from one address is not a broken client population.
    const concentrated = concentration > 0.6 && byIp.size < 5;

    return [
      this.percept({
        kind: concentrated ? 'auth_concentrated_source' : 'auth_failure_burst',
        subject: concentrated
          ? { type: 'ip', id: top[0], label: top[0] }
          : { type: 'subsystem', id: 'auth', label: 'Authentication' },
        observedAt: context.until,
        salience: concentrated ? 0.85 : clamp01(0.3 + failures.length / 200),
        confidence: this.sampleConfidence(failures.length, 20),
        features: { failures: failures.length, distinctIps: byIp.size, topIpShare: concentration },
        summary: concentrated
          ? `${top[1]} of ${failures.length} auth failures from a single address (${top[0]})`
          : `${failures.length} auth failures across ${byIp.size} addresses`,
        occurrences: failures.length,
        tags: ['platform', 'auth', concentrated ? 'security' : 'anomaly'],
      }),
    ];
  }
}

export function platformPerceptors(prisma: PrismaService) {
  return [new JobLeasePerceptor(prisma), new AuthAnomalyPerceptor(prisma)];
}
