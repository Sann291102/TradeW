/**
 * The migration history this package SHIPS, as a list of names.
 *
 * ── WHY A RUNTIME EXPORT AND NOT JUST A FOLDER ────────────────────────────
 *
 * `prisma migrate deploy` is a deploy-time step, and nothing at runtime used
 * to check that it had actually been run. When it had not, the failure did not
 * look like a missing migration: Prisma selects every column a model declares,
 * so `user.findUnique()` against a database missing one column throws P2022,
 * which reaches the browser as a bare HTTP 500 "Internal server error" on
 * SIGN-IN. Every account, every browser, no clue in the response.
 *
 * That was reported as "internal server error while trying to login" and is
 * exactly what this exists to make impossible to misdiagnose: `services/api`
 * reads this list at boot, compares it against the `_prisma_migrations` rows
 * in the database it is actually pointed at, and says so.
 *
 * The list is read from disk rather than generated into a constant so it can
 * never disagree with the folder — a hardcoded array is one rebase away from
 * being a lie.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Locate `prisma/migrations` by walking up from this module.
 *
 * Two layouts have to work: `src/` under ts-node, and `dist/` in a build. Both
 * sit one level below the package root, but the search walks a few levels for
 * safety rather than hardcoding `..` and breaking on the next output-dir
 * change. Returns null when the folder is absent (a consumer that vendored
 * only `dist/`), which callers must treat as "cannot tell", never as "none".
 */
export function findMigrationsDir(startDir: string = __dirname): string | null {
  let dir = resolve(startDir);
  for (let hop = 0; hop < 6; hop += 1) {
    const candidate = join(dir, 'prisma', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Every migration in the folder, sorted — which for Prisma's timestamp-prefixed
 * names is also apply order.
 *
 * A directory without a `migration.sql` is skipped rather than reported: Prisma
 * does not record it either, so counting it would produce a permanently
 * "pending" migration that no command can ever apply.
 */
export function listShippedMigrations(dir: string | null = findMigrationsDir()): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'migration.sql')))
    .map((entry) => entry.name)
    .sort();
}
