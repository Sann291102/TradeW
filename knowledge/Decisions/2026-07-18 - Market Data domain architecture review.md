---
type: decision
date: 2026-07-18
tags: [decision, product-architecture, market-data, prisma, schema]
status: active
---

# Decision: Market Data domain architecture — reviewed before any migration

## Context
Phase 2, Milestone 4, Step 2 (Market Data) began with a proposed `Quote` schema migration (add `open`/`high`/`low`/`bid`/`ask`/`volume`) to unblock Live Quotes + the 5-index dashboard. Before applying it, the user asked for a full 5–10 year architecture review of the market-data domain — every consumer (Dashboard, Terminal, Portfolio, Sentinel, TradeW AI, Learning, Research, TradingView) — with the migration itself evaluated critically, not rubber-stamped. Full review: [[../../docs/product-architecture/MARKET-DATA-ARCHITECTURE.md]].

## Verdict on the original migration
**Correct field placement, incomplete.** `bid`/`ask`/`open`/`high`/`low`/`volume` all correctly belong on `Quote` — nothing needed to move elsewhere. Two additions were missing: `@@unique([instrumentId])` (makes the already-implicit "one row per instrument" convention an enforced invariant, not just application-code discipline) and a `source` field (provenance, before simulated and real-provider data can ever coexist).

## What `Quote` actually is today (evidence, not assumption)
Read from the code, not guessed: every write path (`seed.ts`) does find-or-update, never blind-create; every read path takes `findFirst orderBy updatedAt desc`. That's a **latest-snapshot cache by convention**, unenforced by schema. Not a history table, not a formal cache (no TTL/Redis) — a durable Postgres row per instrument.

## The rest of the domain (models NOT in the original migration, all reasoned from consumer needs)
- **`Candle`** (new) — historical OHLCV time series. Needed by Charts/TradingView **and** — this was the important finding — by **Sentinel's Trap Detection**, whose composite signals (`SENTINEL.md` §3: fake breakout, bull/bear trap, liquidity sweep) all require OHLC history, not a snapshot. Sentinel's highest-value signal category is currently blocked without this table.
- **`OptionMetrics`** (new) — OI/change-OI/IV/Greeks, separate from `Quote` (cardinality: dozens of live contracts per underlying vs. one `Quote` row; write pattern: batch Black-Scholes per expiry vs. per-instrument; read pattern: "all strikes for underlying+expiry" range query vs. point lookup). PCR is derived on read, never stored.
- **Market Depth (L2)** — realtime-only, never persisted. No platform warehouses historical order-book depth; the write volume vs. query value makes a table actively wrong.
- **Index data** — reuse `Instrument` (`type: INDEX`), already correct, no new entity.
- **`CorporateAction`** (new) — splits/dividends/bonuses/rights; feeds portfolio cost-basis adjustment and the Knowledge Graph's Market Event node type.
- **`Watchlist`/`WatchlistItem`** (new) — flagged because watchlists are currently 100% frontend-only, zero backend persistence, and this was explicitly in scope of the requested model audit.

## Forward-compatibility note (for whoever builds Candle later)
Once `Candle` exists, `Quote.open/high/low/volume` become *derivable* from that day's in-progress `D1` candle. Shipping them on `Quote` now (as a read-performance denormalization) is fine **provided** the future implementation derives `Quote` from persisted candles rather than maintaining two independently-computed sources of truth. The current `SimulatedEngineService` recomputes the whole session's path from scratch per request (O(elapsed minutes), up to 375 iterations near close) — flagged for refactor to incremental-candle-persistence once `Candle` ships, not urgent today.

## Migration sequence (none applied — waiting for approval)
1. `Quote` revision (unique constraint + source field + the originally-proposed columns) — unblocks this turn's scope
2. `Candle` — Charts + Sentinel Trap Detection
3. `OptionMetrics` — real Option Chain
4. `CorporateAction` + `Watchlist`/`WatchlistItem` — bundled, both low-volume/event-or-user-driven

## Related
- [[../_INDEX.md]]
- [[2026-07-18 - Backend audit (Milestone 4 Step 0)|../Research/2026-07-18 - Backend audit (Milestone 4 Step 0)]]
- docs/product-architecture/MARKET-DATA-ARCHITECTURE.md (full review), TRADEW-OS.md
