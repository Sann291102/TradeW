# Chapter 12 — Market Data

**Status: 🟡.** The instrument master, provider abstraction, binary parser, OU simulator, token bucket, and quote cache are 🟢. The live Dhan WebSocket transport is built but **not wired**. `Candle`, `OptionMetrics`, and `CorporateAction` are 🔵 (Migrations 2–4, none applied).

---

## 12.1 The constraint that shaped everything

> **Dhan's Market Quote REST API is limited to 1 request per second, account-wide.**

Everything in this chapter follows from that single number. Before it was discovered, the read path looked like this:

```
   TODAY (the bug)     request ──► simulate ──► persist ──► respond
                                   ▲
                            a READ with SIDE EFFECTS,
                            executed per request, per instrument
```

Every call to `GET /market-data/quotes` computed a fresh quote and wrote it to Postgres. Point that at Dhan and **one dashboard load with five indices exhausts the per-second budget five times over.**

So the fix was not a provider swap. The data flow had to invert:

```
   TARGET              Dhan WS ──► ingest ──► Redis + Postgres    (write path, continuous)
                       request ──► read cache ──► respond          (read is PURE)
```

Three architectural consequences, all now in the codebase:

1. **`services/api` no longer generates quotes.** It reads.
2. **`services/market-data` became the sole writer, and a singleton.** The broker feed connection set is a per-account resource; a second replica is not more throughput, it is a rate-limit violation and a blown connection cap.
3. **The two divergent simulators collapsed into `packages/market-data`.**

This is the clearest example in the platform of an external constraint dictating an internal service boundary — which is the normal case, not the exception.

---

## 12.2 The full constraint table

Extracted from the DhanHQ v2 documentation and, in four places, from running against the live API.

| Constraint | Value | Consequence |
|---|---|---|
| Market Quote REST | **1 req/sec**, ≤1,000 instruments/request | Cannot serve per-request reads. Batch + cache only. |
| Option Chain REST | **1 req per 3 sec** per underlying/expiry | Hard ceiling on chain freshness |
| Data APIs | 5 req/sec | Backfill throughput ceiling |
| Data APIs daily | **Docs contradict: 7,000 or 100,000** | Design for 7,000 |
| WebSocket connections | 5 per user | — |
| WebSocket instruments | 5,000 per connection | 25,000 ceiling. Ample. |
| Subscribe message | ≤100 instruments per JSON message | Chunk subscription messages |
| Keepalive | Server pings every 10 s; closes after 40 s silence | Supervised reconnect is mandatory |
| Encoding | **Little-endian packed binary** | Custom parser required; no JSON |
| Historical intraday | 1/5/15/30/60-min, last 5 years | Fuels Migration 2 (`Candle`) |
| Historical daily | Back to instrument inception | Long-horizon data |
| Rolling options history | 45 days/call, 5 years back, minute-level, **including IV + OI + spot** | High value for Sentinel |
| Instrument master | Static CSV, **no rate limit** | Do this first — it unblocks everything |
| Access token (individual) | **24-hour validity** | Unattended renewal is mandatory |
| API key/secret | 12-month validity | Preferred over raw tokens |
| Data APIs | **Charged separately** | Commercial decision, unresolved |

### 12.2.1 The packet-size economics

```
   Ticker packet   16 bytes/instrument/tick     LTP + trade time
   Quote packet    ~50 bytes                    + OHLC, volume, bid/ask
   Full packet    162 bytes                     + L2 depth (5 levels), OI
```

**A Full packet is ~10× a Ticker packet.** So subscription mode is a per-instrument decision, not a global setting:

| Instrument state | Mode |
|---|---|
| On screen, chart open, option chain open | `full` |
| In a watchlist row | `quote` |
| Held in a position, off screen | `quote` |
| Universe scan, background | `ticker` |

This tiering is why `FeedMode` is a first-class provider-neutral type rather than a Dhan implementation detail.

---

## 12.3 Architecture

