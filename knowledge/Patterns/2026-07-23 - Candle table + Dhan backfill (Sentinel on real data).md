---
type: pattern
date: 2026-07-23
tags: [pattern, market-data, dhan, candle, sentinel, migration, backfill]
status: implemented
---

# Candle table + Dhan historical backfill — Sentinel now reasons on real data

## For future Claude
Migration 2 (`Candle`) from [MARKET-DATA-ARCHITECTURE.md §5/§6] is **executed**, and
Sentinel's `getCandles` now returns **real Dhan OHLCV history**, not the simulator.
Do not re-derive any of this; extend it.

## What shipped (2026-07-23)
1. **`Candle` model** — `packages/database/prisma/schema.prisma`, migration
   `20260723000000_market_data_candle`. Append-only OHLCV, `@@unique([instrumentId,
   timeframe, bucketStart])`, `source` provenance column. Purely additive migration.
   `timeframe` string mirrors `CandleInterval` in `@tradew/types` (`1m|5m|15m|1h|1d`).
2. **Dhan historical backfill** — `services/market-data/scripts/backfill-candles.ts`
   (`npm run backfill:candles`). Standalone script like `live-feed-server.ts`, writes
   `Candle` rows with `source='dhan'`. Idempotent via upsert on the unique key.
   First run wrote **8,106 rows** (NIFTY/BANKNIFTY/FINNIFTY/RELIANCE/COALINDIA × 15m+1d,
   90 days).
3. **`CandleMarketDataProvider`** — `services/sentinel/src/market-data/`. Bound to the
   `MARKET_DATA` token in `app.module.ts` (was `SimulatedMarketDataProvider`). Reads the
   `Candle` table for `getCandles`; **falls back to the simulator** for un-backfilled
   symbols or when Postgres is away. Everything else (quote/breadth/option-chain/news)
   still delegates to the simulator — deliberately, breadth is a future cross-instrument
   aggregate and quotes are the ingestion runtime's job.
4. **Service-token fix** — `services/api/.env` `SENTINEL_SERVICE_TOKEN` had an `nvapi-`
   value pasted into it; every `/observe` 401'd. Now synced to sentinel's `SERVICE_TOKEN`.
   The stray key is preserved in `services/api/.env.bak`. See [[2026-07-23 - Sentinel not "working" was four stacked config+build faults]].

## Dhan historical REST — verified request/response shapes
Endpoints (v2), headers `access-token` + `client-id` + `Content-Type: application/json`:
- **Daily**: `POST /v2/charts/historical` — body `{securityId, exchangeSegment, instrument,
  expiryCode:0, oi:false, fromDate:"YYYY-MM-DD", toDate:"YYYY-MM-DD"}`.
- **Intraday**: `POST /v2/charts/intraday` — same body **minus** `expiryCode`, **plus**
  `interval:"1"|"5"|"15"|"60"` (25/30 also exist). No expiryCode.

Both return **parallel arrays** `{open[], high[], low[], close[], volume[], timestamp[]}`,
`timestamp` = **epoch seconds UTC**. `new Date(ts*1000)` is correct; 09:15 IST open lands at
`03:45:00Z`. Works **while the market is closed** — historical/intraday return past sessions
regardless of hours, so backfill runs any time. Daily bars finalise a day late (a 07-23 run
returned dailies through 07-21). Indices report a non-zero `volume`. Bars with
`open==high==low==close && volume==0` are **non-traded placeholders** (holiday/forming-tail),
dropped by `isPlaceholder()` — they are not real dojis.

Instrument coverage is already there: **2921/2933** `Instrument` rows carry
`(securityId, exchangeSegment, dhanInstrument)`. NIFTY securityId=13, BANKNIFTY=25,
FINNIFTY=27 (all `IDX_I`/`INDEX`); equities e.g. RELIANCE=2885, COALINDIA=20374 (`NSE_EQ`/`EQUITY`).

## How to prove it end-to-end
Boot sentinel (`node dist/main.js`, port 4010), `POST /observe {symbol}` with the service
token → `marketContext` price equals the last `Candle.close` for that symbol. Verified: NIFTY
23871.70, RELIANCE 1272.50 — exact matches to `source='dhan'` rows. `/explain` returns
`servedBy: nvidia-nim / meta/llama-3.1-8b-instruct`, `live:true`.

## Related
- [[2026-07-21 - Market data Phase 1 (ingestion runtime, pure reads)]] — the read-path inversion this builds on
- [[2026-07-23 - Sentinel not "working" was four stacked config+build faults]] — the token/feed/build faults fixed alongside
- [[API/2026-07-23 - NVIDIA free tools (NIM API, Agent Skills)]] — the LLM/embedding provider behind the Brain
- `docs/product-architecture/MARKET-DATA-ARCHITECTURE.md` §5/§6 — the Candle design (now executed)
- `docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md` Phase 3 — historical backfill
