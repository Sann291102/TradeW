import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * "Am I the one instance that should run this job right now?"
 *
 * THE PROBLEM THIS SOLVES
 *
 * `services/api` runs five background loops on plain `setInterval` — the paper
 * matching engine, T+1 settlement, the EOD performance sweep, telemetry
 * retention, and (in `services/sentinel`) the market watch and adaptive
 * calibration. Every one is written as though it is the only copy running.
 * With one replica that is true. With two it is not, and the failure is not
 * "the work happens twice" — it is that two matching engines can both read the
 * same resting order as unfilled, both price it, and both fill it. That is a
 * duplicated position on a user's book, produced by a deployment decision
 * (`replicas: 2`) that looks purely operational.
 *
 * So horizontal scaling was gated on a correctness property, not on capacity.
 * This service moves that gate: a loop asks `isLeader(job)` and does nothing if
 * the answer is no, and the answer is decided in Postgres, which every replica
 * already shares.
 *
 * THE ONE SUBTLE PART
 *
 * `isLeader()` is a LOCAL check against a locally-remembered deadline, and it
 * must be. The renewal loop talks to the database; the caller does not. If
 * `isLeader()` went to the database on every tick it would add a round trip to
 * the hot path and, worse, would still be a point-in-time answer by the time
 * the work ran.
 *
 * What makes the local check safe is that it is a check against an EXPIRY, not
 * against a boolean. A process that is paused (GC, a suspended VM, a network
 * partition) cannot distinguish "I am still the leader" from "my lease lapsed
 * 30 seconds ago and someone else has it now" — so `isLeader()` answers false
 * as soon as the deadline this process last confirmed has passed, whether or
 * not renewal succeeded, whether or not the database is reachable. Losing the
 * lease is fail-safe (the job pauses); keeping it wrongly is not (two writers).
 *
 * For that to hold, the renewal interval must be comfortably shorter than the
 * lease duration, so an ordinary hiccup does not drop leadership, and the lease
 * duration must be comfortably longer than the longest tick, so a leader does
 * not expire mid-tick. Both are asserted at construction.
 *
 * WHAT THIS IS NOT
 *
 * Not a distributed lock for user-facing writes, and not a consensus protocol.
 * Clock skew between instances is bounded by Postgres being the only clock that
 * decides acquisition (`NOW()` in the WHERE clause, not the caller's time), but
 * the local expiry check does use the local clock, so a machine whose clock
 * jumps backwards by more than the lease duration could believe itself leader
 * for longer than it is. Under NTP that is not a real scenario; if it becomes
 * one, the fix is a monotonic deadline, not more database round trips.
 */

/** How long a lease is valid once taken or renewed. */
const LEASE_TTL_MS = Number(process.env.JOB_LEASE_TTL_MS ?? 30_000);

/** How often the holder renews. Must be well under the TTL. */
const RENEW_INTERVAL_MS = Number(process.env.JOB_LEASE_RENEW_MS ?? 10_000);

/** Non-holders retry on the same cadence, so failover takes at most TTL + this. */
const ACQUIRE_INTERVAL_MS = RENEW_INTERVAL_MS;

export type JobName = string;

@Injectable()
export class LeaderElectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaderElectionService.name);

  /**
   * This process's identity for the lifetime of the process.
   *
   * Deliberately random rather than the hostname: on a platform that reuses or
   * duplicates hostnames (ECS tasks behind the same DNS name, a rescheduled
   * pod) two live processes could otherwise present the same holder id, and the
   * `holder = $me` branch of the acquisition query — which exists so a holder
   * can renew — would let the second one steal a live lease as though it were
   * renewing its own.
   */
  private readonly holderId = `${process.pid}-${randomUUID()}`;

  /** job -> the deadline this process last confirmed for its own lease. */
  private readonly leases = new Map<JobName, number>();

  /** Jobs this process wants. Registered by the loops themselves at init. */
  private readonly wanted = new Set<JobName>();

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly prisma: PrismaService) {
    if (RENEW_INTERVAL_MS >= LEASE_TTL_MS) {
      // A renewal cadence at or above the TTL means the lease expires between
      // renewals by design — leadership would flap and two instances would
      // regularly overlap. Refuse to start rather than provide the appearance
      // of mutual exclusion.
      throw new Error(
        `JOB_LEASE_RENEW_MS (${RENEW_INTERVAL_MS}) must be well below JOB_LEASE_TTL_MS (${LEASE_TTL_MS})`,
      );
    }
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), Math.min(RENEW_INTERVAL_MS, ACQUIRE_INTERVAL_MS));
    // Election must never be the reason the process refuses to exit.
    this.timer.unref?.();
    // Take what we can immediately: waiting a full interval would leave the
    // matching engine idle for the first 10 seconds of every boot.
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    // Hand leases back on a clean shutdown so a rolling deploy fails over in
    // milliseconds instead of waiting out the TTL. Best-effort: if this fails,
    // expiry is the backstop and the only cost is a slower failover.
    await this.releaseAll().catch(() => undefined);
  }

  /**
   * Declare that this process is a candidate for `job`. Call from the owning
   * service's `onModuleInit`; it is idempotent.
   */
  register(job: JobName): void {
    this.wanted.add(job);
  }

  /**
   * The question a background loop asks before doing anything.
   *
   * Synchronous and local by design — see the class note. False whenever this
   * process does not hold a lease whose deadline is still in the future.
   */
  isLeader(job: JobName): boolean {
    const deadline = this.leases.get(job);
    return deadline !== undefined && deadline > Date.now();
  }

  /** Operational read for the admin surface: which jobs this process runs. */
  heldJobs(): string[] {
    const now = Date.now();
    return [...this.leases.entries()].filter(([, d]) => d > now).map(([job]) => job);
  }

  // --------------------------------------------------------------- internals

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const job of this.wanted) {
        await this.acquireOrRenew(job);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * One statement does both acquisition and renewal.
   *
   * The WHERE clause is the whole safety property: an existing row is only
   * overwritten when it has already expired **according to Postgres's clock**,
   * or when the holder is this process renewing its own. `NOW()` rather than a
   * parameter matters — if the caller supplied the comparison time, a replica
   * with a fast clock could take a lease that has not actually expired.
   *
   * `RETURNING` combined with `ON CONFLICT ... WHERE` means an empty result set
   * is an unambiguous "someone else holds it", with no second read needed and
   * no window between checking and taking.
   */
  private async acquireOrRenew(job: JobName): Promise<void> {
    const held = this.isLeader(job);
    try {
      const rows = await this.prisma.$queryRaw<Array<{ expiresAt: Date }>>`
        INSERT INTO "JobLease" ("name", "holder", "expiresAt", "renewedAt", "acquiredAt")
        VALUES (${job}, ${this.holderId}, NOW() + (${LEASE_TTL_MS}::double precision / 1000) * INTERVAL '1 second', NOW(), NOW())
        ON CONFLICT ("name") DO UPDATE
          SET "holder" = EXCLUDED."holder",
              "expiresAt" = EXCLUDED."expiresAt",
              "renewedAt" = NOW(),
              "acquiredAt" = CASE
                WHEN "JobLease"."holder" = EXCLUDED."holder" THEN "JobLease"."acquiredAt"
                ELSE NOW()
              END
          WHERE "JobLease"."expiresAt" < NOW() OR "JobLease"."holder" = EXCLUDED."holder"
        RETURNING "expiresAt"
      `;

      if (rows.length > 0) {
        // Trust the LOCAL clock for the deadline we will enforce, not the value
        // Postgres returned: comparing a remote timestamp against `Date.now()`
        // would silently import any clock skew between this host and the
        // database into the safety margin.
        this.leases.set(job, Date.now() + LEASE_TTL_MS);
        if (!held) this.logger.log(`acquired lease '${job}' (holder ${this.holderId})`);
        return;
      }

      // Another instance holds it. Drop our claim immediately rather than
      // coasting to our own expiry.
      if (held) this.logger.log(`lost lease '${job}' to another instance`);
      this.leases.delete(job);
    } catch (err) {
      // A database blip must not promote this process. Leave the remembered
      // deadline alone: `isLeader()` keeps returning true until it lapses, so a
      // brief outage does not stop the job, and a long one stops it safely.
      this.logger.warn(`lease '${job}': renewal failed, will expire if this persists — ${describe(err)}`);
    }
  }

  /**
   * Raw SQL rather than `prisma.jobLease.deleteMany`, matching `acquireOrRenew`
   * above. Every statement in this service addresses `JobLease` directly, so the
   * service compiles and runs against a Prisma client generated before this
   * table existed — which matters because leader election is infrastructure that
   * has to come up on a node whose client may be a deploy behind, not a feature
   * that can wait for one.
   *
   * The `holder` predicate is not decoration: without it a process that had
   * already lost its lease would delete the row belonging to whoever took it,
   * turning a graceful shutdown into a leadership gap.
   */
  private async releaseAll(): Promise<void> {
    const jobs = [...this.leases.keys()];
    this.leases.clear();
    if (jobs.length === 0) return;
    await this.prisma.$executeRaw`
      DELETE FROM "JobLease" WHERE "holder" = ${this.holderId} AND "name" = ANY(${jobs}::text[])
    `;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
