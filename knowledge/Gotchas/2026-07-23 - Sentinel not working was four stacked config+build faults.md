---
type: gotcha
date: 2026-07-23
tags: [gotcha, sentinel, build, env, dhan, market-data]
status: resolved
---

# "Sentinel only shows simulated data" was four stacked faults, not one

When Sentinel appears to "not work / only show simulated data," it is almost never a single
cause. On 2026-07-23 it was **four independent faults stacked**, each of which alone looks
like the whole problem:

1. **Nothing was running.** The `/sentinel` page falls back to a canned `DEMO` constant
   (`apps/web/src/lib/sentinel/useSentinel.ts` catch block) whenever the API fetch fails —
   so a stopped service renders as "simulated data" with an amber banner, not an error.
2. **Service-token mismatch.** `services/api/.env` `SENTINEL_SERVICE_TOKEN` held a 70-char
   `nvapi-...` value (an NVIDIA key pasted into the wrong slot) while sentinel's
   `SERVICE_TOKEN` was the 28-char `dev-...`. `ServiceTokenGuard` 401s every `/observe` on
   mismatch. Fix: sync them (backup at `services/api/.env.bak`).
3. **`MARKET_DATA_FEED=Live` silently means simulated.** `registry.ts` `normaliseName()`
   only accepts `dhan` | `simulated`; anything else → `null` → simulator, **no warning**.
   The correct opt-in value is `dhan`, not `Live`.
4. **The real one: `getCandles` was hardwired to the simulator** and there was no `Candle`
   table. Fixed by Migration 2 + `CandleMarketDataProvider` —
   see [[Patterns/2026-07-23 - Candle table + Dhan backfill (Sentinel on real data)]].

## Build gotcha found while fixing #4 — stale `dist/main.js`
`services/sentinel` `nest build` was emitting to **`dist/src/**`**, not `dist/`, because
`tsconfig.json` had no `include`/`exclude`, so tsc also picked up `scripts/**`, which pushed
the inferred `rootDir` up to the package root. Meanwhile `start:prod` / `node dist/main.js`
kept running a **stale July-17 entry** at the old `dist/` root (with the old simulator
binding) — so rebuilds appeared to do nothing and every boot ran old code.

- `dist/src/main.js` is **not runnable** — relative/workspace requires break at that depth
  (`MODULE_NOT_FOUND`). The intended layout is `dist/main.js`.
- Fix: add `"include": ["src/**/*.ts"]` + `"exclude": ["node_modules","dist","scripts"]` to
  `services/sentinel/tsconfig.json`. Scripts still compile via `tsconfig.scripts.json`.
- The `incremental` cache (`dist/*.tsbuildinfo`) masked the fix — after changing `include`,
  `nest build` re-emitted nothing until the two `.tsbuildinfo` cache files were removed.
  If a Nest build "won't pick up" a config change, delete `dist/*.tsbuildinfo` and rebuild.

**General lesson:** verify which entry is actually running (`stat dist/main.js` mtime, grep
the compiled binding) before trusting that a rebuild changed anything.

## Related
- [[Patterns/2026-07-23 - Candle table + Dhan backfill (Sentinel on real data)]]
- [[Patterns/2026-07-21 - Market data Phase 1 (ingestion runtime, pure reads)]]
