# services/sentinel 🟡

The runtime for the **Sentinel (Safety Nets)** pillar — deliberately a separate service from `services/tradew-ai`, per the explicit decision that TradeW AI and Sentinel are not the same system (see `../../docs/product-architecture/README.md`).

**Full blueprint:** `../../docs/product-architecture/SENTINEL.md` — the four-agent architecture (Market & Technical Intelligence, Emotion Intelligence, Trap & Safety Intelligence, Compliance & Audit) synthesized by a Sentinel Orchestrator, the composite Trap Detection signal design, full feature set, and UI workspace layout.

**Loads agent definitions from:** `../../agents/sentinel/`

**Reads (read-only, via `services/api`):** the user's own order/trade/position history from `services/trading-engine` — this is Sentinel's most sensitive data dependency and the main reason it can't just be a mode of `services/tradew-ai`.

**Exposes:** one internal endpoint, called only by `services/api`.

**Hard boundary:** never blocks or delays an order — it observes and comments in parallel with the normal order flow, it is not a gate in it. Every observation is logged with evidence and a SEBI-relevant label by the Compliance & Audit agent.

**Status (corrected 2026-07-21):** real, substantial code — not design-only. `src/` has 75 files including a fully implemented Persistent Knowledge Brain (`src/brain/`, ~78% of planned scope per `SENTINEL_BRAIN_PROGRESS.md`), compliance, explainability, intelligence, and orchestrator modules. Only Portfolio Intelligence remains unbuilt. Frontend note: this service is reached only through `services/api`, and that has never depended on how Sentinel is presented. Sentinel's frontend is the `/sentinel` workspace inside `apps/web`'s shared shell (`docs/product-architecture/SENTINEL.md` §5) — a 2026-07-21 direction change briefly proposed a standalone application instead and was reversed the same day, with no effect on this service either way.
