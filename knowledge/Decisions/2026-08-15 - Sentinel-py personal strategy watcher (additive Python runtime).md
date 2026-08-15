---
type: decision
date: 2026-08-15
tags: [decision, sentinel, sentinel-py, python, market-data, notifications, compliance]
---

# Sentinel-py — the personal strategy watcher (additive Python runtime)

**Status:** shipped, P0–P4 (`services/sentinel-py`, FastAPI, default port `4011`). P5–P7 (image/video strategy extraction, admin endpoints, strike-dropdown data) pending. The existing TypeScript `services/sentinel` keeps running **unchanged and un-retired** — this sits beside it, it does not replace it.

## What it is

The user writes *their own* strategy in plain text; a **deterministic** parser (`app/strategy/parser.py`, no LLM) turns it into rules; a sweep loop watches live Dhan candles and runs an `IDLE → FORMING → CONFIRMED` state machine with cooldown (`app/watch/`). Once the user marks a position taken, the same sweep switches from rule-evaluation to **in-trade monitoring** (R-multiple milestones 1R/2R/3R, invalidation, projected level, structure break). Surfaces as the Sentinel "strategy workspace — write, watch, follow" in `apps/web`. Full API and phase list in `services/sentinel-py/README.md`.

## The decisions worth remembering

- **Own tables, `asyncpg`, never Prisma.** It reads/writes `UserStrategy` / `WatchSession` / `WatchObservation` directly against the shared Postgres. Prisma (in `packages/database`) still **owns the migration** for those tables; Python only reads/writes rows. This is `ARCHITECTURE.md` §1.4 (one schema owner per table, never one ORM across two languages) made concrete — do **not** add a second ORM or let Python run migrations.

- **No new WebSocket was added, on purpose.** `apps/web` already polls `/notifications` every 30s and `NotificationSync.tsx` deliberately keeps a single copy of that poll. So an alert reaches the user within one sweep (`SENTINEL_PY_SWEEP_SECONDS`, default 15s) **plus** one web poll (30s) — up to ~45s, not the ~5s a socket would give. Sub-30s push is a change to the *whole* notification system, not a Sentinel feature; it was explicitly not forked here for one category.

- **The compliance gate is the last thing before the wire.** `app/notify/compliance.py` gates every outgoing string and metadata key against ARCH-4 / `CLAUDE.md` Rule 2 — no Buy/Sell/Entry/Target/Stop leaves the service. Alerts go out as `Notification` rows via `services/api`'s `/internal/sentinel-py/notify` (category `sentinel`) with durable **per-trading-day dedupe**.

- **The sweep is `JobLease`-gated.** `app/core/lease.py` is a port of `services/api/src/common/leader-election.ts` — extra replicas stand by rather than double-notifying. But the loop is a single in-process `asyncio.create_task` that **dies with its process** and only resumes when some instance wins the lease on its next tick. `SENTINEL_PY_SWEEP_ENABLED=false` runs the API with no background loop (useful for tests / a pure-API replica).

- **Risk and reward are read from different prices, deliberately.** In-trade monitoring measures adverse events against the candle's **adverse extreme** (price genuinely traded there) and favourable ones against the **close** (a wick that tags 2R has not *achieved* 2R). Quick to report risk, slow to claim progress — do not "simplify" both onto one price.

## Gotcha already paid for

The store had a **naive/aware datetime boundary** bug (commit `1b81dfa`, found by an end-to-end run) — Postgres `timestamptz` comes back aware, Python literals were naive, and the comparison raised. Keep all datetimes tz-aware at the `asyncpg` boundary.

## Related

- [[Decisions/2026-07-21 - Sentinel reinstated as a TradeW workspace (decoupling reversed)]] — Sentinel is one workspace under one shell; sentinel-py is a *runtime* under that umbrella, not a separate product.
- [[Patterns/2026-08-06 - Sentinel publication gate (four conditions, not one threshold)]] — the TS service's surfacing gate; sentinel-py's compliance gate is the analogous non-negotiable on the Python side.
- [[Patterns/2026-08-12 - Sentinel event contract (notifications consume a gated event, never the response)]] — the same "durable notification, gated payload" discipline this service delivers through.
- [[Decisions/2026-08-12 - Operator identity for the standalone admin console]] — sentinel-py's P6 (admin endpoints) will land behind that same operator boundary.
- `services/sentinel-py/README.md`, `SENTINEL_MASTER_PLAN.md`, `ARCHITECTURE.md` §4.