```
                Dhan WS (binary, ≤5 conns)      Dhan REST (5/sec)
                         │                              │
                         ▼                              ▼
        ┌────────────────────────────────────────────────────────┐
        │  services/market-data          SINGLETON BY DESIGN     │
        │                                                        │
        │   ┌──────────────────┐  ┌─────────────────────────┐    │
        │   │ WS supervisor    │  │ TokenBucket             │    │
        │   │ + reconnect      │  │ quote: 1/s              │    │
        │   └────────┬─────────┘  │ chain: 1/3s             │    │
        │            │            │ data:  5/s              │    │
        │   ┌────────▼─────────┐  └─────────────────────────┘    │
        │   │ binary parser    │                                 │
        │   │ (pure, sync)     │  ┌─────────────────────────┐    │
        │   └────────┬─────────┘  │ 1-min candle aggregator │    │
        │            │            └─────────────────────────┘    │
        │            ▼                                           │
        │      MarketTick (normalised)                           │
        └────────────┬───────────────────────┬───────────────────┘
                     │                       │
              ┌──────▼──────┐        ┌───────▼────────────────┐
              │ hot cache   │        │ Postgres               │
              │ (in-memory  │        │ Quote (coalesced 2–5s) │
              │  today,     │        │ Candle 🔵              │
              │  Redis 🔵)  │        │ OptionMetrics 🔵       │
              └──────┬──────┘        └───────┬────────────────┘
                     └───────────┬───────────┘
                                 ▼
                         services/api   (PURE reads)
                                 │
                                 ▼
                             apps/web
```

### 12.3.1 The write-throttling ladder

Ticks arrive tick-by-tick. Writing each to Postgres would be both wasteful and pointless:

| Destination | Cadence | Why |
|---|---|---|
| Hot cache | every tick, or coalesced at ~250 ms | This is what reads hit |
| `Quote` | coalesced every 2–5 s per instrument | It is a **latest-value snapshot**. Nothing is lost by throttling — the previous value was going to be overwritten anyway. |
| `Candle` 🔵 | one write per instrument per minute close | Aggregated in the ingestor |

That `Quote` is a latest-snapshot table, not a time series, is the fact that makes throttling free. It is also the fact that took an architecture review to establish (§12.7.1).

---

## 12.4 The rate budget arithmetic

Worth walking, because it is what determines what the product can offer.

### Live quotes — solved by WebSocket

```
   REST:  1 req/sec × 1,000 instruments = 1,000 instrument-updates/sec
          but ONE request per second, account-wide, shared by ALL users

   WS:    5 connections × 5,000 instruments = 25,000 instruments
          pushed continuously, no per-request budget

   ⇒ Live quotes MUST come from WS. REST becomes a
     fallback / reconciliation tool, never the primary path.
```

### Option chain — the genuine ceiling

```
   1 request per 3 seconds, per (underlying, expiry)

   NIFTY weekly + NIFTY monthly + BANKNIFTY weekly + FINNIFTY
   = 4 chains

   4 chains × 3 s = 12 s for a full round of every chain
   ⇒ any given chain refreshes at best every 12 seconds
```

**Product consequence:** the option chain cannot be a tick-level surface. The UI must show a refresh timestamp and must not animate as though it were live. Pretending otherwise would be a lie in the interface, and an options trader will notice within a minute.

Adding a fifth chain pushes the round to 15 s. Every additional supported chain degrades all of them, which makes "which chains do we support?" a real product decision with a measurable cost.

### Historical backfill

```
   5 req/sec, 7,000/day (design for the pessimistic figure)

   Backfilling 5 years of 1-minute candles for 200 instruments:
     ~1,250 trading days × 375 bars = ~470k bars per instrument
     at 45-day chunks ≈ 28 requests per instrument
     200 instruments × 28 = 5,600 requests

   ⇒ roughly ONE DAY of the daily budget for a 200-instrument backfill.
     Feasible, but it is a scheduled operation, not something
     triggered by a user action.
```

---

## 12.5 The instrument master 🟢

**Code:** `packages/market-data/src/providers/dhan/dhan-scrip-master.ts` · `services/market-data/scripts/sync-scrip-master.ts`

The first thing built, because it has **no rate limit** and everything else depends on it: every Dhan REST call and WebSocket subscription addresses an instrument by `(exchangeSegment, securityId)`, never by symbol. Without those columns, no Dhan request can be constructed at all.

### 12.5.1 The schema addition

