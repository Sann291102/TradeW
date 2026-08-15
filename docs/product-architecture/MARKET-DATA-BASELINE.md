# Market Data Baseline — Post-Migration 1

> **Superseded in part, 2026-07-21.** Phase 1 of
> [`DHAN-MARKET-DATA-INTEGRATION.md`](DHAN-MARKET-DATA-INTEGRATION.md) has been
> implemented. The following sections below are now historical rather than
> current:
>
> - **§2** — endpoint list is unchanged, but the note that every read
>   "re-enriches and persists" no longer applies. Reads are pure.
> - **§4** — 17 instruments became 2,933 (190 indices + 2,730 NSE equities + the
>   12 original options), all but the options carrying real Dhan security IDs.
> - **§5 / §7** — the two divergent simulators are gone. One engine now lives in
>   `@tradew/market-data`; both originals are preserved under `archive/`. The
>   High-severity duplicate-simulator debt is resolved.
> - **§8+ (`Candle`)** — the `Candle` model now **exists** (Migration 2 shipped) and
>   real historical/intraday candles are served; the "does not exist yet" notes
>   below are historical. `OptionMetrics` is still not a persisted model — option
>   OI/IV/Greeks are served live via the Dhan bridge rather than stored.
> - **§6** — "no live provider" still holds, but the *architecture* for one is
>   in place: `services/market-data` is now a real ingestion runtime.
>
> §1, §3 (no WebSocket push to clients yet) and §8 remain accurate. Update this
> document at the end of Migration 2 rather than patching it further.

Status: **stabilization checkpoint, binding reference.** Captures the exact state of the Market Data domain after Migration 1 (Quote revision), before Migration 2 (Candle) begins. Governed by [`MARKET-DATA-ARCHITECTURE.md`](MARKET-DATA-ARCHITECTURE.md) (the long-term schema review this migration executed against) and [`TRADEW-OS.md`](TRADEW-OS.md). Update this document at the end of every future Market Data migration — it is the point-in-time source of truth for "what actually exists today," not the aspirational target.

---

## 1. Final `Quote` schema after Migration 1

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

  @@index([instrumentId])
}
```

Live Postgres state (verified via `\d "Quote"`, zero drift against `schema.prisma`):

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | text | not null | — |
| `instrumentId` | text | not null | — |
| `ltp` | numeric(12,2) | not null | — |
| `previousClose` | numeric(12,2) | nullable | — |
| `updatedAt` | timestamp(3) | not null | — |
| `createdAt` | timestamp(3) | not null | `CURRENT_TIMESTAMP` |
| `source` | text | not null | `'simulated'` |
| `ask` / `bid` / `high` / `low` / `open` | numeric(12,2) | nullable | — |
| `volume` | bigint | nullable | `0` |

**Constraints & indexes:**
- `Quote_pkey` — primary key, `id`
- `Quote_instrumentId_idx` — btree, `instrumentId` (join speed)
- `Quote_instrumentId_key` — **unique**, `instrumentId` (enforces one-row-per-instrument snapshot semantics — new as of Migration 1)
- `Quote_instrumentId_fkey` — FK to `Instrument(id)`, `ON UPDATE CASCADE ON DELETE RESTRICT`

**Semantics (unchanged from the architecture review, now enforced by schema, not just convention):** `Quote` is the durable latest-value snapshot per instrument — one row, overwritten in place, never a history table. `source` records provenance (`'simulated'` today; will hold a real provider code once one exists) so simulated and real-provider data can never be silently conflated.

## 2. Current API endpoints

All routes below live in `services/api`, are the **sole public ingress** for market data (per `ARCHITECTURE.md` §1), and require a valid bearer token (`@UseGuards(AuthGuard)` at the controller level).

### `MarketDataController` (`/market-data`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/market-data/quote/:instrumentId` | Single quote by instrument UUID (original contract) |
| GET | `/market-data/quote-by-symbol/:symbol` | Single quote by symbol (e.g. `NIFTY`) — avoids a round trip through instrument search |
| GET | `/market-data/quotes?symbols=A,B,C` | Batch quote read, one round trip — powers ticker/watchlist/dashboard |
| GET | `/market-data/indices` | The 5-index Dashboard feed (`NIFTY`, `BANKNIFTY`, `FINNIFTY`, `MIDCPNIFTY`, `SENSEX`) — internally just `quotesBySymbols` |

