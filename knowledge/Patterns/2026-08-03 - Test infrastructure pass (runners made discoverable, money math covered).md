---
type: pattern
date: 2026-08-03
tags: [pattern, testing, ci, sentinel, api, market-clock]
status: active
---

# Test infrastructure pass (2026-08-03)

## For future Claude
**Read before adding tests anywhere in this repo, and before touching `services/sentinel/src/market-clock.ts`.** This records what the test setup now is, why three configs are allowlists rather than globs, and one defect that is deliberately pinned by a passing test rather than fixed.

## What the audit found

A 9-dimension audit pass established the starting position by execution, not inspection: 10 test files across ~410 source files. The problem was not only breadth — it was **discoverability**. Three separate bodies of real, passing assertions gated nothing:

- `apps/web/vitest.config.mjs` hardcoded `include: ['feed-proxy-routes.spec.mjs']`, so `npm test -w @tradew/web` silently skipped `src/lib/sentinel/optionChain.test.ts` (13 tests). Reaching it required knowing a second script, `test:sentinel`, existed.
- `services/sentinel` (99 files, 13,469 lines) had **no test runner at all** — no vitest/jest config, no `test` script, no runner dependency. Its 138 real assertions lived in five ts-node harnesses (`npm run reasoning:test`, `verify:runtime`, …) invisible to `npm test`.
- `packages/market-data/scripts/verify-parser.ts` is a genuine round-trip test of the Dhan binary tick parser — the highest-risk external-payload code in the system — reachable only as `npm run verify`.
- **No CI workflow ran any test.** `deploy.yml` was the only workflow, triggers on `main` only, and goes from checkout straight to `docker build`.

The existing tests were judged **high quality, not vacuous**: pure functions, injected clocks, stubbed Prisma, no Nest context — which is why 203 tests run in ~4s. `discipline-limits.spec.ts` is the house style; copy it.

## What changed

**Coverage added** (all in the existing pure/injected style, no new tooling):
- `services/api/src/sim/order-fill.spec.ts` — 25 tests over `applyFill`, the only function computing position averaging, realized P&L, partial closes and close-and-flip. Required a one-word targeted edit: `applyFill` was module-private, now `export`ed *for the spec only* (documented at the call site). Its output drives `Position.avgPrice`, wallet cash, and the discipline loss-limit tripwire.
- `services/api/src/entitlements/entitlements.spec.ts` — 25 tests. Previously the *only* spec mentioning entitlements (`learning-access.spec.ts`) substituted a stub for the service, so the real `check()` was entirely unasserted. Pins quota at exactly the limit (`used >= limit`, so the 500th call of a 500 quota is refused), grace boundaries, revoked-override precedence over a healthy subscription, and TRIALING/`expiresAt` interaction.
- `services/api/src/auth/auth.guard.spec.ts` — 12 tests. There is **no `APP_GUARD`** in this repo; every route is protected only by an explicit `@UseGuards` decorator, so this guard is the whole authentication boundary wherever it appears.
- `services/sentinel/src/market-clock.spec.ts` — 28 tests, plus the service's first `vitest.config.ts` and `test` script (vitest added to its devDependencies; lockfile synced).

**Wiring**:
- Root `package.json` gained `"test": "npm run test --workspaces --if-present"` — one command now runs everything.
- `packages/market-data` gained `"test": "npm run verify"` so the parser harness gates.
- `apps/web/vitest.config.mjs` now names both files explicitly and resolves the `@` alias. `vitest.sentinel.config.mjs` is retained (Rule 1) and still works for focused runs.
- New `.github/workflows/ci.yml` — runs `npm test` plus typechecks on every push and PR. Note it must run `prisma generate` first: `entitlements.spec.ts` imports `SubscriptionStatus` from `@prisma/client` and **no package declares a postinstall hook**.
	- **Update 2026-08-19**: the root `postinstall` now exists — but it only builds `@tradew/types`, `@tradew/ai-core`, `@tradew/market-data`. It still does **not** run `prisma generate`, so the trap above is unchanged for any fresh checkout. Confirmed on two new worktrees off `main` @ `6928301`: `npm install` succeeded, then `npm test` exited 1 with 3 suites failing to *load* (407 tests passed, 0 assertions failed) — `entitlements.spec.ts`, `coupon-redeem.spec.ts` on `SubscriptionStatus.ACTIVE`, and `auth/otp-disclosure.spec.ts` on `OtpPurpose.phone_verify`, all `TypeError: Cannot read properties of undefined`. A Prisma-enum import that reads `undefined` at module load is this, every time. Fix: `npm run db:generate` after install. Setup order for a clean workspace is `npm install` → `npm run db:generate` → `npm test`.

Result: `npm test` at the root = 265 tests (34 web + 203 api + 28 sentinel) + the parser harness, exit 0.

## The gotcha worth remembering

**`services/sentinel/src/market-clock.ts` thinks the market is open on weekends and holidays.** `isMarketOpen` and `sessionPhaseAt` read only minutes-of-day — no `getDay()`, no holiday list — so 10:30 IST on a Saturday, a Sunday, and on Republic Day all return open/`active`. Seven services import this clock, and `state-machine.service.ts` seeds session state directly from `sessionPhaseAt`, so a weekend produces a full phantom session.

This is a **documented deferral, not an unknown bug**: `services/api/src/discipline/market-calendar.ts:13` carries `TODO(clock-unification)` and already owns a correct, tested `isTradingDay`. (That comment describes Sentinel's clock as "weekday and clock only" — it is actually clock-only, with no weekday check at all.)

The spec **pins the defect with passing assertions** under a `KNOWN GAP` describe block that says so in capitals. The reasoning: fixing the clock is a behaviour change across seven services wanting its own review, but leaving it untested lets it change silently in either direction. **When clock-unification lands, those assertions should flip from `true` to `false` — that inversion is the signal the fix worked, not a regression.**

## Still uncovered (honest limits)

`computeMargin`, the matching-engine polling loop, `packages/ai-core` (28 files), `dhan-scrip-master.ts` (351 lines, the other external-payload parser), and `services/sentinel`'s intelligence layer — the five ts-node harnesses reach 42 of 87 sentinel modules; `confidence.engine` (396 lines), `state-machine`, `timeline.engine`, `explain.service` and `compliance.service` are unreached. No line/branch coverage tooling is installed. `apps/web/src/lib/discipline.ts` (231 lines) mirrors server-side rules that *are* well tested server-side; the client copy is not.

**CI will be red on `typecheck-web` until an unrelated P0 is fixed**: `NotificationsClient.tsx` imports `Spinner` from `@tradew/ui`, which exports no such component — `next build` fails and `/notifications` (a real nav item) renders blank. The design system uses `Skeleton` *instead of* a spinner by deliberate choice, so `Skeleton` is the intended replacement, not a new component. Split into its own CI job so it cannot mask the passing suites.

## Related
- [[../Plans/2026-07-21 - Full platform and product audit]]
- [[../Gotchas/2026-07-23 - Sentinel not working was four stacked config+build faults]]
- [[2026-07-29 - Broker OAuth ownership and third-party content boundaries]]
- [[../_INDEX.md]]