```prisma
model Instrument {
  symbol      String @unique   // platform-canonical lookup key
  // ---- Broker identity ----
  securityId           String?   // Dhan exchange-standard security ID
  exchangeSegment      String?   // NSE_EQ | NSE_FNO | BSE_EQ | BSE_FNO | MCX_COMM | IDX_I
  isin                 String?
  dhanInstrument       String?   // EQUITY | INDEX | OPTIDX | OPTSTK | FUTIDX | ...
  series               String?
  expiryFlag           String?   // M (monthly) | W (weekly)
  tradingSymbol        String?   // broker-native — NOT unique across exchanges
  underlyingSecurityId String?   // plain reference, NOT an FK

  active           Boolean   @default(true)   // soft delete
  metadataSource   String?                    // 'dhan-scrip-master' | 'seed'
  metadataSyncedAt DateTime?

  @@unique([exchangeSegment, securityId])
}
```

### 12.5.2 Four facts the Dhan docs omit

Discovered by running against the live master rather than reading about it. Each changed the importer's design:

**1. `tradingSymbol` is not unique across exchanges.** The same trading symbol appears on NSE and BSE. Making it the lookup key would silently collide two instruments. Hence `symbol` (platform-canonical, `@unique`) is separate from `tradingSymbol` (broker-native, non-unique), with a comment stating exactly why:

> *"Platform-canonical lookup key. Deliberately kept globally unique so `findUnique({ where: { symbol } })` — used by `/market-data/quote-by-symbol` — keeps working. The broker-native symbol lives in `tradingSymbol`."*

**2. `underlyingSecurityId` cannot be a foreign key.** A derivative's underlying may not be imported under the current segment allowlist (`IDX_I` + `NSE_EQ`). An FK would make the import order matter and would fail on perfectly valid rows. It is stored as a plain reference.

**3. `FUTURE` had to be added to `InstrumentType`.** The master classifies `FUTIDX`/`FUTSTK` contracts. Without the enum value they would have to be mislabelled as `EQUITY` or dropped. The schema comment notes it is not reachable under the default allowlist — *"it matters when F&O segments are enabled"* — which is exactly the kind of note that stops a future engineer deleting an apparently-unused enum value.

**4. `Instrument.symbol`'s uniqueness bounds all future imports.** Enabling a new segment must not produce a symbol collision with an existing row. This is a real constraint on segment expansion and is recorded in the vault.

### 12.5.3 Soft delete

```prisma
/// Soft-delete flag. Delisted instruments are deactivated, never removed —
/// CLAUDE.md Rule 1, and Order/Trade/Position rows reference them forever.
active Boolean @default(true)
```

A trade from 2026 in a stock delisted in 2027 must still render its symbol in 2030.

---

## 12.6 The provider abstraction 🟢

**Code:** `packages/market-data/src/contracts/`

### 12.6.1 `MarketTick` — the unit the pipeline moves

```ts
export interface MarketTick {
  ref: InstrumentRef;
  at: Date;        // when the EXCHANGE reported it, not when we received it
  source: string;  // becomes Quote.source — simulated and live can never be conflated

  ltp?: number; lastTradedQuantity?: number; averageTradePrice?: number;
  volume?: number; totalBuyQuantity?: number; totalSellQuantity?: number;
  open?: number; high?: number; low?: number;
  close?: number;          // only sent post-close by Dhan
  previousClose?: number;
  openInterest?: number; dayHighOpenInterest?: number; dayLowOpenInterest?: number;
  bid?: number; ask?: number;
  depth?: DepthLevel[];    // realtime-only — NEVER persisted
}
```

### 12.6.2 Why every field is optional

The contract's own comment is the specification:

> *"Every field except `ref`, `at` and `source` is optional because feed modes differ in what they carry — Dhan's Ticker packet has only LTP and trade time, its Quote packet adds OHLC and volume, its Full packet adds depth and OI. **A consumer must be able to tell 'not sent in this mode' from 'sent as zero'**, so absent fields are `undefined` rather than defaulted."*

That distinction is not pedantry. `volume: 0` means "no volume traded"; `volume: undefined` means "this feed mode does not carry volume." A consumer that defaults `undefined` to `0` will compute a 20-bar average volume of zero, then divide by it, then report that the breakout volume is `Infinity%` of average.

### 12.6.3 `source` — the anti-conflation field

`MarketTick.source` becomes `Quote.source`. One string prevents the entire class of bug where a simulated price is presented as, or compared against, a real one. Chapter 11 §11.10 exists because that distinction was taken seriously.

### 12.6.4 `at` is exchange time, not receive time

