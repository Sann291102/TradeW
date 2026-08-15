# infra/docker/ 🟢

Docker-compose setups for local dev and single-VPS deployment.

**Files here:**
- `docker-compose.yml` — **local dev**: provisions `postgres` (pgvector/pgvector:pg16, persistent volume) + `pgadmin` only. Written 2026-07-17 to unblock running Sentinel's Persistent Knowledge Brain locally, see [Sentinel Brain Phase 2 validation](../../knowledge/Research/2026-07-17%20-%20Sentinel%20Brain%20Phase%202%20validation.md). App services are run from the host (`npm run dev:*`) against it.
- `docker-compose.prod.yml` — the **full single-VPS stack** behind Caddy: `caddy`, `web`, `api`, `sentinel`, **`sentinel-py`**, `market-data`, `live-feed`, a one-shot `migrate`, `postgres`, `redis`. See [`DEPLOY-DEV.md`](DEPLOY-DEV.md) for the walkthrough.
- `docker-compose.admin.yml` — the operator-only `apps/admin` console (loopback + SSH tunnel), kept separate so it is never exposed by the public Caddy route.
- `Caddyfile`, `backup.sh` — reverse-proxy config and a Postgres backup helper.

**Status:** dev + prod + admin compose files all exist and run. (`services/trading-engine` is not in any compose — its real-money code is not migrated in yet; the OMS lives in `services/api/sim`.)

Note: the previously-referenced `docker-compose.yml` in `TradeW -(Setup & Paper)\TradeW-Setup-main\tradew-prototype\` does not exist (verified 2026-07-17 — no `tradew-prototype` folder in that tree). That reference was stale; this file was written from scratch.
