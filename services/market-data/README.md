# services/market-data 🟡

New service that formalizes a role currently played by a standalone script: `tradew_live_runner.py` (found loose in the `TradeW-Setup-main` planning folder), which serves the static v0.4 prototype and proxies **read-only** Dhan LTP quotes using its own separate `tradew_config.json` credentials.

**Job:** ingest live quotes (Dhan today; TrueData/Global Datafeeds per the roadmap's v0.4 stage) and publish ticks for `services/api` to fan out to connected `apps/web` clients over WebSocket. Historical candles land in Postgres for now — don't provision TimescaleDB before real data volume needs it (that's a v1.0+/architecture-doc-scale concern, not a today concern).

**Credential note:** this is the *second* place (besides `services/trading-engine`) holding Dhan API credentials. Part of standing this service up is converging both onto one secrets story instead of two separate `.env`/config-file surfaces — see ARCHITECTURE.md §7.

**Talks to:** `services/api` (internal REST/event bus) — never directly to `apps/*`.

**Status:** design-only, no code exists yet. Build at roadmap stage v0.3–v0.4.