Also a one-line comment protecting a real property: latency, gaps, and out-of-order arrival are all measurable only if the timestamp is the exchange's.

---

## 12.7 The persistence model

### 12.7.1 `Quote` is a latest-snapshot table 🟢

Established by an architecture review, with evidence rather than assumption. The review's finding: `Quote` represents **the latest snapshot per instrument**, one row, updated in place — not a time series.

```prisma
model Quote {
  instrumentId String @unique        // ← ONE row per instrument
  ltp          Decimal
  previousClose Decimal?
  open Decimal?  high Decimal?  low Decimal?
  bid  Decimal?  ask  Decimal?
  volume BigInt?
  source String @default("simulated")
  updatedAt DateTime @updatedAt
}
```

The `@unique` on `instrumentId` **enforces** the semantics. Before the review it was absent, and nothing stopped a second row appearing — at which point "the quote for NIFTY" becomes ambiguous.

Two things came out of that review that are worth generalising:

- **The `source` field did not previously exist.** Simulated and live prices were indistinguishable in the database.
- **Always diff a proposed migration against the live DB**, not just `schema.prisma`. The review found pre-existing drift: `schema.prisma` had columns no migration had ever shipped, because the file had been edited ahead of any migration during a design conversation.

### 12.7.2 `Candle` — Migration 2 🔵

Blocked and blocking. Needed by **Charts** and by **Sentinel's trap detection**, which currently runs against an ephemeral simulator.

```prisma
model Candle {                    // 🔵 SPECIFIED
  instrumentId String
  timeframe    String            // '1m' | '5m' | '15m' | '1h' | '1d'
  openTime     DateTime
  open High Low Close  Decimal
  volume       BigInt
  openInterest BigInt?
  source       String

  @@unique([instrumentId, timeframe, openTime])
  @@index([instrumentId, timeframe, openTime])
}
```

**Blocked on OD-6:** two disagreeing simulated market engines must be reconciled first. Partially addressed by the collapse into `packages/market-data`; not finished.

### 12.7.3 `OptionMetrics` — Migration 3 🔵

Deliberately **separate from `Quote`**, on cardinality and write-pattern grounds:

```
   Quote          ~2,000 rows      updated every 2–5 s
   OptionMetrics  ~40 strikes × 2 sides × 4 chains
                  = ~320 rows per snapshot
                  updated every 12 s (chain rate limit)
                  carries IV, OI, ΔOI, Greeks — none of which Quote has
```

Different cardinality, different cadence, different columns. Forcing them into one table would give every equity quote a set of permanently-null option columns and would make the write pattern of one dictate the other.

### 12.7.4 Depth is never persisted 🔵

```
   depth?: DepthLevel[];   // Realtime-only — NEVER persisted
```

Level-2 depth is a five-level ladder changing many times per second. Persisting it would produce enormous write volume for data whose value expires in under a second. It streams to the UI and is discarded.

### 12.7.5 `CorporateAction` — Migration 4 🔵

Splits, bonuses, dividends, mergers. **Historical prices must be adjusted**, or every long-horizon chart and every backtest is wrong at each corporate action.

The design decision: store the **unadjusted** price and the adjustment factors separately, applying adjustment at read time. Storing adjusted prices means every new corporate action requires rewriting history — which violates archive-never-delete and makes any cached or exported series silently stale.

---

## 12.8 The simulated market 🟢

**Code:** `packages/market-data/src/providers/simulated/ou-engine.ts`

### 12.8.1 What it replaced

Its docstring is a small case study in resolving duplicated logic:

> *"Moved verbatim (behaviour-preserving) from `services/api/src/market-data/simulated-engine.service.ts`, which was the better of the two simulators that previously existed: it is anchored to each instrument's real `previousClose` and models mean reversion, where `services/sentinel`'s copy used hardcoded per-symbol base prices and a plain random walk. **Those two disagreed on the same symbol at the same instant** — flagged High severity."*

Two simulators disagreeing on the same symbol at the same instant is not a cosmetic bug: Sentinel would compute a signal from one price while the UI showed another, and the resulting observation would cite evidence the user could not see.

The resolution: keep the better one, move it **verbatim** (behaviour-preserving, so the move itself introduces no change), and make it framework-free.

### 12.8.2 Framework-free on purpose

> *"Framework-free on purpose (no NestJS import) so the ingestor, the API and Sentinel can all use it without pulling a DI container into a shared package."*

