# Market Data Domain — Architecture Review & Long-Term Schema

Status: **architecture review, pre-implementation.** Requested as Phase 2, Milestone 4, Step 2's architecture gate — no migration has been applied; this document is the basis for approval before any schema change. Governed by [`TRADEW-OS.md`](TRADEW-OS.md). Read alongside [`knowledge/Research/2026-07-18 - Backend audit (Milestone 4 Step 0).md`](../../knowledge/Research/2026-07-18%20-%20Backend%20audit%20(Milestone%204%20Step%200).md), which this document extends with a market-data-specific deep dive.

## 1. Audit — every existing market-data-related model

Read directly from `packages/database/prisma/schema.prisma`, not inferred.

| Model | Purpose | Current usage | Relationships | APIs | Services |
|---|---|---|---|---|---|
| `Instrument` | Static/reference data — WHAT a tradable (or quotable) thing is: symbol, display name, type (`INDEX`/`OPTION`/`EQUITY`), exchange, underlying, expiry, strike, option type, lot size, tick size | Search (`/instruments/search`), joined by every order/trade/position/quote lookup | `Quote[]`, `Order[]`, `Trade[]`, `Position[]` | `GET /instruments/search` | `InstrumentsService` |
| `Quote` | See §2 — evidence-based answer below | Single-row-per-instrument latest value, read/written by `MarketDataService` and (read-only) `SentinelService` | `Instrument` (many-to-one, unenforced-one-to-one in practice) | `GET /market-data/quote/:instrumentId` | `MarketDataService` |
| OHLC/candle model | **Does not exist.** No table anywhere stores a time series of bars. | — | — | — | — |
| Option-specific model | **Does not exist.** Options are `Instrument` rows only (`optionType`/`strikePrice`/`expiryDate`/`underlying`) — no OI, IV, Greeks, or option-chain-specific storage anywhere | — | — | — | — |
| Exchange model | **Does not exist.** `exchange` is a free-text string field on `Instrument` (`"NSE"`, `"BSE"`) | — | — | — | — |
| Provider model | **Does not exist.** No table records which data vendor/system produced a value. `MarketDataService`'s response literally hardcodes the string `mode: 'BRIDGE_SEEDED_QUOTE'` in code, not data. | — | — | — | — |
| Watchlist model | **Does not exist.** Watchlists today are 100% frontend-local (`apps/web`'s `lib/mock/market.ts` static array, or `workspaceStore`'s client-only state) — zero backend persistence. | — | — | — | — |

## 2. What does `Quote` actually represent? (evidence, not guesswork)

**Conclusion: `Quote` is used, by application-code convention, as a mutable "latest snapshot" cache — but the schema does not enforce that, which is a real gap.**

