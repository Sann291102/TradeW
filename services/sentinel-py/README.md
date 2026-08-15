# Sentinel (Python) — Personal Strategy Watcher

Internal service, called exclusively by `services/api`. Watches the user's
own declared strategy against live candles and alerts them — it never
proposes its own trade, never auto-trades, never says "buy" or "sell".

This is a **new, additive service** (`services/sentinel-py`, default port
`4011`). The existing `services/sentinel` (TypeScript) keeps running
unchanged until an explicit decision is made to retire it — see
`SENTINEL_MASTER_PLAN.md` / the Sentinel architecture plan for that step.

## Documentation

| Document | Answers |
|---|---|
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | What this product is, its non-negotiable principles, and the compliance posture |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it is built: data model, module map, the watch loop, the generic contract, the frontend integration |
| [`docs/PLAN.md`](docs/PLAN.md) | What is done, what is not, and the one thing that is not yet proven |

The short version: P0–P4 and P7 are complete, 10 of 11 catalogue strategies
are adoptable, and **no observation has yet been produced from real market
data** — that gap is stated plainly in PLAN.md §4 rather than left to be
discovered.

## Status: P0–P4 and P7 complete

(Full ledger in [`docs/PLAN.md`](docs/PLAN.md); the list below covers P0–P4.)

- [x] FastAPI app with `/health`
- [x] Service-token auth guard (`app/core/auth.py`), mirroring
- [x] Service-token auth guard (`app/core/auth.py`), mirroring
      `services/sentinel`'s `ServiceTokenGuard`; guards every route except
      `/health`.
- [x] Wired into orchestration: `npm run dev:sentinel-py`, a `sentinel-py`
      block in `infra/docker/docker-compose.prod.yml` (mirrors `sentinel`'s),
      and the `SENTINEL_PY_*` vars in the root `.env.example`.
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
- [x] P3 — notification engine. `app/notify/dispatcher.py` POSTs to
      services/api's `/internal/sentinel-py/notify`, which writes a
      `Notification` row (category `sentinel`) with durable per-trading-day
      dedupe. `app/notify/compliance.py` gates every outgoing string and
      metadata key against ARCH-4 (no Buy/Sell/Entry/Target/Stop).
      **No WebSocket was added** — apps/web already polls `/notifications`
      every 30s and `NotificationSync.tsx` states there is deliberately no
      second copy of that polling. Sub-30s push is a change to the whole
      notification system, not a Sentinel feature; see below.
- [x] P4 — in-trade monitoring (`app/intrade/monitor.py`). After the user
      marks a position taken (`POST /watch/{id}/position` with their own
      entry, invalidation level, direction and optional projected level), the
      sweep switches that watch from rule evaluation to measuring movement
      against those numbers: R-multiple milestones (1R/2R/3R, announced once
      each), invalidation reached, projected level reached, and structure
      break. `DELETE /watch/{id}/position` closes it.

      Risk and reward are read from different prices, deliberately: adverse
      events use the candle's adverse extreme (price genuinely traded there),
      favourable ones use the close (a wick that tags 2R has not achieved
      2R). Quick to report risk, slow to claim progress.
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

## Known limits

**Latency.** An alert reaches the user within one sweep (15s) plus one web
poll (30s) — so up to ~45s, not the 5s a socket would give. Adding a push
channel means adding one to the notification system as a whole; it is
deliberately not forked here for one category.

**Single process.** The sweep loop runs in-process (`asyncio.create_task`)
and dies with its process. It is gated on a `JobLease` (`app/core/lease.py`,
ported from `services/api/src/common/leader-election.ts`), so extra replicas
stand by rather than double-notifying, but work does not resume until some
instance wins the lease on its next tick.
