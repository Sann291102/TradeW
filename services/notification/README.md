# services/notification 🟡

New service for alert fanout (email/Slack/push) and the TradeW-side end of the n8n integration (ARCHITECTURE.md §5).

**Job:** receive domain events (e.g. `OrderFilled`, alert-rule-triggered) from `services/api` / the future event bus, and either handle simple fanout directly or trigger an n8n workflow (in `../../workflows/`) for anything multi-step (e.g. a KYC-status change that needs to notify a user AND update a compliance record AND ping ops on Slack).

**Direction of n8n calls:**
- notification → n8n: webhook call to trigger a workflow.
- n8n → notification (via `services/api`, service-scoped credential): "actually send this message now."

**Not responsible for:** anything on the trading hot path (market-data ticks, order execution) — those stay inside `services/trading-engine`/`services/market-data`. n8n and this service operate on a minutes-scale, not a sub-150ms SLO.

**Status:** design-only, no code exists yet.
