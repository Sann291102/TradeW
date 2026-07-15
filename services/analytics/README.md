# services/analytics 🟡

New service for portfolio/PnL analytics and reporting, separate from `services/trading-engine`'s own real-time `pnl_tracker.py` (which handles per-trade lifecycle accounting, not aggregate portfolio analytics).

**Job:** aggregate data from `services/trading-engine` (positions/fills/PnL, via the same internal-only API described in ARCHITECTURE.md §3) and `services/market-data` into portfolio-level views, historical performance, and eventually the ClickHouse-backed analytics store the architecture doc targets at scale.

**Talks to:** `services/trading-engine`'s internal API (read-only), `services/market-data`. Exposes results to `services/api` only.

**Status:** design-only, no code exists yet. Don't provision ClickHouse before there's enough data volume to need it — plain Postgres aggregation queries are fine at current scale.
