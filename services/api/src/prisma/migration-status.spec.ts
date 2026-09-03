import { describe, expect, it } from 'vitest';
import { compareMigrations, readMigrationStatus, remedyFor } from './migration-status';

const finished = (name: string) => ({
  migration_name: name,
  finished_at: new Date('2026-09-01T00:00:00Z'),
  rolled_back_at: null,
});

describe('compareMigrations', () => {
  it('is ok when every shipped migration finished', () => {
    expect(compareMigrations(['a', 'b'], [finished('a'), finished('b')])).toEqual({ state: 'ok', applied: 2 });
  });

  it('ignores rows for migrations the repo no longer ships', () => {
    // A branch that dropped a migration must not be reported as broken; only
    // the other direction — shipped but not applied — is a problem.
    expect(compareMigrations(['a'], [finished('a'), finished('legacy')])).toEqual({ state: 'ok', applied: 2 });
  });

  it('reports an empty bookkeeping table as never migrated, not merely behind', () => {
    expect(compareMigrations(['a', 'b'], [])).toEqual({ state: 'uninitialised', pending: ['a', 'b'] });
  });

  it('names exactly the migrations the database is missing', () => {
    // The reported sign-in 500: the database was behind by the migration that
    // added the User columns Prisma then selected.
    expect(compareMigrations(['a', 'b', 'c'], [finished('a')])).toEqual({ state: 'pending', pending: ['b', 'c'] });
  });

  it('treats a started-but-unfinished migration as failed, and worse than pending', () => {
    const status = compareMigrations(
      ['a', 'b'],
      [finished('a'), { migration_name: 'b', finished_at: null, rolled_back_at: null }],
    );
    expect(status).toEqual({ state: 'failed', failed: ['b'], pending: ['b'] });
    expect(remedyFor(status)).toContain('migrate resolve');
  });

  it('counts a rolled-back migration as pending again, not applied', () => {
    expect(
      compareMigrations(
        ['a'],
        [{ migration_name: 'a', finished_at: new Date(), rolled_back_at: new Date() }],
      ),
    ).toEqual({ state: 'pending', pending: ['a'] });
  });

  it('cannot conclude anything when no migration folder was found', () => {
    // "I could not check" must never render as "your database is fine".
    expect(compareMigrations([], [])).toEqual({
      state: 'unknown',
      reason: 'no migration folder was found in @tradew/database',
    });
  });
});

describe('readMigrationStatus', () => {
  it('reads the verdict from _prisma_migrations', async () => {
    const client = { $queryRawUnsafe: async () => [finished('a')] as any };
    await expect(readMigrationStatus(client, ['a'])).resolves.toEqual({ state: 'ok', applied: 1 });
  });

  it('treats a missing bookkeeping table as never migrated', async () => {
    const client = {
      $queryRawUnsafe: async () => {
        throw new Error('relation "_prisma_migrations" does not exist');
      },
    };
    await expect(readMigrationStatus(client, ['a'])).resolves.toEqual({ state: 'uninitialised', pending: ['a'] });
  });

  it('degrades to unknown rather than throwing when the query fails', async () => {
    // This check explains failures; it must never be able to cause one.
    const client = {
      $queryRawUnsafe: async () => {
        throw new Error('connection refused');
      },
    };
    await expect(readMigrationStatus(client, ['a'])).resolves.toEqual({
      state: 'unknown',
      reason: 'connection refused',
    });
  });
});
