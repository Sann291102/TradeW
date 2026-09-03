import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { MigrationStatus, readMigrationStatus, remedyFor } from './migration-status';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * The migration verdict from boot, for anyone who needs to explain a later
   * failure. Null until `onModuleInit` has run, and after a boot where the
   * database was unreachable — "not checked" is deliberately distinct from
   * "checked and fine".
   */
  migrationStatus: MigrationStatus | null = null;

  async onModuleInit() {
    // Fault-tolerant boot: a DB outage must not crash-loop the whole API.
    // Endpoints that don't touch the DB (health, static plan lookups once
    // cached) keep working; DB-backed routes fail per-request with a clear
    // error instead of the process refusing to start.
    try {
      await this.$connect();
    } catch (err) {
      console.warn(`[api] database unavailable at boot — DB-backed routes will error until it recovers: ${err}`);
      return;
    }
    await this.reportMigrationStatus();
  }

  /**
   * Say — once, at boot, in the log an operator is already reading — whether
   * the database matches the schema this build was compiled against.
   *
   * ── WHY THIS DOES NOT ABORT BOOT ──────────────────────────────────────────
   *
   * For the same reason `$connect` above does not: this process serves routes
   * that never touch the un-migrated table, and a rolling deploy legitimately
   * starts new code a beat before the migration job finishes. Refusing to boot
   * would convert a recoverable, self-healing minute into an outage. What was
   * actually missing was not a hard stop, it was ANY statement of the problem:
   * an un-migrated database used to announce itself only as HTTP 500
   * "Internal server error" on sign-in. `AllExceptionsFilter` completes the
   * pair by naming it in the response too.
   */
  private async reportMigrationStatus(): Promise<void> {
    const status = await readMigrationStatus(this);
    this.migrationStatus = status;

    if (status.state === 'ok') {
      this.logger.log(`database schema up to date (${status.applied} migrations applied)`);
      return;
    }
    if (status.state === 'unknown') {
      this.logger.warn(`could not verify the database schema version: ${status.reason}`);
      return;
    }

    const pending = status.pending;
    const headline =
      status.state === 'uninitialised'
        ? `DATABASE HAS NEVER BEEN MIGRATED — all ${pending.length} migration(s) are outstanding.`
        : status.state === 'failed'
          ? `DATABASE HAS A FAILED MIGRATION — it is part-applied: ${status.failed.join(', ')}.`
          : `DATABASE SCHEMA IS OUT OF DATE — ${pending.length} migration(s) have not been applied.`;

    this.logger.error(
      [
        headline,
        `Outstanding: ${pending.join(', ')}`,
        'Until this is fixed, every route that reads an un-migrated table fails with HTTP 500 — SIGN-IN INCLUDED, ' +
          'because it reads the User table first.',
        remedyFor(status),
      ].join('\n  '),
    );
  }

  async onModuleDestroy() { await this.$disconnect().catch(() => undefined); }
}
