# services/market-data 🟢

The market data **ingestion runtime**. Owns the feed connection, writes `Quote`,
and syncs the instrument master. Implemented in Phase 1 of
[`DHAN-MARKET-DATA-INTEGRATION.md`](../../docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md).

**It writes; it does not serve.** `services/api` remains the sole public ingress
(`ARCHITECTURE.md` §1) and reads what this service persists. The only HTTP
surface here is `GET /health` for operators.

## ⚠️ Singleton — do not scale horizontally

The broker feed connection set is a **per-account resource**: Dhan allows five
WebSocket connections per user and evicts the oldest with disconnect code `805`
on a sixth. Two replicas would fight each other for connections.

Scale `services/api` instead — it is stateless and reads what this writes.

## Data flow

```
      feed (simulated | dhan)
             │  ticks
             ▼
      TickPipelineService
       ├── cache        every tick
       └── Quote        coalesced on MARKET_DATA_FLUSH_MS, unchanged rows skipped
             │
             ▼
      services/api  ──►  apps/web        (pure reads)
```

Coalescing loses nothing: `Quote` is a latest-value snapshot
([`MARKET-DATA-BASELINE.md`](../../docs/product-architecture/MARKET-DATA-BASELINE.md) §1),
so intermediate ticks are not history. Per-minute aggregation into `Candle` is
Migration 2.

## Provider selection

Configuration, not code — that is the point of the phase.

| `MARKET_DATA_FEED` | State |
|---|---|
| `simulated` (default) | Active. Deterministic OU walk from `@tradew/market-data`, anchored to each instrument's real `previousClose`. |
| `dhan` | Built, **not enabled.** Binary parser and WebSocket lifecycle are complete and verified; wiring a real socket is Phase 4, gated on the licensing question in `DHAN-MARKET-DATA-INTEGRATION.md` §3.1. |

The simulator is the permanent development, CI and fallback source — the same
status `mock_dhanhq.py` holds for paper trading. It is not a placeholder.

Defaults are simulated on purpose: an operator must opt in to a live feed, so a
missing or misspelled env var can never silently label simulated data as live.

## Instrument master sync

```bash
npm run scrip:sync -w @tradew/market-data-service              # apply
npm run scrip:sync -w @tradew/market-data-service -- --dry     # preview
npm run scrip:sync -w @tradew/market-data-service -- --segments=IDX_I,NSE_EQ,NSE_FNO
npm run scrip:sync -w @tradew/market-data-service -- --series=all
npm run scrip:sync -w @tradew/market-data-service -- --deactivate-missing
```

Downloads both published masters and merges them on `(segment, securityId)`.
Both are required: the **detailed** file has ISIN but no ticker column at all
(its `SYMBOL_NAME` is the company name, `"RELIANCE INDUSTRIES LTD"`), while the
**compact** file has `SEM_TRADING_SYMBOL` (`"RELIANCE"`) but no ISIN.

Defaults to segments `IDX_I` + `NSE_EQ` and series `EQ` + `BE`. Both defaults are
load-bearing rather than conservative:

- **Series.** NSE's equity segment is mostly not equities — of 9,620 rows, ~4,300
  are SDL government bonds, plus T-bills, mutual funds and government securities.
  Only ~2,400 are shares. Importing every series produces 417 symbol collisions;
  `EQ`+`BE` produces 1.
- **Symbol uniqueness.** `Instrument.symbol` is globally unique so
  `findUnique({ where: { symbol } })` behind `/market-data/quote-by-symbol` keeps
  working. Collisions are reported and rejected, never silently overwritten.
  Enabling BSE or F&O needs an explicit symbol policy first.

The sync is incremental — a re-run with no upstream change writes nothing — and
never deletes: instruments dropped from the master are deactivated
(`active: false`), because `Order`/`Trade`/`Position` reference them permanently
(`CLAUDE.md` Rule 1).

Run it daily; the master changes about once a day. It is a CLI rather than a
boot-time job so restarts do not re-download ~60 MiB and so changes can be
previewed with `--dry`.

## Running

```bash
cp .env.example .env      # set DATABASE_URL
npm run scrip:sync -w @tradew/market-data-service
npm run start:dev -w @tradew/market-data-service
curl http://127.0.0.1:4020/health
```

`GET /health` reports feed status, instrument counts (including how many are
broker-mapped), pipeline counters and recent status transitions. It returns
`degraded` rather than unhealthy when the feed is down — the service is still up
and the API still serves the last persisted prices.

## Not built yet

- Real WebSocket transport for the Dhan feed (Phase 4)
- Dhan REST provider for historical backfill (Phase 3)
- `Candle` aggregation (Migration 2)
- Option chain scheduler (Phase 5)
- Redis-backed shared cache — the current cache is process-local, so
  `services/api` reads persisted rows rather than the hot cache