A shared package that imports a DI framework forces every consumer to adopt that framework. Plain functions and classes are consumable by anything.

### 12.8.3 The model

```ts
const IST_OFFSET_MIN     = 330;              // UTC+5:30
const SESSION_OPEN_MIN   = 9 * 60 + 15;      // 09:15
const SESSION_CLOSE_MIN  = 15 * 60 + 30;     // 15:30
const SESSION_LENGTH_MIN = 375;

const VOL_PER_MINUTE       = 0.00055;  // ≈1.07% session stdev (√375 × vol)
const MEAN_REVERSION_THETA = 0.015;    // pulls the walk gently back to the anchor
```

A discrete **Ornstein–Uhlenbeck** process — a mean-reverting random walk — anchored to each instrument's real `previousClose`, stepped in one-minute buckets across the actual NSE session.

### 12.8.4 Why mean-reverting and not a random walk

```
   RANDOM WALK                      ORNSTEIN-UHLENBECK

   price drifts arbitrarily far     price oscillates around an anchor
   from any anchor
                                    ⇒ support and resistance EXIST
   ⇒ no support, no resistance      ⇒ swingLevels() finds real levels
   ⇒ swingLevels() finds noise      ⇒ bull_trap / bear_trap / liquidity_sweep
   ⇒ trap detectors NEVER fire        actually trigger
   ⇒ Sentinel is untestable         ⇒ Sentinel is testable at 3am in July
      outside market hours
```

**This is why the OU choice is load-bearing rather than a flourish.** A random-walk simulator would make the entire trap-detection system undevelopable outside market hours, which in practice means undevelopable.

### 12.8.5 Determinism

> *"Deterministic — seeded from (symbol, trading-day) — so repeated calls within a day reproduce the same path, giving a genuinely time-varying but reproducible series across restarts and processes."*

Consequences: two processes computing the same symbol on the same day agree; a service restart does not teleport the price; and a bug is reproducible tomorrow by replaying the same seed. All three matter and none are obvious until you have debugged without them.

---

## 12.9 The Dhan binary parser 🟢

**Code:** `packages/market-data/src/providers/dhan/dhan-binary-parser.ts`

### 12.9.1 Why it is pure and synchronous

> *"It is pure and synchronous — no network, no credentials — which is deliberate: **the riskiest part of the WebSocket integration is byte-offset arithmetic**, and this way it is fully verifiable before a live connection ever exists."*

This is excellent engineering judgement. Byte-offset arithmetic against a documented layout is exactly the kind of code that is silently wrong, and testing it against a live socket means testing it during market hours with real credentials. Making it a pure function over a `Buffer` means it can be tested with a hex literal, at any time, with no account.

`packages/market-data/scripts/verify-parser.ts` exists for exactly that.

### 12.9.2 The packet format

```
   Every packet, 8-byte header:

   byte  0     uint8   feed response code
   bytes 1-2   int16   message length      (little-endian)
   byte  3     uint8   exchange segment code
   bytes 4-7   int32   security id         (little-endian)

   FEED_CODE = { TICKER: 2, QUOTE: 4, OI: 5, PREV_CLOSE: 6, FULL: 8, DISCONNECT: 50 }
```

**Little-endian.** Every multi-byte read is `readInt16LE` / `readInt32LE` / `readFloatLE`. Getting this backwards produces plausible-looking garbage rather than an error — prices in the millions, or negative volumes.

### 12.9.3 The tagged-union return

```ts
export type ParsedPacket =
  | { kind: 'tick';       tick: MarketTick }
  | { kind: 'disconnect'; code: number; securityId: string }
  | { kind: 'unknown';    header: PacketHeader };
```

`'unknown'` is a first-class outcome, not an exception. If Dhan adds a feed code, the parser returns `unknown` with the header intact — it logs and continues rather than crashing the ingestion loop. A protocol addition on the vendor's side must not be an outage on ours.

---

## 12.10 Rate limiting 🟢

**Code:** `packages/market-data/src/rate-limit/token-bucket.ts`

```ts
/**
 * These caps are the defining constraint of the whole integration, so they
 * are encoded once here rather than being re-derived at each call site:
 *
 *   · Market Quote  — 1 request/second
 *   · Option Chain  — 1 request per 3 seconds
 *   · Data APIs     — 5 requests/second
 *
 * `acquire()` waits rather than throwing, because every caller in this
 * codebase wants the call to happen slightly later, not to fail. Callers
 * that genuinely cannot wait should use `tryAcquire()`.
 */
```