Every response is a `QuoteDto`: `instrumentId, symbol, displayName, ltp, change, changePct, open, high, low, close, bid, ask, volume, marketStatus, updatedAt, source`. Each read call **re-enriches and persists** the quote row (see §5) — this is a read-with-side-effect endpoint, not a pure read.

### `InstrumentsController` (`/instruments`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/instruments/search?q=` | Instrument search (symbol/display-name match) |

### Not yet exposed (planned, per `MARKET-DATA-ARCHITECTURE.md`)
- Any `Candle` read endpoint (Migration 2 dependency)
- Any `OptionMetrics`/option-chain read endpoint (Migration 3 dependency)
- Any `Watchlist` CRUD endpoint (Migration 4 dependency)
- A TradingView Datafeed-shaped adapter (depends on Candle)

## 3. WebSocket events

**None exist.** Confirmed by:
- No `@nestjs/websockets` or `socket.io` dependency anywhere in `services/api/package.json`.
- No `*.gateway.ts` file or any WebSocket/socket.io reference anywhere in the monorepo.

All market data today is **pull-only** — the client polls `GET /market-data/*` endpoints. `ARCHITECTURE.md`'s "push via future WebSocket gateway (Step 7)" plan is unimplemented; this is a known, deliberate gap (real-time push is a later step, not a Migration 1–4 dependency).

## 4. Seeded instruments (live DB, post-seed)

17 `Instrument` rows, all `source: 'simulated'` quotes:

**Indices (5)** — `type: INDEX`, all `lotSize: 1`:
| Symbol | Display name | Exchange |
|---|---|---|
| NIFTY | NIFTY 50 | NSE |
| BANKNIFTY | NIFTY BANK | NSE |
| FINNIFTY | NIFTY FIN SERVICE | NSE |
| MIDCPNIFTY | NIFTY MIDCAP SELECT | NSE |
| SENSEX | BSE SENSEX | BSE |

**Options (12)** — `type: OPTION`, expiry `2026-07-30`:
- Underlying `NIFTY` (lot size 75): strikes 24700/24800/24900, CE + PE each → 6 contracts
- Underlying `BANKNIFTY` (lot size 35): strikes 52600/52700/52800, CE + PE each → 6 contracts

No `EQUITY`-type instruments are seeded yet — only indices and their option chains. Individual stock support is unaddressed in the current seed data (not blocked by schema — `Instrument.type` already supports `EQUITY` — just not yet populated).

## 5. Current provider abstraction

**Two independent implementations exist today — this is a known duplication, not a designed redundancy (see §7):**

### 5a. `services/api`'s `SimulatedEngineService` (the one wired into production reads)
- A deterministic mean-reverting random walk (discrete Ornstein-Uhlenbeck), anchored to the instrument's `previousClose`, stepped in 1-minute buckets across the real NSE session window (09:15–15:30 IST).
- Seeded from `(symbol, trading-day)` — reproducible within a day, time-varying and internally consistent (OHLC/bid-ask/volume all derived from the same walk).
- Every `MarketDataService.enrich()` call **recomputes the full session path from scratch** (up to 375 minute-iterations near market close) and persists the result onto `Quote` — this is the refactor-later item flagged in `MARKET-DATA-ARCHITECTURE.md` §4 (should derive from persisted 1-minute `Candle` bars once they exist, not recompute per request).
- Not behind the `MarketDataProvider` interface (§5b) — it's a standalone NestJS service specific to `services/api`.

### 5b. `@tradew/types`'s `MarketDataProvider` interface (used by `services/sentinel` only)
```typescript
interface MarketDataProvider {
  readonly name: string;
  getQuote(symbol): Promise<Quote>;
  getCandles(symbol, interval, from, to): Promise<Candle[]>;
  getOptionChain(symbol, expiry?): Promise<OptionChainEntry[]>;
  getMarketBreadth(): Promise<MarketBreadth>;
  getNews(symbols?, sinceHours?): Promise<NewsItem[]>;
  healthCheck(): Promise<boolean>;
}
```
Designed as the swappable contract locked in decision Q6 — simulation today, real providers (Dhan, free NSE/BSE sources) later, with consumers (Sentinel, TradeW AI, charts) never knowing which is behind it.

