/**
 * Rebuild `@tradew/strategy-core`'s `dist/` only when `src/` has changed.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * This package is consumed through `main: dist/index.js`, so every service
 * that imports it — `services/api`'s autonomous engine, `services/sentinel`'s
 * rules and setups — reads the BUILT output, not the source. Edit `src/` and
 * start a service without rebuilding, and it runs the previous version of the
 * decision core while `tsc --noEmit` and the package's own vitest (which reads
 * `src/`) both stay green.
 *
 * That is not a hypothetical: this repository has already lost a session to
 * `services/api` serving a stale `dist/main.js` while every signal was green,
 * and lost another to `@tradew/database`'s dist drifting from its schema. A
 * stale decision core is worse than either, because the symptom is an engine
 * making the right decision in the tests and a different one in the market.
 *
 * ── WHY IT IS CONDITIONAL ─────────────────────────────────────────────────
 *
 * Same reasoning as `@tradew/database`'s copy, which this deliberately
 * mirrors: `npm run start:all` boots several services at once, and an
 * unconditional build on each of their `predev` hooks means concurrent `tsc`
 * runs writing the same `dist/`. A cheap mtime comparison makes it a no-op on
 * effectively every normal boot.
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
        newest = Math.max(newest, entry.isDirectory() ? newestMtime([full]) : statSync(full).mtimeMs);
      }
    } else {
      newest = Math.max(newest, stat.mtimeMs);
    }
  }
  return newest;
}

const inputs = [join(PKG_ROOT, 'src'), join(PKG_ROOT, 'tsconfig.json')];
const output = join(PKG_ROOT, 'dist', 'index.js');

const inputTime = newestMtime(inputs);
const outputTime = existsSync(output) ? statSync(output).mtimeMs : 0;

if (outputTime > 0 && outputTime >= inputTime) {
  console.log('[@tradew/strategy-core] build up to date, skipping.');
  process.exit(0);
}

console.log('[@tradew/strategy-core] src/ changed since last build — rebuilding dist/.');
const result = spawnSync('npm', ['run', 'build'], { cwd: PKG_ROOT, stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
