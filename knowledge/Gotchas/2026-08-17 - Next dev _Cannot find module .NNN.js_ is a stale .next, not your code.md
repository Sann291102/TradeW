# Next dev "Cannot find module './NNN.js'" is a stale `.next`, not your code

**Date:** 2026-08-17 · **Cost:** two sessions before it was written down
**Fix:** `npm run dev:reset` (stop the dev servers first)

---

## Symptom

Every route on `apps/web` and/or `apps/admin` 500s, including `/login`, so the app
looks completely dead rather than partly broken:

```
Server Error
Error: Cannot find module './193.js'
Require stack:
- apps/admin/.next/server/webpack-runtime.js
- apps/admin/.next/server/pages/_document.js
- node_modules/next/dist/server/require.js
  … hot-middleware.js, hot-reloader-webpack.js, setup-dev-bundler.js
```

The chunk number varies (`./193.js`, `./135.js`, `./vendor-chunks/framer-motion.js`).
The call stack points at node internals and `Array.reduce`, which is why the error
text is no help at all.

## What it actually is

`webpack-runtime.js` loads server chunks **by number**, from a manifest written
alongside them. When the manifest and the emitted chunks disagree, the runtime
asks for a file that is not on disk. Confirmed on 2026-08-17: `.next/server/` held
its manifests and `webpack-runtime.js` and **not one numbered chunk**.

## How to know it is NOT your code — in one minute

These four checks all pointed the same way and take a minute together:

1. **Does the other app fail too?** `apps/admin` had zero source changes that day
   and failed identically. One shared cause, not two bugs.
2. **Does the missing chunk exist?** `ls apps/web/.next/server/135.js` → no. It is
   a filesystem state, not a source problem.
3. **`npx tsc --noEmit`** — passed.
4. **`npm test`** — 471 web + 50 admin tests green.

Source is fine when all four agree. Stop reading the diff.

## Why it happens

Both dev servers had been alive **over 24 hours** (started 08-16 22:56, failed
08-17 22:4x) across a day of edits plus a branch switch, a `git stash` that
reverted 16 source files, the `stash pop` that restored them, and a merge. Next's
dev bundler rebuilds incrementally on every one of those; enough interleaved
rebuilds and the chunk set stops matching its manifest.

**Not** the cause here, but the other way in: two `next dev` processes pointed at
one app share a single `.next` and clobber each other's chunk numbering. The
process tree on 2026-08-17 showed one clean chain per app — worth checking with
`Get-CimInstance Win32_Process -Filter "Name='node.exe'"` before assuming.

Also ruled out that day: disk full (364 GB free).

## Prevention

1. Restart the dev servers after branch switches, stashes and merges.
2. Do not leave `next dev` running overnight, let alone for days.
3. Never start a second `next dev` for an app that already has one.

## There is no code fix, and that is the point

This is a stale-cache failure mode of long-lived dev servers, not an application
bug — nothing in `apps/web/src` can prevent it. What was fixable was the
**recovery**, which had been unguessable from the error text:

- `npm run dev:reset` → `scripts/dev-reset-next.mjs` quarantines both caches
  (renames, never deletes — Rule 1), refuses with an actionable message if a dev
  server still holds the directory, and lists what has accumulated.
- `.gitignore` gained `.next.*`. `.next/` with its trailing slash only matches a
  directory named exactly `.next`, which is why two full build trees
  (`apps/web/.next.prodbuild-aside-2026-08-11{,-b}`) are tracked in this repo —
  moved aside under Rule 1, then silently committable. `dev:reset` produces that
  same shape, so the pattern had to cover it.

## Related

- [[Gotchas/2026-07-23 - Sentinel not working was four stacked config+build faults]]
  — records the sibling trap in the same repo: `dist/src` vs `dist` build layout,
  and the `.tsbuildinfo` cache that masks `tsconfig` changes. Same family: the
  build cache lying about the source.