Two design decisions worth copying:

**1. The limits are encoded once.** They are a business constraint, not a per-call-site detail. Re-deriving them at each call site guarantees one site eventually gets it wrong.

**2. `acquire()` waits; `tryAcquire()` is the escape hatch.** The default matches what every caller actually wants. A design where the default throws forces every call site to write the same retry loop, and one of them will write it wrong.

The injectable `now: () => number` makes the bucket testable without `setTimeout`.

---

## 12.11 Feed lifecycle 🟡

```ts
export type FeedStatus = 'idle' | 'connecting' | 'connected'
                       | 'reconnecting' | 'stopped' | 'error';

export interface FeedStatusEvent {
  status: FeedStatus; feed: string; at: Date;
  reason?: string;    // on 'error' and post-failure 'reconnecting'
  code?: number;      // Dhan sends disconnect codes on the wire
  attempt?: number;
}
```

`'stopped'` and `'error'` are distinct — a deliberate shutdown and a failure need different alerting. `attempt` makes backoff observable.

### 12.11.1 The keepalive constraint

```
   Dhan pings every 10 s.  Closes the connection after 40 s of silence.

   ⇒ the supervisor must respond to pings AND treat >40 s without a
     packet as a dead connection, even if the socket still reports open.
```

A TCP socket can remain "open" long after the peer has stopped caring. Application-level liveness is the only reliable signal.

### 12.11.2 Reconnect policy 🔵

```
   attempt 1  →  1 s
   attempt 2  →  2 s
   attempt 3  →  4 s
   attempt 4  →  8 s
   attempt 5+ →  30 s (capped)

   + jitter (±20%)
   + full resubscribe on reconnect (chunked ≤100 instruments per message)
   + gap detection: compare tick `at` before/after; backfill via REST
     if the gap exceeds one bar
```

**Gap detection matters more than reconnection.** A reconnect that silently loses two minutes of ticks produces a candle with a hole in it, and every indicator computed from that candle is wrong in a way nothing surfaces.

---

## 12.12 The live-feed bridge 🟡

**Code:** `services/market-data/scripts/live-feed-server.ts` (port 4600)

A standalone HTTP bridge exposing:

| Endpoint | Returns |
|---|---|
| `GET /quotes` | Snapshot: `{ marketOpen, indices[], stocks[], etfs[], commodities[] }` |
| `GET /instrument?symbol=` | Instrument metadata for resolution |

Consumed by `MarketPriceService` (the OMS — Chapter 11 §11.10) and the frontend's live-quote hooks.

### 12.12.1 Why a separate bridge

It is a pragmatic seam. The NestJS ingestor owns the durable write path (`Quote`, hot cache); the bridge exposes the *current real prices* to consumers that need them synchronously and cannot wait for a database round trip or tolerate the simulated default.

🔵 It should eventually be an endpoint on `services/market-data` proper rather than a script. It is listed as TD-8.

### 12.12.2 The bridge's own type mapping

```ts
const BRIDGE_TO_PRISMA_TYPE = {
  INDEX: 'INDEX', EQUITY: 'EQUITY',
  ETF: 'EQUITY',            // ETFs trade like equities — no dedicated enum value
  COMMODITY_FUT: 'FUTURE',
};
```

The bridge classifies more finely than the Prisma enum. Collapsing at the boundary is correct: adding `ETF` to `InstrumentType` would mean every consumer must handle a fifth case for an instrument that behaves identically to the fourth.

---

## 12.13 Error recovery

| Failure | Detection | Recovery | User impact |
|---|---|---|---|
| WS disconnect | ping timeout / close frame | exponential backoff + full resubscribe | quotes freeze briefly |
| Silent stall (socket open, no data) | >40 s without a packet | forced reconnect | as above |
| Rate limit hit | HTTP 429 | token bucket should prevent it; back off + alert | delayed refresh |
| Access token expired (24 h) | 401 | 🔵 unattended renewal | **total feed outage** |
| Malformed packet | parser returns `unknown` | log + continue | one tick lost |
| Bridge unreachable | fetch throws | `NotFoundException` from the OMS | order placement blocked with a clear message |
| Postgres down | Prisma throws | hot cache still serves reads | writes lost, reads degraded |
| Gap after reconnect | `at` comparison | 🔵 REST backfill | silent candle hole **if unhandled** |

