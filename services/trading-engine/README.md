# services/trading-engine 🟢

The Dhan options-trading execution engine, in Python. Per CONSOLIDATION-PLAN.md §2.2, this is real, hardened work (Phase 1 of its own roadmap is genuinely complete) — not an experiment being rescued.

**Source mapping — keep set (rename off the "v2" suffix on migration):**
- `extreme_algo_bot_v2.py` → the mainline bot (HMAC-verified webhook intake, SL/TP, async order execution)
- `order_poller.py` — fill/rejection polling and reconciliation; **keep this even after an event bus exists** (ARCHITECTURE.md §3) — it's a safety net, not a stopgap
- `pnl_tracker.py` — trade lifecycle, commission-adjusted PnL
- `security.py` — HMAC-SHA256 webhook verification (timing-safe compare; reviewed, no obvious flaw found)
- `mock_dhanhq.py` — the paper-trading broker stand-in; this is the sanctioned paper-mode path, not `extreme_algo_paper.py`
- `templates/dashboard.html`, `requirements.txt`

**Explicitly archived, not migrated:** `extreme_algo_bot_v1.py`, `extreme_algo_live.py`, `extreme_algo_paper.py` — all superseded or redundant relative to the above (see `archive/README.md`).

**Strategy pairing:** `services/trading-engine/strategies/orb_final.pine` (from `extreme_algo_package/pine_scripts/v3.1_orb_final.pine`) is the canonical TradingView strategy that emits the webhook JSON this engine consumes. Earlier pine v1/v2/v3 iterations are archived.

**Exposes:** an internal-only REST API (positions/orders/fills/PnL/health) reachable solely from `services/api` and `services/analytics`, authenticated by a service token — never a public endpoint, never called with a user JWT. See ARCHITECTURE.md §3.

**Still receives directly (bypassing services/api on purpose):** TradingView strategy webhooks — that path is already HMAC-hardened and latency-sensitive.

**Known gaps to close before real capital is at risk** (from the audit): the Dead Letter Queue retry worker is unbuilt (table exists only), there are no automated tests despite `pytest` being a declared dependency, and it's on SQLite rather than the roadmap's target Postgres/TimescaleDB.

**Status:** not yet populated. Waiting on execution approval.
