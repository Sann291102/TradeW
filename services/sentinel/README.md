# services/sentinel 🟡

The runtime for the **Sentinel (Safety Nets)** pillar — deliberately a separate service from `services/tradew-ai`, per the explicit decision that TradeW AI and Sentinel are not the same system (see `../../docs/product-architecture/README.md`).

**Full blueprint:** `../../docs/product-architecture/SENTINEL.md` — the four-agent architecture (Market & Technical Intelligence, Emotion Intelligence, Trap & Safety Intelligence, Compliance & Audit) synthesized by a Sentinel Orchestrator, the composite Trap Detection signal design, full feature set, and UI workspace layout.

**Loads agent definitions from:** `../../agents/sentinel/`

**Reads (read-only, via `services/api`):** the user's own order/trade/position history from `services/trading-engine` — this is Sentinel's most sensitive data dependency and the main reason it can't just be a mode of `services/tradew-ai`.

**Exposes:** one internal endpoint, called only by `services/api`.

**Hard boundary:** never blocks or delays an order — it observes and comments in parallel with the normal order flow, it is not a gate in it. Every observation is logged with evidence and a SEBI-relevant label by the Compliance & Audit agent.

**Status:** design-only, no code exists yet.
