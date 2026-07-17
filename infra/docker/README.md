# infra/docker/ 🟡

Local-dev docker-compose setup. Target end state: `api` + `web` + `trading-engine` + `postgres` + `redis`.

**Status:** `docker-compose.yml` provisions `postgres` (pgvector/pgvector:pg16, persistent volume) only — written 2026-07-17 to unblock running Sentinel's Persistent Knowledge Brain locally, see [Sentinel Brain Phase 2 validation](../../knowledge/Research/2026-07-17%20-%20Sentinel%20Brain%20Phase%202%20validation.md). `api`, `web`, `trading-engine`, `redis` are not yet added.

Note: the previously-referenced `docker-compose.yml` in `TradeW -(Setup & Paper)\TradeW-Setup-main\tradew-prototype\` does not exist (verified 2026-07-17 — no `tradew-prototype` folder in that tree). That reference was stale; this file was written from scratch.
