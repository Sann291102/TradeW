# Dhan Market Data Integration — Plan

Status: **Phases 1–2 implemented and verified (2026-07-21); Phase 4 infrastructure built but not enabled.** Derived from a full read of the DhanHQ v2 API documentation against the current state in [`MARKET-DATA-BASELINE.md`](MARKET-DATA-BASELINE.md).

> **Implementation note.** What shipped maps onto the phases below as: Phase 1 complete (instrument master), Phase 2 complete (provider consolidation + the read-path inversion from §1), Phase 4 partially complete (feed lifecycle, binary parser, cache and persistence pipelines built; live Dhan transport not wired). Phases 3 and 5 are untouched.
>
> Four things about the real scrip master, discovered by running against it rather than reading the docs, are recorded in §11 — they materially changed the importer's design. Governed by [`MARKET-DATA-ARCHITECTURE.md`](MARKET-DATA-ARCHITECTURE.md) (the long-term schema this must execute against) and [`TRADEW-OS.md`](TRADEW-OS.md).

**Scope: market data only.** Order placement, funds, positions and eDIS are explicitly out of scope. They are a separate integration with different rules (`ARCHITECTURE.md` §3, static-IP whitelisting, and the no-AI-initiated-trades boundary in §1.3). Nothing in this plan puts Dhan in the order path.

---

## 1. The finding that reshapes everything

**Market Quote APIs are limited to 1 request per second, account-wide.**

The current read path is incompatible with that. Today, every call to `GET /market-data/quotes` runs `MarketDataService.enrich()`, which computes a fresh simulated quote and writes it to Postgres — a read *with side effects*, executed per request, per instrument ([baseline §5a](MARKET-DATA-BASELINE.md)). Point that at Dhan and a single dashboard load with 5 indices exhausts the per-second budget five times over.

So this is **not a provider swap.** The data flow has to invert:

```
TODAY     request ──► simulate ──► persist ──► respond        (read has side effects)

TARGET    Dhan WS ──► ingest ──► Redis + Postgres             (write path, continuous)
          request ──► read cache ──► respond                  (read is pure)
```

Live quotes must come from the **WebSocket feed**, not the REST quote API. REST quotes become a fallback/reconciliation tool, not the primary path. Everything else in this plan follows from that.

---

## 2. Constraints extracted from the docs

| Constraint | Value | Consequence |
|---|---|---|
| Market Quote REST | **1 req/sec**, max 1,000 instruments/request | Cannot serve per-request reads. Batch + cache only. |
| Option Chain REST | **1 req per 3 sec** per underlying/expiry | Hard ceiling on chain freshness. See §6 budget. |
| Data APIs | 5 req/sec | Backfill throughput ceiling. |
| Data APIs daily | **Contradictory — 7,000 or 100,000** (§7) | Design for 7,000. |
| WebSocket | 5 connections/user, 5,000 instruments each | 25,000 instrument ceiling. Ample. |
| WebSocket subscribe | ≤100 instruments per JSON message | Chunk subscription messages. |
| WebSocket keepalive | Server pings every 10s; closes after 40s silence | Needs supervised reconnect. |
| Binary encoding | **Little-endian** packed structs | Custom parser required; no JSON. |
| Historical intraday | 1/5/15/30/60-min, last 5 years | Fuels Migration 2 (`Candle`). |
| Historical daily | Back to instrument inception | Long-horizon backtest data. |
| Rolling options | 45 days/call, 5 years back, minute-level, incl. **IV + OI + spot** | High value for Sentinel; see §5.5. |
| Instrument master | Static CSV download | No rate limit. Do this first. |
| Access token (individual) | **24-hour validity** | Unattended renewal is mandatory. |
| API key/secret | 12-month validity | Preferred over raw tokens. |
| Data APIs | **Charged separately** (trading APIs are free) | Commercial decision, §3. |

---

## 3. Blocking decisions — needed before any code

These are yours, not engineering's. Each changes the design materially.

### 3.1 Partner account vs. per-user accounts — the big one

Dhan splits users into **Individual** (build your own system) and **Partner** (platforms serving *their* users). TradeW is unambiguously the latter shape.

Two viable models, with very different implications:

| | **Platform data account** | **Per-user Dhan account** |
|---|---|---|
| Auth | One TradeW-held account | Each user links their own Dhan login |
| Rate limits | 1 req/sec **shared across all users** | Per user |
| WS capacity | 25,000 instruments total | 25,000 per user |
| Cost | TradeW pays one data subscription | User pays / partner billing |
| Onboarding | Invisible to users | Users must have a Dhan account |
| **Licensing** | **Must be verified with Dhan** | Clearly permitted |

