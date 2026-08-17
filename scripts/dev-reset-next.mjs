#!/usr/bin/env node
/**
 * Quarantine the Next.js dev caches for apps/web and apps/admin.
 *
 * ── WHAT THIS RECOVERS FROM ────────────────────────────────────────────────
 *
 *   Server Error
 *   Error: Cannot find module './193.js'
 *   Require stack:
 *   - apps/admin/.next/server/webpack-runtime.js
 *   - apps/admin/.next/server/pages/_document.js
 *
 * `webpack-runtime.js` loads server chunks by NUMBER, from a manifest written
 * alongside them. When the manifest and the emitted chunk files disagree, the
 * runtime asks for a chunk that is not on disk and every route 500s — including
 * `/login`, which is why the app looks completely dead rather than partly broken.
 *
 * Observed 2026-08-17 on both apps at once: `.next/server/` held its manifests
 * and `webpack-runtime.js` but NOT ONE numbered chunk. The give-away that it was
 * never a code fault: `apps/admin` had no source changes at all that day, yet
 * failed identically, while `tsc --noEmit` passed and all 521 web+admin tests
 * were green.
 *
 * ── WHY IT HAPPENS, AND WHY THERE IS NO CODE FIX ───────────────────────────
 *
 * Both dev servers had been running for OVER 24 HOURS (started 08-16 22:56,
 * failed 08-17 22:4x) across a day of edits plus a branch switch, a `git stash`
 * that reverted 16 source files, the `stash pop` that restored them, and a merge.
 * Next's dev bundler rebuilds incrementally on every one of those events; enough
 * interleaved rebuilds and the chunk set stops matching the manifest that
 * describes it.
 *
 * So this is not a bug to fix in application code — it is a stale-cache failure
 * mode of long-lived dev servers. What CAN be fixed is the recovery: it had cost
 * time twice before this script existed, and the fix is unguessable from the
 * error text, which points at node internals and `Array.reduce`.
 *
 * Prevention, in order of effect:
 *   1. Restart the dev servers after branch switches, stashes and merges.
 *   2. Do not leave `next dev` running overnight, especially not for days.
 *   3. Never point two `next dev` processes at one app — they share `.next` and
 *      clobber each other's chunk numbering. (Not the cause on 2026-08-17: the
 *      process tree showed one clean chain per app. Still the other way in.)
 *
 * ── WHY MOVE AND NOT DELETE ────────────────────────────────────────────────
 *
 * Rule 1 of the workspace constitution: nothing gets deleted, superseded things
 * are moved aside. A build cache is regenerable and the rule is aimed at source,
 * but the rule says no exceptions and costs nothing to honour here — so each
 * cache is renamed with a timestamp and left for the user to clear. Existing
 * quarantines are listed on every run so they cannot pile up unnoticed.
 *
 * Usage:  npm run dev:reset      (stop the dev servers first — Windows will not
 *                                 rename a directory that a live process holds)
 */

import { existsSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = ['web', 'admin'];

/** Local date, not UTC — this name is read by a human next to their clock. */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

let moved = 0;
let blocked = 0;

for (const app of APPS) {
  const appDir = join(repoRoot, 'apps', app);
  if (!existsSync(appDir)) continue;

  const cache = join(appDir, '.next');
  if (!existsSync(cache)) {
    console.log(`  ${app.padEnd(6)} no .next — nothing to quarantine`);
    continue;
  }

  const target = join(appDir, `.next.stale-${stamp()}`);
  try {
    renameSync(cache, target);
    console.log(`  ${app.padEnd(6)} .next -> ${target.slice(repoRoot.length + 1)}`);
    moved++;
  } catch (err) {
    // EBUSY/EPERM on Windows means a live `next dev` still holds the directory.
    // Reported as the actionable instruction rather than a stack trace, because
    // this is the one failure a user of this script will actually hit.
    blocked++;
    console.error(
      `  ${app.padEnd(6)} COULD NOT MOVE (${err.code ?? err.message}) — stop the dev server for apps/${app} and re-run`,
    );
  }
}

// Surface what has accumulated. Nothing here is removed automatically; the point
// is that quarantines stay visible instead of quietly consuming disk.
const existing = [];
for (const app of APPS) {
  const appDir = join(repoRoot, 'apps', app);
  if (!existsSync(appDir)) continue;
  for (const entry of readdirSync(appDir)) {
    if (entry.startsWith('.next.') && statSync(join(appDir, entry)).isDirectory()) {
      existing.push(`apps/${app}/${entry}`);
    }
  }
}

if (existing.length) {
  console.log(`\n  ${existing.length} quarantined build director${existing.length === 1 ? 'y' : 'ies'}:`);
  for (const e of existing) console.log(`    ${e}`);
  console.log('  Delete them yourself when you no longer want them — this script never will.');
}

if (blocked > 0) {
  console.error('\n  Not all caches could be quarantined. Stop the dev servers and re-run.');
  process.exit(1);
}

console.log(
  moved > 0
    ? '\n  Done. Start the dev servers again; Next will rebuild from scratch (first load is slow).'
    : '\n  Nothing to do.',
);
