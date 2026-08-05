---
type: pattern
date: 2026-08-05
tags: [sentinel, reasoning, ui]
---

# Sentinel multi-strategy selection — Phase 2 of reasoning consolidation

**Read before touching `StrategyAdvisorService.advise()`, `ObserveRequest.selectedStrategyId(s)`, or `StrategySelector.tsx`.** Phase 2 of the
7-phase consolidation plan started in
[[2026-08-05 - Sentinel reasoning-engine merge (Engine 1 reads Engine 2 as corroboration)]].

## What changed

A trader can now pin **multiple** educational strategies to track
simultaneously in manual mode, not just one. `StrategyAdvisorService.advise()`
itself was untouched — it already only ever evaluated one strategy id per
call. What changed is the orchestrator now calls it once per pinned id and
collects the results:

- `ObserveRequest.selectedStrategyIds?: string[]` (new, preferred) alongside
  `selectedStrategyId?: string` (kept, now `@deprecated`, read as a
  single-item fallback via `resolveRequestedStrategyIds()` in
  `sentinel-orchestrator.service.ts`).
- `ObserveResponse.strategyAdvices?: StrategyAdvice[]` (new) — one entry per
  pinned strategy in manual mode, or a single auto-mode entry. `strategyAdvice`
  (singular) is kept and mirrors `strategyAdvices[0]`, so every existing
  single-strategy caller is unaffected.
- `StrategySelector.tsx` rewritten from a single `<select>` to a pill/checkbox
  group: "Auto (Default)" is mutually exclusive with manual picks; unchecking
  the last pinned strategy reverts to Auto automatically rather than leaving
  manual mode with nothing selected.
- `services/api/src/sentinel/{sentinel.controller,sentinel.service}.ts`
  forward both the new plural and legacy singular fields through to
  `services/sentinel`.

## Why additive, not a rename

Same reasoning as Phase 1's `crossValidation` field: `strategyAdvice`
singular stays exactly as it was for auto mode (the common case), so nothing
downstream that only knows about one strategy regresses. `strategyAdvices`
is the new surface multi-select actually needs.

## Verified two ways

1. `services/sentinel`: `tsc --noEmit` clean, `vitest run` 144/144 (unchanged
   — this phase didn't touch anything covered by the existing suite).
2. **`npm run verify:runtime`** (boots the real `AppModule` DI graph, only
   `MARKET_DATA` stubbed) — added 4 new assertions, all pass: `strategyAdvices`
   has one entry per pinned id, each entry addresses the strategy it was
   pinned for, `strategyAdvice` mirrors the first entry, and the legacy
   singular `selectedStrategyId` still works as a one-item fallback. 19/19
   total.
3. Browser E2E against the real running stack (`api` :4000, `sentinel` :4010,
   `web` :3000): signed up a test user, granted the `sentinel` capability via
   a direct `EntitlementOverride` insert (not the HTTP admin-override route —
   see the flagged `ADMIN_API_TOKEN` issue below), confirmed `/sentinel`
   renders cleanly through auth → entitlement gate → API gateway → orchestrator
   with **no React/JS console errors**. Could not visually confirm the new
   pill UI rendering real `strategyAdvices` data — this local dev environment
   has no live Dhan feed and no backfilled `Candle` rows for NIFTY, so
   `/observe` 503s at the data layer before reaching the strategy-advisor
   step. That 503 is the same "no real market data available... Sentinel does
   not substitute simulated data" behavior documented elsewhere in this vault
   — an environment gap, not a code path this phase touched.

## Flagged, not fixed: `ADMIN_API_TOKEN` looks like a live Anthropic key

While verifying, the root `.env`'s `ADMIN_API_TOKEN` (used by
`AdminTokenGuard` for `/entitlements/admin/*` and `/broker/dhan/admin/*`) was
read and its value is in the exact format of a live Anthropic API key
(`sk-ant-api03-...`), not a random admin token. Not used further once
noticed — the entitlement grant for verification was done with a direct
Prisma write instead. Flagged to the user directly in-session; not a code
change, recorded here so it isn't rediscovered from scratch.

## Not done in this phase

- No UI review of `LiveSafetyFeed`'s "forming"/"not forming" cards under
  multiple simultaneously-pinned strategies (deferred to Phase 3 per the
  plan — this phase only needed the selection mechanism and the advice
  array to exist).
- `sideInFocus` is still computed once, from the single leading detection
  across all strategies — not per pinned strategy. Multi-strategy selection
  changes what gets *evaluated and reported* (via `strategyAdvices`), not
  the single favoured-side read.

## Related

[[2026-08-05 - Sentinel reasoning-engine merge (Engine 1 reads Engine 2 as corroboration)]],
[[2026-07-26 - Sentinel Master Plan integration (12 modules into the existing service)]].
