---
type: gotcha
date: 2026-08-18
tags: [gotcha, typescript, build, nest, deployment, services-api]
---

# A script importing across packages silently moves the whole `dist/`

**Symptom.** `services/api` answers requests with code that is *hours old*.
Routes that plainly exist in `src/` return **404**. `nest build` exits **0** and
prints nothing. `tsc --noEmit` passes. All 912 unit tests pass. Nothing anywhere
reports an error.

## Cause

TypeScript infers `rootDir` as the **common ancestor of every input file**.

`services/api/scripts/verify-paper-execution.ts` and
`verify-user-account-binding.ts` import the real strike evaluator rather than a
copy of it:

```ts
import { evaluateStrikeCandidates } from '../../sentinel/src/execution/strike-candidates';
```

That is deliberate and correct — a verification harness asserting against a
duplicated evaluator would assert nothing. But `tsconfig.build.json` did not
exclude `scripts/`, so those files were build inputs, so `services/sentinel`
became a build input, so the common ancestor rose from `services/api/src` to
`services/`.

Every output moved accordingly:

```
dist/main.js                →  dist/api/src/main.js
dist/admin/admin.controller.js →  dist/api/src/admin/admin.controller.js
                            (+ a whole dist/sentinel/ tree appeared)
```

`package.json` still runs `node dist/main`. That file still existed — as the
**stale leftover of the last correct build** — so the API booted happily and
served yesterday's code indefinitely.

## Why it is so hard to see

Every signal is green. The build succeeds, types check, tests pass, the process
starts, `/health` returns 200. The only symptom is a 404 on a route you can read
in the source three feet away, which sends you hunting through routing, guards
and the proxy allowlist — none of which are wrong.

Two things make it worse:

- **`nest build` piped into `tail` hides the exit code.** `npx nest build | tail
  -15; echo $?` reports *`tail`'s* status, always 0. Redirect to a file and check
  `$?` on its own line.
- **A corrupt `.tsbuildinfo` compounds it.** Incremental state claimed everything
  was current, so even after fixing `rootDir`, `tsc` emitted nothing. Only
  `tsc -p tsconfig.build.json --incremental false` (420 files emitted) broke the
  deadlock. If a build emits nothing and outputs are older than sources, move
  `dist/*.tsbuildinfo` aside first.

## Fix

`tsconfig.build.json` now excludes `scripts`. The exclusion is load-bearing, not
tidy — the comment there says so, because the obvious "fix" for a future type
error in a script is to remove that entry, which silently reintroduces this.

Verification harnesses run through `ts-node` and are not shipped, so excluding
them is correct on its own merits and pins `rootDir` to `src/` as a side effect.

## How to check in ten seconds

```bash
ls -d services/api/dist/api services/api/dist/sentinel   # either exists → rootDir moved
ls -la services/api/dist/main.js                          # older than src/ → stale
```

## Related

Discovered while recovering from the *other* stale-build failure the same day —
see [[Gotchas/2026-08-17 - Next dev _Cannot find module .NNN.js_ is a stale .next, not your code]].
That one was caused here by running `next build` in `apps/admin` while its
`next dev` server was live: both own `.next`, and the production build's layout
desynced the dev server's chunk manifest. **Do not run `next build` against an
app whose dev server is running.**
