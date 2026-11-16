/**
 * Rebuild every workspace package that is consumed via its built `dist/`
 * (never its source) — but only the ones whose `dist/` is actually stale.
 *
 * ── THE PATTERN THIS CLOSES ────────────────────────────────────────────────
 *
 * `postinstall` (root package.json) already says why these packages must be
 * built before anything imports them: @tradew/types, @tradew/database,
 * @tradew/ai-core and @tradew/market-data are resolved by consumers through
 * their built `main`/`types`, and `dist/` is gitignored, so a clean checkout
 * has none of them until postinstall runs.
 *
 * postinstall only runs once, at `npm install`. Nothing rebuilds these
 * packages again as development continues — so editing
 * packages/market-data/src/universe/*.ts, or adding a field to
 * packages/types/src/market-data.ts, or adding a model to
 * packages/database/prisma/schema.prisma, leaves every consumer compiling
 * against whatever `dist/` happened to exist at the last `npm install`. That
 * is exactly how services/api hit 37 TypeScript errors (stale
 * @tradew/database) and services/sentinel independently hit 27 (stale
 * @tradew/types — OptionChainEntry missing fields that were added to src/
 * weeks after the last install) on 2026-09-06: same root cause, two
 * packages, discovered separately because nothing ties `dist/` freshness to
 * `src/` changes except a human remembering to rebuild.
 *
 * This script is the missing tie. It runs before `npm run start:all` spawns
 * any service (see scripts/start-all-with-tunnels.mjs) and rebuilds only
 * what changed, in the same dependency order postinstall uses.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Dependency order matters: market-data imports types, so types must be
 *  fresh (and built) before market-data's own build type-checks against it. */
const PACKAGES = [
  { workspace: '@tradew/types', dir: 'packages/types', extraInputs: [] },
  {
    workspace: '@tradew/database',
    dir: 'packages/database',
    // schema.prisma drives the generated Prisma Client, a second output this
    // package produces alongside dist/ — see packages/database/package.json.
    extraInputs: ['prisma/schema.prisma'],
    extraOutputs: [resolve(ROOT, 'node_modules', '.prisma', 'client', 'index.js')],
  },
  { workspace: '@tradew/ai-core', dir: 'packages/ai-core', extraInputs: [] },
  { workspace: '@tradew/market-data', dir: 'packages/market-data', extraInputs: [] },
  // The decision core. Consumers resolve it through dist/index.js while
  // `tsc --noEmit` and its own vitest both read src/, so a forgotten build
  // means the engine decides one way in the tests and another in the market
  // with every local signal green. That is a worse failure than a stale type,
  // which is why it belongs here rather than only on the predev hooks.
  { workspace: '@tradew/strategy-core', dir: 'packages/strategy-core', extraInputs: [] },
];

function newestMtime(paths) {
  let newest = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const stat = statSync(p);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        newest = Math.max(newest, newestMtime([join(p, entry.name)]));
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
    if (!existsSync(p)) return 0;
    oldest = Math.min(oldest, statSync(p).mtimeMs);
  }
  return oldest === Infinity ? 0 : oldest;
}

let anyFailed = false;

for (const pkg of PACKAGES) {
  const pkgRoot = join(ROOT, pkg.dir);
  const inputs = [join(pkgRoot, 'src'), ...(pkg.extraInputs ?? []).map((p) => join(pkgRoot, p))];
  const outputs = [join(pkgRoot, 'dist', 'index.js'), ...(pkg.extraOutputs ?? [])];

  const inputTime = newestMtime(inputs);
  const outputTime = oldestMtimeOrMissing(outputs);

  if (outputTime > 0 && outputTime >= inputTime) {
    console.log(`[fresh-packages] ${pkg.workspace}: up to date.`);
    continue;
  }

  console.log(`[fresh-packages] ${pkg.workspace}: src changed since last build — rebuilding...`);
  const result = spawnSync('npm', ['run', 'build', '-w', pkg.workspace], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    console.error(`[fresh-packages] ${pkg.workspace}: build FAILED.`);
    anyFailed = true;
    break; // downstream packages would fail to type-check against a broken one anyway
  }
}

process.exit(anyFailed ? 1 : 0);
