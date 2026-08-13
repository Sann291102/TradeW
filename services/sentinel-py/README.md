# Sentinel (Python) — Personal Strategy Watcher

Internal service, called exclusively by `services/api`. Watches the user's
own declared strategy against live candles and alerts them — it never
proposes its own trade, never auto-trades, never says "buy" or "sell".

This is a **new, additive service** (`services/sentinel-py`, default port
`4011`). The existing `services/sentinel` (TypeScript) keeps running
unchanged until an explicit decision is made to retire it — see
`SENTINEL_MASTER_PLAN.md` / the Sentinel architecture plan for that step.

## Status: P0 — scaffold

- [x] FastAPI app with `/health`
- [x] Service-token auth guard (`app/core/auth.py`), mirroring
      `services/sentinel`'s `ServiceTokenGuard` — not yet wired to any route
      since there are no protected routes yet
- [x] Wired into orchestration: `npm run dev:sentinel-py`, a `sentinel-py`
      block in `infra/docker/docker-compose.prod.yml` (mirrors `sentinel`'s),
      and `SENTINEL_PY_SERVICE_URL` / `SENTINEL_PY_SERVICE_TOKEN` in the root
      `.env.example`. `services/api` does not call this service yet — that
      proxy wiring lands with P3 once there's something worth calling.
- [x] P1 — deterministic text strategy parser (`app/strategy/parser.py`) +
      strategy CRUD (`POST /strategies/parse`, `POST /strategies`,
      `GET /strategies`, `GET /strategies/{id}`, `PATCH /strategies/{id}`,
      `DELETE /strategies/{id}` — soft delete, sets `status=archived`).
      Backed by `UserStrategy` (Postgres, migrated by Prisma, read/written
      here directly via `asyncpg`).
- [x] P2 — watch engine: candle fetcher against the Dhan live-feed bridge
      (`app/market/feed.py`, real data only — never simulates), rule
      evaluator (`app/watch/evaluator.py`), `IDLE → FORMING → CONFIRMED`
      state machine with cooldown (`app/watch/state_machine.py`), and an
      in-process asyncio sweep loop (`app/watch/poller.py`). Watch API:
      `POST /watch`, `GET /watch`, `GET /watch/{id}/observations`,
      `POST /watch/sweep` (run one sweep now).
- [ ] P3 — notification engine + WebSocket push
- [ ] P4 — in-trade monitoring
- [ ] P5 — image/video strategy extraction
- [ ] P6 — admin portal endpoints
- [ ] P7 — strike price dropdown data

## Run locally

```bash
cd services/sentinel-py
pip install -e ".[dev]"
python -m app.main
# or: uvicorn app.main:app --reload --port 4011
```

## Test

```bash
pytest
```

## Config

Reads the repo-root `.env`. Relevant vars:

- `SENTINEL_PY_PORT` (default `4011`)
- `SENTINEL_PY_SERVICE_TOKEN` — shared secret `services/api` sends as
  `x-service-token`
- `CORS_ORIGINS` (default `http://localhost:3000,http://127.0.0.1:3000`)
- `DATABASE_URL` — same Postgres the rest of the monorepo uses
- `SENTINEL_LIVE_FEED_URL` (default `http://localhost:4600`) — the Dhan
  bridge (`services/market-data/scripts/live-feed-server.ts`)
- `SENTINEL_PY_SWEEP_SECONDS` (default `15`) — sweep cadence
- `SENTINEL_PY_SWEEP_ENABLED` (default `true`) — set false to run the API
  without the background watch loop

## Known limits (P2)

The sweep loop runs **in-process** (`asyncio.create_task`). It stops with the
process and does no work-stealing, so running more than one replica would
evaluate every watch more than once. Before this scales past one instance it
needs to move to a leased worker — the `JobLease` table already in the schema
is the existing pattern for that.

Notifications are currently **logged, not delivered** — `poller._emit` is the
seam P3 replaces with real dispatch to services/api.
