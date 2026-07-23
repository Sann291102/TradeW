---
type: pattern
date: 2026-07-24
tags: [pattern, sentinel, market-data, dhan, live-feed]
status: implemented
---

# Sentinel reads live data for the whole universe (not just backfilled symbols)

## What changed
`CandleMarketDataProvider` (services/sentinel/src/market-data/) now resolves
market data in this order, real-first:

1. **Live feed** — the standalone Dhan bridge (`live-feed-server.ts`, port 4600)
   via `SENTINEL_LIVE_FEED_URL`. Its `/candles?symbol=&interval=&days=` serves
   real Dhan OHLCV **on demand for the entire resolved universe** (indices, ~212
   F&O stocks, ETFs, and MCX commodities), and `/quotes` gives real breadth +
   India VIX. So **any** market the user selects reads live — including GOLD,
   CRUDEOIL, INFY, TATAMOTORS, which previously fell to the simulator.
2. **Candle table** — persisted backfilled history (the 5 backfilled symbols),
   used when the bridge is unset/unreachable.
3. **Simulator** — the ONLY remaining simulated path; last resort.

`getMarketBreadth()` also went live: advances/declines computed from the feed's
212-stock snapshot, VIX from the `INDIAVIX` index row. Verified: Sentinel VIX
13.5 == feed 13.48 (was ~16.5 simulated); A/D 0.54 == real 74/136.

Env (services/sentinel/.env): `SENTINEL_LIVE_FEED_URL=http://localhost:4600`,
`SENTINEL_LIVE_FEED_TIMEOUT_MS=4000` (short timeout so a down/slow bridge
degrades to the table/simulator instead of stalling `/observe`).

## Verification
`/observe {symbol}` marketContext price == the feed's last 15m close, exactly:
NIFTY 23991.05, GOLD 145693, INFY 1052, TATAMOTORS 405.50 — all real Dhan.

## Honest caveat / architectural debt
This couples Sentinel to a **demo bridge** the docs call temporary. It is a
pragmatic step, not the target architecture: DHAN-MARKET-DATA-INTEGRATION.md
Phase 4 has `services/market-data` writing **live Candle rows to Postgres**, and
Sentinel reading only the table. Because the live source is env-gated and the
table/simulator remain fallbacks, that migration is a config change — unset
`SENTINEL_LIVE_FEED_URL` once the ingestion pipeline populates Candle. Also: the
Dhan 24h token (`DHAN_ACCESS_TOKEN`) expires ~15:21 IST daily and the bridge
holds it — the live path dies at token expiry until refreshed (prefer the
12-month API key/secret).

## Frontend
`apps/web` `lib/sentinel/markets.ts` now marks every market live (`real: true`);
selector legend + page subtitle say "live market data" instead of the old
"5 symbols real / others simulated". `REAL_DATA_SYMBOLS` → `BACKFILLED_SYMBOLS`
(now only means "has durable persisted history"). Gotcha hit while doing this:
renaming an exported const referenced by a same-file function produced a
**stuck stale webpack hot-update chunk** — the error persisted across reloads
and even a server restart until `.next` was cleared. `read_console_messages` also
replays a stale buffer across restarts; trust `preview_logs` (server-side) +
a screenshot over it.

## Related
- [[2026-07-23 - Candle table + Dhan backfill (Sentinel on real data)]] — the table path (source 2)
- [[2026-07-23 - Sentinel market selector + event-driven safety feed]] — the selector that drives per-symbol reads
- `services/market-data/scripts/live-feed-server.ts` — the bridge (its `/candles`, `/quotes`)