### 12.13.1 The 24-hour token is an operational risk 🔵

Individual access tokens expire every 24 hours. Without unattended renewal, the feed dies once a day at an unpredictable time. Mitigations, in order of preference:

1. **Use API key + secret** (12-month validity) rather than a raw token — the documented preferred path
2. Automated token refresh with alerting on failure
3. Alert on feed outage lasting > 60 s during market hours

Option 1 removes the problem rather than managing it, which is why it is first.

---

## 12.14 Open decisions ⚠️

### OD-A — Partner account vs. per-user accounts (the big one)

| | **Platform data account** | **Per-user Dhan account** |
|---|---|---|
| Auth | one TradeW-held account | each user links their own Dhan login |
| Rate limits | 1 req/sec **shared across all users** | per user |
| WS capacity | 25,000 instruments total | 25,000 per user |
| Cost | TradeW pays one data subscription | user pays / partner billing |
| Onboarding | invisible to users | user must have a Dhan account |
| **Licensing** | ⚠️ **must be verified with Dhan in writing** | clearly permitted |

The platform-account model is far better product-wise and the architecture assumes it. **But redistributing one account's exchange data to many end users is a licensing question, not a technical one** — NSE/BSE license data redistribution separately.

**The engineering hedge:** the ingestor is designed to be per-credential-set either way, so the answer changes *configuration*, not architecture. That is the right way to handle a blocking external unknown — make the design indifferent to the answer.

### OD-B — Data API cost
The documentation states data APIs carry additional charges without naming them. Unresolved: monthly cost, whether it scales with instruments or users, whether backfill is metered separately from the live feed.

### OD-C — Static IP
Order APIs require IP whitelisting. Not needed for data APIs, but the OCI deployment should reserve a static IP **now** if orders are ever in scope — retrofitting into a running deployment is disruptive.

### OD-D — The contradictory daily quota
The docs state both 7,000 and 100,000 requests/day in different places. Designed for 7,000. Worth confirming, because it changes backfill planning by an order of magnitude.

---

## 12.15 Implementation phases

| Phase | Scope | Status |
|---|---|---|
| **1** | Instrument master sync — no live data, no rate limits, no blockers | 🟢 complete |
| **2** | Provider abstraction consolidation + the read-path inversion | 🟢 complete |
| **3** | Historical backfill → `Candle` (Migration 2) | 🔵 untouched |
| **4** | Live WS feed | 🟡 lifecycle, parser, cache, persistence built; **transport not wired** |
| **5** | Option chain → `OptionMetrics` (Migration 3) | 🔵 untouched |
| **6** | Push to frontend (SSE/WS fan-out) | 🔵 untouched |

**Phase 1 was first because it has no rate limit and unblocks everything else.** That sequencing decision — do the unconstrained, unblocking thing first — is the reason the rest of the integration could be built and verified without a live connection.

---

## 12.16 Testing 🔴

### Tier 1 — the binary parser ⭐

The highest-value test target in the package, and the easiest, because the parser is pure:

```ts
it('reads a little-endian header correctly',        …);
it('parses a Ticker packet (16 bytes)',             …);
it('parses a Quote packet with OHLC and volume',    …);
it('parses a Full packet with 5 depth levels and OI',…);
it('returns kind=unknown for an unrecognised code', …);
it('returns kind=disconnect with the wire code',    …);
it('leaves fields absent that the mode does not carry', …);  // ← NOT zero
it('does not throw on a truncated buffer',          …);
```

That last one matters: a partial TCP read must not crash the ingestion loop.

### Tier 2 — the OU engine

```ts
it('is deterministic for the same (symbol, trading day)', …);
it('reverts toward previousClose over a long horizon',    …);
it('returns marketStatus closed outside 09:15–15:30 IST', …);
it('produces the same path across two processes',         …);
```

### Tier 3 — the token bucket

```ts
it('permits 1 request per second for the quote bucket',   …);
it('makes acquire() wait rather than throw',              …);
it('makes tryAcquire() return false rather than wait',    …);
it('refills at the configured rate', /* injected now() */ …);
```

---

*Next: [Chapter 13 — Chart Engine](13-chart-engine.md)*
