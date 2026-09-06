/**
 * "Is the database this process is pointed at actually migrated?"
 *
 * ── THE FAILURE THIS ANSWERS ──────────────────────────────────────────────
 *
 * Prisma generates a SELECT listing every column a model declares. So a
 * database that is one migration behind does not degrade — it throws P2022
 * ("The column `User.<x>` does not exist in the current database") on the very
 * first read of that table. `AuthService.login()` starts with
 * `prisma.user.findUnique`, so the whole sign-in surface returns HTTP 500
 * "Internal server error" for every account, on every machine pointed at that
 * database. Nothing in the response, and nothing in the boot log, said the word
 * "migration".
 *
 * The comparison is a pure function so it can be tested without a database;
 * `readMigrationStatus` is the thin part that does the query.
 */
import { listShippedMigrations } from '@tradew/database';

/** One row of Prisma's own `_prisma_migrations` bookkeeping table. */
export interface AppliedMigrationRow {
  migration_name: string;
  /** Set when the migration ran to completion. NULL while it is running — or
   *  forever, if it failed partway. */
  finished_at: Date | null;
  /** Set by `prisma migrate resolve --rolled-back`. Such a migration is not
   *  applied, so it counts as pending again. */
  rolled_back_at: Date | null;
}

export type MigrationStatus =
  /** Every shipped migration is recorded as finished. */
  | { state: 'ok'; applied: number }
  /** No `_prisma_migrations` table: this database has never been migrated. */
  | { state: 'uninitialised'; pending: string[] }
  /** Migrations exist that the database has not applied. */
  | { state: 'pending'; pending: string[] }
  /** A migration started and never finished — the database is part-applied. */
  | { state: 'failed'; failed: string[]; pending: string[] }
  /** The check itself could not run. Never treated as a problem with the
   *  database: an unreadable check is not evidence of anything. */
  | { state: 'unknown'; reason: string };

/**
 * Compare what the repo ships against what the database recorded.
 *
 * `failed` is checked before `pending` because it is the worse state and the
 * one with a different remedy: pending needs `migrate deploy`, a failed
 * migration needs `migrate resolve` first or `deploy` will refuse to run
 * (P3009).
 */
export function compareMigrations(shipped: string[], applied: AppliedMigrationRow[]): MigrationStatus {
  if (shipped.length === 0) {
    return { state: 'unknown', reason: 'no migration folder was found in @tradew/database' };
  }

  const failed = applied
    .filter((row) => row.finished_at === null && row.rolled_back_at === null)
    .map((row) => row.migration_name);

  const finished = new Set(
    applied.filter((row) => row.finished_at !== null && row.rolled_back_at === null).map((row) => row.migration_name),
  );
  const pending = shipped.filter((name) => !finished.has(name));

  if (failed.length > 0) return { state: 'failed', failed, pending };
  if (pending.length === 0) return { state: 'ok', applied: finished.size };
  // Nothing recorded at all is reported separately: "you never ran the
  // migrations" and "you are three behind" are different mistakes.
  if (applied.length === 0) return { state: 'uninitialised', pending };
  return { state: 'pending', pending };
}

/** The exact commands that fix each state, so the log never leaves the reader
 *  to go and look them up. */
export function remedyFor(status: MigrationStatus): string {
  switch (status.state) {
    case 'failed':
      return (
        'Resolve the failed migration first — `npx prisma migrate resolve --rolled-back <name> ' +
        '--schema packages/database/prisma/schema.prisma` — then run `npm run db:migrate`.'
      );
    case 'uninitialised':
    case 'pending':
      return 'Run `npm run db:migrate` from the repo root (deployed databases: `npm run migrate:deploy -w @tradew/database`).';
    default:
      return '';
  }
}

interface MigrationQueryClient {
  $queryRawUnsafe<T>(query: string): Promise<T>;
}

/**
 * Read the status from a live client.
 *
 * `$queryRawUnsafe` with a fixed literal string, not user input — Prisma has no
 * model for its own bookkeeping table, and there is nothing to interpolate.
 * Any throw becomes `unknown`: this check exists to explain failures, so it
 * must never be able to cause one.
 */
export async function readMigrationStatus(
  client: MigrationQueryClient,
  shipped: string[] = listShippedMigrations(),
): Promise<MigrationStatus> {
  let rows: AppliedMigrationRow[];
  try {
    rows = await client.$queryRawUnsafe<AppliedMigrationRow[]>(
      'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Postgres 42P01 — the table is absent, which is itself the answer rather
    // than a failure of the check.
    if (/_prisma_migrations/.test(message) && /does not exist|42P01/i.test(message)) {
      return shipped.length > 0
        ? { state: 'uninitialised', pending: shipped }
        : { state: 'unknown', reason: 'no migration folder was found in @tradew/database' };
    }
    return { state: 'unknown', reason: message };
  }
  return compareMigrations(shipped, rows);
}