**Only one implementation exists: `services/sentinel`'s `SimMarketDataProvider`** — a fully separate, self-contained deterministic simulator:
- Different price anchors (hardcoded base prices per symbol pattern, not read from `Instrument`/`Quote`).
- Different randomization (a basic seeded PRNG random walk, not the OU/mean-reversion model in §5a).
- **Generates candles/quotes/option-chains ephemerally, per call — nothing is persisted.** `getCandles()` produces up to 500 synthetic bars on demand and returns them; nothing is written to Postgres.
- Never touches the `Quote` Prisma model or any database table.

**Net effect:** TradeW currently has two unrelated fake markets — one backing the public `/market-data/*` API (§5a, persisted, real Instrument-anchored), and one backing Sentinel's internal signal computation (§5b, ephemeral, Instrument-independent). They will not agree with each other if queried for the same symbol at the same moment. This is flagged as technical debt in §7, with direct relevance to Migration 2 scope.

## 6. Current limitations

- **No historical time series.** `Candle` does not exist yet (Migration 2). Every "historical" read anywhere in the system today is synthetic/regenerated, not real persisted history.
- **No live provider.** No Dhan/TrueData/broker SDK is wired in anywhere. All data, in both provider implementations (§5), is honestly labeled `source: 'simulated'`.
- **No push/realtime layer.** Pull-only polling (§3).
- **No Level II depth.** Only best bid/ask on `Quote` — by design (`MARKET-DATA-ARCHITECTURE.md` §3), not a gap to close later.
- **No option Greeks/OI/IV storage.** `OptionMetrics` does not exist yet (Migration 3) — options are `Instrument` rows only (strike/expiry/type), the option chain UI has no real OI/IV/Greeks data source.
- **No corporate actions or watchlists.** Neither `CorporateAction` nor `Watchlist`/`WatchlistItem` exist yet (Migration 4).
- **No equity instruments seeded** — only indices and their option chains (§4). Individual stock quotes are entirely unpopulated.
- **`enrich()` recomputes per request.** No incremental persistence of the simulated walk — every read replays the session from minute zero (§5a). Fine at current traffic; a documented future refactor once `Candle` exists.

## 7. Known technical debt

| Item | Severity | Detail |
|---|---|---|
| **`bcrypt.hash is not a function`** | Medium — blocks demo-account seeding only | `packages/database/prisma/seed.ts`'s `seedDemoAccount()` fails under `ts-node`'s ESM/CJS interop (module auto-detected as ESM because of top-level syntax, causing `import * as bcrypt from 'bcryptjs'` to resolve to a wrapped `{default: ...}` shape instead of the flattened CJS export). Confirmed pre-existing via `git diff` — unrelated to Migration 1. Does not affect any Quote/market-data write path; blocks only the `founder@tradew.local` demo account from being seeded. **Not fixed** — flagged for a dedicated follow-up, out of Migration 1's scope. |
| **Duplicate simulated-market implementations** | High — directly relevant to Migration 2 | Two independent, disagreeing fake markets exist (§5). `services/sentinel`'s `SimMarketDataProvider.getCandles()` already returns a `Candle[]` shape (from `@tradew/types`) that is **not backed by any table** — once Migration 2 creates a real Postgres `Candle` model, this in-memory generator will either need to be replaced with real reads (ideal) or will silently keep diverging from persisted history (risk). This should be an explicit design question at the start of Migration 2, not discovered mid-implementation. |
| **`SimulatedEngineService` recomputes from scratch per request** | Low today, becomes real once `Candle` exists | Flagged in `MARKET-DATA-ARCHITECTURE.md` §4 as the intended refactor point: once 1-minute bars are persisted incrementally, `Quote`'s live OHLC should derive from aggregating those bars rather than an independent replay. Migration 2 is the natural point to address this. |
| **No `EQUITY` instruments seeded** | Low | Schema supports it (`InstrumentType.EQUITY` already exists); seed data doesn't populate any. Blocks any equity-specific testing until seed data is extended — a data-only fix, no schema change needed. |
| **No ESLint configured anywhere in the repo** | Low, process-only | Confirmed absent at both repo root and `services/api` (no config file, no dependency). Not a Migration 1 regression — pre-existing gap. TypeScript (`tsc --noEmit`) is the only static-analysis gate currently in place. |
| **Non-concurrent index creation** | Low at current scale | Migration 1's `CREATE UNIQUE INDEX` was non-concurrent (Prisma's transaction-wrapped migrations don't support `CONCURRENTLY`). Fine at 17 rows; flagged for the ops runbook once `Quote` is under real production write load — future migrations on hot tables should consider a manually-split concurrent-index migration. |
| **No real-time push (WebSocket)** | Low, deferred by design | `ARCHITECTURE.md` names this as Step 7, explicitly later than the Candle/OptionMetrics/Watchlist migrations. Not a gap introduced by this work. |