Evidence:
- Every read path (`MarketDataService.quote()`, `SentinelService`'s trade/position context gathering) does `prisma.quote.findFirst({ orderBy: { updatedAt: 'desc' } })` — "get the most recent row," which only makes sense as *code discipline* if multiple rows could theoretically exist.
- Every write path (`seed.ts`'s `upsertInstrument`) explicitly does `find-or-create-else-update`: look for an existing row for this instrument, and `.update()` it if found, `.create()` only if not. This is defensive code written specifically to *prevent* the table from becoming a history table — a strong signal of intended snapshot semantics.
- **But nothing in the schema enforces it.** There is no `@@unique([instrumentId])` constraint. Nothing stops a future code path from calling `.create()` repeatedly per instrument, which would silently turn this into an unindexed, unbounded, accidental history table — the worst of both worlds (not a real snapshot, not a usable time series).

It is **not** a historical/time-series store (no timeframe/bucket concept), and **not** a formal cache in the infra sense (no TTL, no Redis — it's a durable Postgres row). It's best described as: *the durable latest-value row per instrument, currently unconstrained at the schema level.*

## 3. Long-term architecture, by domain

### Latest Quotes
Stay on `Quote`, one row per instrument. Belongs here: `ltp`, `open`/`high`/`low` (today's session, running), `previousClose`, `bid`/`ask` (best-of-book only — see Market Depth), `volume` (today's session cumulative), `updatedAt`, and a `source` field recording provenance (`'simulated'` today, a real provider code later). Market status is **derived** (time + calendar), not stored.

### Historical Candles
**Yes, a dedicated `Candle` model is needed** — not an extension of `Quote`. Reasoning:
- Fundamentally different cardinality: `Quote` is one row per instrument; `Candle` needs many rows per instrument per timeframe (potentially tens of thousands per instrument over years at 1-minute resolution).
- Fundamentally different access pattern: `Quote` is a point lookup by instrument; `Candle` is a range query (instrument + timeframe + time window), and needs long retention for backtesting/replay/historical-similarity — explicitly named as future consumers in your brief.
- Cramming both into one table (a nullable `timeframe` column, null for the snapshot row) is a polymorphic-table anti-pattern that would hurt the much-more-frequent `Quote` read path.

Shape: `instrumentId`, `timeframe` (enum: `M1`/`M3`/`M5`/`M15`/`M30`/`H1`/`H4`/`D1`/`W1`/`MN1`), `bucketStart`, `open`/`high`/`low`/`close`, `volume`, optional `openInterest` (for F&O). Unique on `[instrumentId, timeframe, bucketStart]` — that's also the natural query index.

`services/market-data`'s own README already anticipates this ("historical candles land in Postgres for now — don't provision TimescaleDB before real volume needs it") — this design honors that; TimescaleDB/partitioning is the documented future evolution once row counts justify it, not a day-one requirement.

### Option Chain
OI, change-in-OI, IV, Greeks belong in a **new, separate `OptionMetrics` table** — not on `Quote`. Reasoning:
- Cardinality: one underlying can have 40–100+ live option contracts across strikes/expiries, each needing per-tick Greeks, while `Quote` conceptually needs exactly one row for the underlying itself. Putting Greeks on `Quote` would make the hot, frequently-read "latest quote" table mostly-null-columns for every non-option row and bloated for every option row — hurting the surface (Dashboard/Ticker/Watchlist) that reads it far more often than the option chain does.
- Write pattern: Greeks are computed in a **batch** per expiry (Black-Scholes across a whole strike ladder, driven by the underlying's tick) — architecturally a bulk-upsert, not `Quote`'s independent per-instrument write.
- Read pattern: the Option Chain UI wants "all strikes for underlying+expiry" — a grouped range query, not a point lookup. `OptionMetrics` denormalizes `underlying`/`expiryDate`/`strikePrice`/`optionType` directly onto itself (in addition to living on `Instrument`) specifically to serve this query shape with one index, not a join-then-filter.

`Expiry`/`Strike` stay exactly where they already correctly are — `Instrument` fields, static reference data, no change needed.

**PCR is derived, never stored** — it's `sum(put OI) / sum(call OI)` for an expiry, computed on read from `OptionMetrics` rows. Persisting a derived aggregate that goes stale the moment any underlying OI changes would be a correctness bug waiting to happen.

Persisted (Postgres), same durability reasoning as `Quote` — Sentinel and backtesting need option context historically, not just live. A Redis layer in front of the option-chain **read** endpoint is a valid future performance optimization; Postgres stays the source of truth.

### Market Depth (Level II)
**Best bid/best ask stay on `Quote`** (single value, no history anyone queries). **Full 5-level depth should NOT be persisted at all** — realtime-only, computed/served through the engine (later the WebSocket layer), with at most a short-TTL Redis cache if multiple concurrent subscribers need the same snapshot without recomputing. No platform warehouses historical order-book depth for a retail product; the write volume (many updates/second per instrument) versus the near-zero query value makes a Postgres table actively wrong here.

### Index Data
**Reuse `Instrument`** (`type: INDEX`) — already correct and already working (`NIFTY`/`BANKNIFTY`/`FINNIFTY`/`MIDCPNIFTY`/`SENSEX` all fit today). A separate `Index` entity would fragment the `Quote`/`Candle` join logic for zero benefit — Dashboard/Ticker/Charts all want to treat an index exactly like any other quotable instrument. The only index-specific rule ("you can't place an order on an index directly") is an application-layer validation concern for the Orders step, not a schema concern.

### Corporate Actions
**New, dedicated `CorporateAction` model** — nothing existing fits splits/dividends/bonuses/rights. `instrumentId`, `type` (`SPLIT`/`DIVIDEND`/`BONUS`/`RIGHTS`), `exDate`, `ratio`, `amount`, indexed on `[instrumentId, exDate]`. Purpose: portfolio cost-basis adjustment, a "Market Event" node type for the Knowledge Graph (matches its existing News→Market Event chain), and split-adjusted candle history for accurate backtesting later. Event-driven writes (not tick-driven) — low volume, permanent retention, no caching needed.

### TradingView
TradingView's Charting Library expects a Datafeed API (`getBars`, `resolveSymbol`, `searchSymbols`, `subscribeBars`). It consumes **both**, but asymmetrically: `Candle` is the primary dependency (`getBars` returns historical OHLCV bars — TradingView is fundamentally a candle-rendering surface); `Quote` feeds only the realtime tail (the still-forming current bar, derived from `Quote`'s live LTP). No new model needed beyond `Candle` — the remaining work is an integration adapter (a UDF-shaped controller wrapping `Candle`+`Quote` reads), which is implementation for the Charts/TradingView step, not a schema question.

### Sentinel
Precise dependencies, from the already-implemented Brain services:
- **Latest Quote** — direct dependency (current LTP/change for real-time observation context).
- **Historical Candles — critical, currently missing dependency.** `SENTINEL.md` §3's Trap Detection signals (fake breakout, bull/bear trap, liquidity sweep, low-volume breakout) *all* require OHLC+volume history at a timeframe, not a single snapshot. **This means Sentinel's highest-value signal category is blocked today on the `Candle` model not existing yet** — worth flagging plainly since it reframes "Charts" from a nice-to-have UI feature into a Sentinel dependency too.
- **Option Chain (OI/IV/Greeks)** — direct dependency for expiry-day and gamma-squeeze signals (`SENTINEL.md` §3 names these explicitly) → `OptionMetrics`.
- **Market breadth / regime / internals** (advance-decline, India VIX level, sector rotation) — these are **derived aggregates** computed from `Quote`+`Candle` across many instruments, not a new raw-data table. Recommend a future cached/recomputed aggregate (Redis, refreshed periodically), not a new source-of-truth model.
- **Research** (Knowledge Graph / Research Vault via `GraphNode`/`GraphEdge`/`MemoryRecord`) — already real and already Sentinel's own domain, unrelated to this migration.

### TradeW AI
`Quote` (current context) and `Candle` (the series behind whatever chart the user has open) for the Technical Analysis agent; Knowledge Graph / Research Vault for Historical Comparison and Research agents (already documented); Portfolio, read-only, via `services/api`, for Portfolio Insights. **Boundary, reaffirmed**: TradeW AI never writes market data, never calls `trading-engine`, and never calls Sentinel directly — every one of these is a read, and Sentinel access is only ever through `services/api`'s orchestration (`TRADEW-ASSISTANT.md` §6's no-direct-arrow rule, restated here because it's directly relevant to this domain's consumers).

## 4. Evaluating the previously-proposed migration

The migration I proposed before this review added `open`/`high`/`low`/`bid`/`ask`/`volume` directly to `Quote`. Re-examined against the full design above:

**What was right, and stays:** `bid`/`ask` belong on `Quote` permanently — there's no historical/candle equivalent of a bid/ask (nobody keeps a "bid/ask candle"), so this isn't a redundancy risk. Adding OHLC/volume to `Quote` rather than inventing a premature history table was also the right call for *this* increment.

**What was incomplete:**
- **Missing `@@unique([instrumentId])`.** Per §2, this is the fix that turns the existing *implicit* snapshot convention into an *enforced* one. Cheap, safe (current data already satisfies it), and closes a real correctness gap.
- **Missing a `source` field.** Once simulated and real-provider data can coexist (even transiently, during a future provider migration), not recording provenance per-row becomes a real problem to retrofit later. Cheap to add now.
- **A genuine future-redundancy risk, not a blocker but worth designing against now:** once `Candle` exists, `Quote.open/high/low/volume` become *derivable* from that day's in-progress `D1` candle. Shipping them on `Quote` now is fine as a read-performance denormalization (one fast row for a dashboard card, no join), **provided** the future `Candle` implementation derives `Quote`'s OHLC/volume by aggregating persisted candles rather than maintaining two independently-computed sources of truth. Concretely, this also means the `SimulatedEngineService` I drafted (which recomputes the whole session's path from scratch on every request, up to 375 iterations near market close) should be refactored, when `Candle` ships, to persist 1-minute bars incrementally and derive `Quote` from them — a performance and consistency improvement, not just a style preference. Documenting this now avoids the drift risk later.

**Net verdict: the field placement was correct; the migration was incomplete, not wrong.** Nothing needs to move to a different table — `OptionMetrics`, `Candle`, `CorporateAction`, and depth-as-realtime-only were already correctly excluded from the original draft by scope, not by oversight.

## 5. Recommended final schema

| Model | Purpose | Key relationships | Indexes | Est. row count | Retention | Update freq. | Realtime strategy | Caching |
|---|---|---|---|---|---|---|---|---|
| `Instrument` (unchanged) | Static reference data | 1→many `Quote`, `Candle`, `OptionMetrics`, `CorporateAction`, `Order`/`Trade`/`Position` | `symbol` unique (existing) | Hundreds–low thousands | Forever | Rare (corporate events, new listings) | N/A | Not needed (tiny, cheap to read) |
| `Quote` (revised) | Current latest-value snapshot per instrument | 1:1 (enforced) with `Instrument` | `@@unique([instrumentId])` (new), keep `[instrumentId]` for join speed | = instrument count actively quoted | Not retained as history — each row is overwritten, not appended | Every tick (seconds, when a real feed exists; on-read today) | Push via future WebSocket gateway (Step 7) | Read-through Redis optional once request volume justifies it; Postgres remains source of truth |
| `Candle` (new) | Historical OHLCV time series, per timeframe | many→1 `Instrument` | `@@unique([instrumentId, timeframe, bucketStart])` | Large at scale (~94k rows/instrument/year at 1m; far fewer at D1+) — the reason for planned partitioning later | Long (years) for backtesting/replay; consider downsampling very old 1m data eventually | Per bar close (every minute for M1, etc.) | Append-only; realtime tail derived from `Quote` | None needed initially; TimescaleDB/partitioning is the documented future path once volume justifies it |
| `OptionMetrics` (new) | Live OI/IV/Greeks per option contract | 1:1 with `Instrument` (type=OPTION only) | `@@unique([instrumentId])`, `@@index([underlying, expiryDate, strikePrice])` | Thousands (active strikes × expiries actually tracked) | Latest-only, like `Quote` — a future `OptionMetricsHistory` is a separate concern if IV/OI history is needed | Per underlying tick (batch per expiry) | Push via WebSocket once built | Redis cache in front of the option-chain read endpoint is a strong candidate given bursty read patterns around market open/expiry |
| `CorporateAction` (new) | Splits/dividends/bonuses/rights | many→1 `Instrument` | `@@index([instrumentId, exDate])` | Low (hundreds/year market-wide) | Forever | Event-driven, rare | N/A | Not needed |
| `Watchlist` + `WatchlistItem` (new — flagged by your own Step 1 audit list) | Persisted user watchlists (currently 100% frontend-only) | `Watchlist` many→1 `User`; `WatchlistItem` many→1 `Watchlist`, many→1 `Instrument` | `@@index([userId])` on `Watchlist`; `@@unique([watchlistId, instrumentId])` on `WatchlistItem` | Small (tens of watchlists × tens of symbols per active user) | Forever (until user deletes) | User-driven, infrequent | N/A | Not needed |

## 6. Migration plan — sequenced, **not applied**, waiting for approval

**Migration 1 — Quote revision** (the immediate, already-scoped need for Live Quotes + Index Dashboard):
```prisma
model Quote {
  id             String     @id @default(uuid())
  instrumentId   String     @unique
  ltp            Decimal    @db.Decimal(12, 2)
  previousClose  Decimal?   @db.Decimal(12, 2)
  open           Decimal?   @db.Decimal(12, 2)
  high           Decimal?   @db.Decimal(12, 2)
  low            Decimal?   @db.Decimal(12, 2)
  bid            Decimal?   @db.Decimal(12, 2)
  ask            Decimal?   @db.Decimal(12, 2)
  volume         BigInt?    @default(0)
  source         String     @default("simulated")
  updatedAt      DateTime   @updatedAt
  createdAt      DateTime   @default(now())
  instrument     Instrument @relation(fields: [instrumentId], references: [id])
}
```
Why: unblocks this turn's agreed scope (Live Quotes, 5-index dashboard), closes the snapshot-enforcement and provenance gaps found in §2 and §4.

**Migration 2 — `Candle`** (for the Charts step): new table as specified in §5. Why: Charts, TradingView, and — importantly — Sentinel's Trap Detection signals all depend on it; currently blocked.

**Migration 3 — `OptionMetrics`** (for the Option Chain step): new table as specified in §5. Why: real OI/Greeks/PCR have no home today; needed before Option Chain can be anything but presentation-only.

**Migration 4 — `CorporateAction` + `Watchlist`/`WatchlistItem`** (for the Portfolio/Watchlists step): two new tables, bundled because both are low-volume, event/user-driven additions rather than tick-driven ones. Why: portfolio cost-basis accuracy and real watchlist persistence are both currently unaddressed gaps.

None of these have been run. Waiting for your approval before proceeding with Migration 1 (or any of the others).
