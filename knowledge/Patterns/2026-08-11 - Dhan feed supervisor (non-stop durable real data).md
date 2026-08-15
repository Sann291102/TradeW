---
tags: [pattern, market-data, dhan, sentinel, reliability]
created: 2026-08-11
---

# Dhan feed supervisor — non-stop, durable real market data

## Problem
The live-feed bridge (`services/market-data/scripts/live-feed-server.ts`) is
real but ephemeral: it holds candles **in memory only** ("no DB, no auth — demo
bridge only"), exits on crash, and depends on a Dhan access token that Dhan/SEBI
cap at **24 hours**. Left alone it goes quiet and every downstream engine falls
back to "no market data" (Sentinel `/observe` → 503, by design — it never
fabricates). This is exactly what had happened: the newest persisted candle was
`2026-07-23`, ≈ when the previous token expired.

## What "forever / non-stop" can and cannot mean here
The feed authenticates with the **24h access token** (`access-token` header on
both the WebSocket feed and the REST candle/quote endpoints). The **API
key/secret (app_id/app_secret) are the *permanent* 12-month credentials**, but
they do not authenticate the feed directly — they *mint* the 24h token through
Dhan's consent flow, whose middle step is an interactive Dhan **2FA login**
(SEBI API-access rule). So a truly zero-touch "never touch the token" system is
not possible without storing the user's Dhan password (prohibited) or
fabricating data. The achievable goal is **near-zero-touch**: automate
everything around that one login.

## Solution — `scripts/dhan-supervisor.ts` (`npm run dhan:supervise`)
Composes the existing tested scripts under one supervisor (reuse, not
duplicate — CLAUDE.md Rule 1/2):

1. **Auto-start + auto-reconnect.** Spawns the bridge; restarts on exit with
   exponential backoff (1s→30s), so a transient Dhan disconnect self-heals.
2. **Durable persistence.** Runs the idempotent `backfill:candles` (upsert on
   `@@unique([instrumentId, timeframe, bucketStart])`) once on boot (any hour)
   and then every `SUPERVISOR_PERSIST_MIN` (default 5) **during NSE hours**
   (09:00–16:00 IST) to protect the Dhan request budget overnight. Real session
   history lands in Postgres, so `/observe` reads real data even between ticks
   and across bridge restarts / token lapses. Verified: 1,425 rows written on
   boot; NIFTY 1m/5m/15m fresh to the last session.
3. **Token lifecycle.** Decodes the JWT `exp`, logs remaining life, and inside
   the renewal window (`DHAN_TOKEN_RENEW_MIN`, default 60) uses the permanent
   app_id/app_secret to `generate-consent` and print the one-click login URL.
   The supervisor keeps serving persisted real candles until the new token
   lands.

## Key files
- `services/market-data/scripts/dhan-supervisor.ts` — the supervisor
- `services/market-data/scripts/live-feed-server.ts` — the bridge it manages
- `services/market-data/scripts/backfill-candles.ts` — the persistence pass
- `services/market-data/scripts/dhan-token.ts` — `dhan:status|consent|token|set`
- `services/sentinel/src/market-data/candle-market-data.provider.ts` — reads
  live bridge first, then the persisted Candle table; never simulates.

## Related
- [[2026-07-23 - Candle table + Dhan backfill (Sentinel on real data)]]
- [[2026-08-11 - Dhan Algo Strategies]]
- `docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md` (§ token risk)
