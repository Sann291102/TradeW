/**
 * Rebuild `@tradew/database` (Prisma Client + tsc dist/) only when its inputs
 * have actually changed since the last build.
 *
 * ── WHY THIS EXISTS INSTEAD OF ALWAYS REBUILDING ──────────────────────────
 *
 * `predev:api` (root package.json) runs this before every `npm run dev:api`
 * so that editing prisma/schema.prisma or packages/database/src and then
 * starting the API can never again compile against a stale Prisma Client or
 * a stale dist/ — the exact drift that produced 37 TypeScript errors on
 * 2026-09-06 (missing `UniverseInstrument`, missing `listShippedMigrations`).
 *
 * But `npm run start:all` launches every service concurrently, and several
 * of them (services/api, services/sentinel, services/market-data,
 * services/tradew-ai) instantiate PrismaClient at boot, which memory-maps
 * `node_modules/.prisma/client/query_engine-windows.dll.node` into their own
 * process. On Windows that file cannot be renamed/overwritten while another
 * process holds it open — `prisma generate` then fails with EPERM. An
 * unconditional regenerate on every `dev:api` start collides with whichever
 * sibling service got there first.
 *
 * The fix is not to schedule around the race — it is to not touch the file
 * at all when nothing changed, which is true on effectively every normal
 * `start:all` run. This does a cheap mtime comparison and only shells out to
 * `prisma generate` / `tsc` when schema.prisma or src/ are newer than the
 * last build's outputs.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function newestMtime(paths) {
  let newest = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const stat = statSync(p);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        const full = join(p, entry.name);
        if (entry.isDirectory()) {
          newest = Math.max(newest, newestMtime([full]));
        } else {
          newest = Math.max(newest, statSync(full).mtimeMs);
        }
      }
    } else {
      newest = Math.max(newest, stat.mtimeMs);
    }
  }
  return newest;
}

function oldestMtimeOrMissing(paths) {
  let oldest = Infinity;
  for (const p of paths) {
    if (!existsSync(p)) return 0; // a missing output is maximally stale
    oldest = Math.min(oldest, statSync(p).mtimeMs);
  }
  return oldest === Infinity ? 0 : oldest;
}

const inputs = [join(PKG_ROOT, 'prisma', 'schema.prisma'), join(PKG_ROOT, 'src')];

// The two derived artifacts this package produces, and the one npm generates
// alongside it. All three must be at least as new as the inputs above.
const PRISMA_CLIENT_INDEX = resolve(PKG_ROOT, '..', '..', 'node_modules', '.prisma', 'client', 'index.js');
const outputs = [join(PKG_ROOT, 'dist', 'index.js'), PRISMA_CLIENT_INDEX];

const inputTime = newestMtime(inputs);
const outputTime = oldestMtimeOrMissing(outputs);

if (outputTime > 0 && outputTime >= inputTime) {
  console.log('[@tradew/database] build up to date, skipping regenerate.');
  process.exit(0);
}

console.log('[@tradew/database] schema.prisma or src/ changed since last build — regenerating Prisma Client and dist/.');
const result = spawnSync('npm', ['run', 'build'], { cwd: PKG_ROOT, stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