The platform-account model is far better product-wise (no user friction, works for non-Dhan customers), and the architecture in §4 assumes it — a single ingestor fanning out to all users. **But redistributing a single account's market data to many end users is a licensing question, not a technical one.** Exchange data redistribution in India is separately licensed by NSE/BSE. This must be confirmed in writing with Dhan before building on it.

**Recommendation:** pursue the Partner track ([dhanhq.co/trading-apis](https://dhanhq.co/trading-apis)), and confirm explicitly whether a partner may serve exchange data to end users under the partner agreement, or whether each end user must authenticate their own Dhan account. Design §4 so the answer changes *configuration*, not architecture — the ingestor is per-credential-set either way.

### 3.2 Data API cost

The docs state data APIs carry additional charges without naming them. Needed: monthly cost, whether it scales with instruments/users, and whether historical backfill is metered separately from live feed.

### 3.3 Static IP

Order APIs require IP whitelisting. Not needed for data APIs today, but the OCI deployment ([`infra/oci/`](../../infra/oci/README.md)) should reserve a static IP now if orders are ever in scope — retrofitting this into a running deployment is disruptive.

---

## 4. Target architecture

```
                      Dhan WS (binary, 5 conns)         Dhan REST (5/sec)
                               │                                │
                               ▼                                ▼
                  ┌────────────────────────────────────────────────┐
                  │  services/market-data      (singleton)         │
                  │  · WS supervisor + binary parser               │
                  │  · 1-min candle aggregator                     │
                  │  · option-chain scheduler (1 per 3s)           │
                  │  · historical backfill worker                  │
                  └────────────┬──────────────────┬────────────────┘
                               │                  │
                       Redis (hot)          Postgres (durable)
                    latest tick/instrument   Quote · Candle · OptionMetrics
                               │                  │
                               └────────┬─────────┘
                                        ▼
                              services/api  (pure reads)
                                        │
                                        ▼
                                    apps/web
```

**Why `services/market-data` and not `services/api`:** the folder already exists as the designated home for exactly this role (`ARCHITECTURE.md` §2 — "formalizes `tradew_live_runner.py`'s quote-feed role"), and it is currently a README-only placeholder. More importantly, the WS connection set is a **per-account singleton resource**. If the API scaled to N replicas, each would open its own connections and blow the 5-connection cap on the (N+1)th. The ingestor must be a single-replica deployable (or leader-elected); the API must stay horizontally scalable. Those are incompatible in one process.

**Redis as the hot layer.** `ARCHITECTURE.md` §3 already names Redis Streams as the eventual event bus. Start with plain Redis keys (latest tick per instrument) — simpler, and sufficient. Graduate to Streams when a second consumer needs replay.

**Write throttling.** Ticks arrive tick-by-tick. Do not write each one to Postgres:
- **Redis** — every tick, or coalesced at ~250 ms
- **`Quote`** — coalesced write every 2–5 s per instrument (it is a latest-value snapshot, per [baseline §1](MARKET-DATA-BASELINE.md); nothing is lost by throttling)
- **`Candle` (1 m)** — aggregated in the ingestor, one write per instrument per minute close

---

## 5. Phases

Mapped onto the existing migration sequence in [`MARKET-DATA-ARCHITECTURE.md`](MARKET-DATA-ARCHITECTURE.md) §6 — this plan does not invent a parallel sequence.

### Phase 1 — Instrument master sync *(no live data, no rate limits, no blockers)*

The highest-value first step, and it is **not blocked by §3**. The scrip master is a public CSV.

`Instrument` has no Dhan identity today. Add:

```prisma
securityId       String?   // Dhan exchange-standard ID
exchangeSegment  String?   // NSE_EQ | NSE_FNO | BSE_EQ | BSE_FNO | MCX_COMM | IDX_I
isin             String?
dhanInstrument   String?   // OPTIDX | OPTSTK | FUTIDX | EQUITY | INDEX
expiryFlag       String?   // M | W
@@unique([securityId, exchangeSegment])
```

Build a `scrip-master` importer against `api-scrip-master-detailed.csv`. Idempotent, checksum-skipped, archive-don't-delete on delisting (`CLAUDE.md` Rule 1 — mark inactive, never drop rows that `Order`/`Trade`/`Position` reference).

This also closes the "no `EQUITY` instruments seeded" gap in [baseline §4](MARKET-DATA-BASELINE.md).

### Phase 2 — Provider abstraction consolidation *(no Dhan calls)*

Today there are **two disagreeing simulators** ([baseline §5, §7](MARKET-DATA-BASELINE.md)): `services/api`'s persisted `SimulatedEngineService` and `services/sentinel`'s ephemeral `SimMarketDataProvider`. Neither is behind the `MarketDataProvider` interface that decision Q6 created for this exact purpose.

Before adding a third source, collapse this:
1. Make `services/api` consume `MarketDataProvider` rather than `SimulatedEngineService` directly.
2. Extend the interface for what Dhan actually returns — `getOHLC()`, depth, `securityId`-based addressing, and an explicit `subscribe()` for push.
3. Keep the simulator as a registered provider (`source: 'simulated'`), selected by config. **It is not deleted** — it stays the offline/CI/paper-mode provider, and it is the fallback when the feed drops.

Doing this before Dhan means the cutover is a config change, and it fixes existing debt regardless of whether §3 resolves favourably.

### Phase 3 — Historical backfill → `Candle` *(Migration 2)*

`Candle` does not exist yet and is the blocker for Charts, TradingView, **and Sentinel's Trap Detection** — whose composite signals all need OHLC history, not a snapshot ([architecture review §3](MARKET-DATA-ARCHITECTURE.md)).

REST-only, one-time, resumable. Rate-limited to 5 req/sec with a token bucket, checkpointed per `(instrument, interval, dateRange)` so an interrupted run resumes rather than restarting. Run it off-hours; it does not compete with the live feed.

Migration 2's open design question from [baseline §7](MARKET-DATA-BASELINE.md) — how Sentinel's in-memory `getCandles()` reconciles with a real `Candle` table — is answered by Phase 2: Sentinel reads through the provider interface, which reads persisted candles.

### Phase 4 — Live WS feed *(the core of this integration)*

In `services/market-data`:
- WS supervisor: 5 connections, ≤100 instruments per subscribe message, pong handling, exponential-backoff reconnect, disconnect-code logging (code `805` = too many connections — a real risk during rolling deploys).
- Binary parser for Ticker (code 2), Quote (4), OI (5), Prev Close (6), Full (8), Disconnect (50). Little-endian.
- Aggregator → Redis + throttled `Quote` writes + 1-min `Candle` writes.
- `source: 'dhan'` on every row. The `source` column already exists precisely so simulated and live data can never be conflated ([baseline §1](MARKET-DATA-BASELINE.md)).

**Subscription tiering matters.** Full packets are 162 bytes/instrument/tick including 5-level depth. Subscribe indices and actively-viewed instruments in Quote/Full mode; everything else in Ticker mode (16 bytes). Depth is realtime-only and **never persisted** — that was already decided ([architecture review §3](MARKET-DATA-ARCHITECTURE.md)).

### Phase 5 — Option chain → `OptionMetrics` *(Migration 3)*

REST-only (`POST /v2/optionchain`) — the chain is not on the WS feed. Returns OI, Greeks, volume, LTP, bid/ask and IV across all strikes in one call per underlying/expiry, which fits `OptionMetrics` well.

Scheduler-driven at the 1-per-3-second ceiling. See §6 for the achievable refresh interval.

### Phase 6 — Push to frontend

`services/api` has **no WebSocket gateway at all** today; the frontend polls ([baseline §3](MARKET-DATA-BASELINE.md)). With Redis carrying live ticks, a gateway becomes straightforward. `ARCHITECTURE.md` sequences this as Step 7 — after the migrations — and this plan keeps that ordering. Until then, polling reads from cache, which is already a large improvement over recomputing per request.

---

## 6. Rate budget — the arithmetic that constrains the product

NSE session = 09:15–15:30 IST = 6.25 h = **22,500 seconds**.

**Option chain**, at the 1-per-3-s ceiling, is 7,500 requests/session for a *single* underlying+expiry — which alone would exceed a 7,000/day cap. So continuous max-rate polling is not viable. Achievable instead:

| Underlyings | Refresh interval | Requests/session | Fits 7,000/day? |
|---|---|---|---|
| 5 indices | 15 s | 7,500 | ✗ |
| 5 indices | **30 s** | **3,750** | ✓ |
| 5 indices | 60 s | 1,875 | ✓ comfortably |
| 10 underlyings | 60 s | 3,750 | ✓ |

**Design point: 30-second option-chain refresh for the 5 dashboard indices**, leaving ~3,000 requests/day headroom for backfill and reconciliation. If the 100,000/day figure turns out to be correct, this relaxes to 10 s and more underlyings — but the product should not *depend* on the optimistic number until it is confirmed.

Live quotes cost **zero** REST budget — that is the whole point of routing them over WebSocket.

---

## 7. Documentation defects found

Flagging these because planning depends on them:

1. **Contradictory daily rate limits.** "Getting Started" says Order 7,000/day and Data 100,000/day. The "Rate Limits" page says Order 100,000/day and Data 7,000/day. The daily column appears swapped between the two. Getting Started's Order row is internally consistent (250/min → 1,000/hr → 7,000/day), which suggests the Rate Limits page carries the error — but this must be confirmed with Dhan, not assumed. **Plan against 7,000/day.**

2. **Request bodies documented as optional.** Historical, LTP, OHLC and option-chain endpoints mark nearly every body parameter `Required: No`, including `securityId` and `fromDate`. This is certainly a doc-generation artefact; treat the semantically-required fields as required and validate client-side.

3. **Example requests omit bodies.** The historical/LTP/OHLC curl examples send headers only. Exact payload shapes need verification against a live sandbox call before the client is written.

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Data redistribution not permitted under partner terms (§3.1) | **Blocking** | Resolve in writing before Phase 4. Phases 1–3 are unaffected. |
| 24-hour token expiry breaks unattended operation | High | Use API key/secret (12 months) over raw tokens; automated renewal with alerting; the ingestor must survive a mid-session auth failure by degrading to the simulated provider, not crashing. |
| Feed disconnect during market hours | High | Supervised reconnect + REST reconciliation on reconnect. `Quote.source` makes any gap auditable after the fact. |
| Multiple replicas exceeding the 5-connection cap | High | Single-replica ingestor deployment; assert on startup; log disconnect code 805 explicitly. |
| `float32` precision at index levels | Medium | float32 carries ~7 significant digits; SENSEX near 80,000.00 sits at that boundary. Round to tick size on ingest and store `Decimal(12,2)` as the schema already does. |
| `int32` volume overflow | Medium | The Quote packet types volume as int32 (max ~2.1 bn). High-volume low-priced counters can approach that in a session. `Quote.volume` is already `BigInt` in Postgres; validate incoming values and log anomalies rather than trusting the wire type. |
| Backfill exhausting the daily budget | Medium | Token bucket + checkpointing + off-hours scheduling; never share a budget window with option-chain polling. |
| Two simulators diverging further | Medium | Phase 2 collapses them *before* Dhan is added, not after. |

---

## 9. Recommended sequence

**Start with Phases 1 and 2 now.** Neither touches Dhan's API, neither is blocked by the commercial and licensing questions in §3, and both are worth doing regardless of whether Dhan is ultimately the provider:

- Phase 1 gives every instrument a broker-agnostic external identity and fixes the missing-equities gap.
- Phase 2 pays down the duplicate-simulator debt already flagged as **High** severity in [baseline §7](MARKET-DATA-BASELINE.md), and makes the eventual cutover a config change.

Resolve §3.1 in parallel — it is the long pole, and Phase 4 cannot start without it.

---

## 11. What the live master actually contains

Four properties of the published scrip master were not evident from the API
documentation and each changed the importer's design. Recorded here so the next
person does not rediscover them.

1. **Both published files are required.** The *detailed* master has no ticker
   column at all — its `SYMBOL_NAME` is the company name
   (`RELIANCE INDUSTRIES LTD`), which is unusable as a lookup key. The *compact*
   master has `SEM_TRADING_SYMBOL` (`RELIANCE`) but no ISIN. They are merged on
   `(exchangeSegment, securityId)`.

2. **NSE's equity segment is mostly not equities.** Of 9,620 rows, roughly 4,300
   are SDL state government bonds, with more in T-bills, mutual funds and
   government securities; only ~2,400 are shares. Because `Instrument.symbol` is
   globally unique, this matters concretely: importing every series produces
   **417 symbol collisions**, restricting to series `EQ` + `BE` produces **1**.

3. **`"NA"` is the null placeholder**, written as a literal string rather than
   an empty field. Treating it as a value silently excluded every index from the
   import.

4. **The placeholder is not consistent between the two files** — indices carry
   `SERIES=NA` in the detailed master and `SERIES=X` in the compact one. Series
   filtering is therefore scoped to cash-equity segments, the only place the
   concept is meaningful, rather than depending on which placeholder appears.

Sanity check that the mapping is right: the importer resolves `RELIANCE` to
security id 2885, `TCS` to 11536 and `HDFCBANK` to 1333 — the same ids used in
Dhan's own API examples.

## 12. Open questions for Dhan

1. May a partner serve exchange market data to its end users under one platform account, or must each end user authenticate their own Dhan account? (§3.1)
2. What is the correct Data API daily limit — 7,000 or 100,000? (§7.1)
3. Is historical backfill metered against the same daily budget as live REST calls?
4. Data API pricing: fixed, per-instrument, or per-user?
5. Is there a trading-holiday/session-calendar endpoint? Nothing in the docs covers it, and the ingestor needs one to avoid polling on closed days.
6. Are WS connection limits per Dhan account or per API key?