## 8. Migration history to date

| # | Migration | Applied | What it did |
|---|---|---|---|
| 1 | `20260710000000_init` | 2026-07-10 | Original schema — `User`, `Instrument`, `Quote` (original shape: `id/instrumentId/ltp/previousClose/updatedAt/createdAt` only, no OHLC/bid/ask/volume/source/unique), `Order`, `Trade`, `Position`, etc. |
| 2 | `20260710000100_sprint1_identity` | 2026-07-10 | Identity/auth-related additions (no `Quote` changes) |
| 3 | `20260716000000_ai_foundation_entitlements` | 2026-07-16 | `MemoryRecord`/`MemoryRelation` (pgvector Brain foundation), `Plan`/`PlanGrant`/`Subscription`/`EntitlementOverride`/`UsageCounter` (entitlement architecture) — no `Quote` changes |
| 4 | `20260718000000_market_data_quote_revision` | 2026-07-18 | **Migration 1, part A.** Added `source` (default `'simulated'`) and `@@unique([instrumentId])` to `Quote` |
| 5 | `20260718000001_market_data_quote_ohlc_fields` | 2026-07-18 | **Migration 1, part B** — discovered and applied mid-execution. Added `open/high/low/bid/ask/volume` to `Quote`, closing pre-existing drift between `schema.prisma` (which had declared these fields during the earlier architecture-review conversation) and the actual database (which had never migrated them). Confirmed via live-DB diff: zero drift remaining after this migration. |

**Migrations 4 and 5 together constitute the full, originally-approved "Migration 1" scope.** No Migration 2 (Candle), Migration 3 (OptionMetrics), or Migration 4 (CorporateAction/Watchlist) work — as sequenced in `MARKET-DATA-ARCHITECTURE.md` §6 — has been started.

---

## Next step

**Update 2026-07-21:** a Dhan integration plan now exists — [`DHAN-MARKET-DATA-INTEGRATION.md`](DHAN-MARKET-DATA-INTEGRATION.md) — written against the DhanHQ v2 docs. Two things there change the sequencing assumed below:

1. **The live provider cannot be a drop-in swap.** Dhan's Market Quote REST API is capped at 1 request/second account-wide, so §5a's per-request `enrich()` model is structurally incompatible with it. Live quotes must arrive over Dhan's WebSocket feed into a separate ingestor, with `services/api` reads becoming pure cache reads. That is an architectural inversion, not a provider substitution.
2. **Two phases are unblocked today** and worth doing before Migration 2: syncing the Dhan scrip master (gives `Instrument` a broker-agnostic `securityId`, and closes the no-`EQUITY`-seeded gap in §4), and collapsing the duplicate simulators in §5/§7 behind the `MarketDataProvider` interface. Neither calls Dhan's API, and both are prerequisites for a clean cutover.

Migration 2 (`Candle`) remains next in the *schema* sequence. Per §7's flagged debt, the Migration 2 design pass should explicitly decide how (or whether) `services/sentinel`'s in-memory `SimMarketDataProvider.getCandles()` gets reconciled with the new persisted `Candle` table, rather than leaving two disagreeing candle sources in production.
