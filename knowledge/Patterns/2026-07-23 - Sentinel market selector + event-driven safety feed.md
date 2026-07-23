---
type: pattern
date: 2026-07-23
tags: [pattern, sentinel, frontend, web, ux]
status: implemented
---

# Sentinel: user-centric market selection + event-driven Live Safety Feed

## What shipped
Two related additions to `apps/web` `/sentinel`, both driven by a product ask
("market head" selector; safety feed should only push on real setups):

1. **Market selector ("market head")** — `components/sentinel/MarketSelector.tsx`
   + `lib/sentinel/markets.ts`. A search + grouped dropdown over indices /
   commodities / the full F&O stock universe (reuses `FO_STOCK_UNIVERSE`).
   Symbols with real backfilled candle history (`REAL_DATA_SYMBOLS`) get a green
   dot; everything else is honestly labelled as running on simulated data.
2. **Selection drives the whole workspace.** `useSentinel(symbol)` now takes a
   symbol (was hardcoded `'NIFTY'`); `symbol` is in the `refresh` `useCallback`
   deps, so picking a market fires a fresh `/observe` and every panel re-derives.
   `app/sentinel/page.tsx` owns `const [symbol, setSymbol]` and shows a header
   line "Reading <market> · <real|simulated|sample data>".

## The reusable bit — event-driven "push" via a `pushworthy` flag
The Live Safety Feed was echoing **every** observation on every refresh. The
fix is a per-card `pushworthy` boolean computed in `deriveContext.ts`
(`extractSafetyFeed` sets it; `pushworthyCards()` filters):

- corroborated synthesis → always pushworthy (the canonical "setup")
- `emotion` / `trap-safety` / `orchestrator` observation → pushworthy (a real
  behavior/structural event was experienced)
- `market-technical` observation → pushworthy only at confidence ≥ 0.8
  (`MARKET_PUSH_THRESHOLD`) — a lone overbought-RSI is *context*, shown in the
  Market Context panel, not a safety push.

The page passes `pushworthyCards(safetyCards)` to `LiveSafetyFeed` (only genuine
events surface) and the **full** `safetyCards` to `SentinelTimeline` (history
keeps everything). This is the general shape for "notify only on real signal,
not every tick" surfaces in this app — separate *derivation* (all cards) from
*surfacing* (pushworthy subset), don't drop data at the source.

## Honest-status caveat (not a bug)
When signed out the page is in demo mode: `useSentinel` falls back to a static
`DEMO` constant, so switching markets updates the header/selector but not the
canned analysis. Per-symbol *live* analysis needs auth (the `/sentinel/observe`
endpoint requires the `sentinel` entitlement). Backend per-symbol correctness is
already proven (NIFTY 23871.70 vs RELIANCE 1272.50 from real candles).

## Related
- [[2026-07-23 - Candle table + Dhan backfill (Sentinel on real data)]] — the real per-symbol data behind `REAL_DATA_SYMBOLS`
- `apps/web/src/lib/sentinel/deriveContext.ts` — day classification + safety-card derivation this extends
