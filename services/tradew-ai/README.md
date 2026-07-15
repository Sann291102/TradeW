# services/tradew-ai 🟡

The runtime for the **TradeW AI (Research)** pillar — replaces the earlier, more generic "ai-orchestrator" concept now that TradeW AI and Sentinel have been split into separate systems (see `../../docs/product-architecture/README.md` for why).

**Full blueprint:** `../../docs/product-architecture/TRADEW-AI.md` — agent roster (AI Researcher, Company Analysis, News Analysis, Option Chain Analysis, Technical Analysis, Strategy Builder, Portfolio Insights, Learning Assistant), workflows, and guardrails.

**Loads agent definitions from:** `../../agents/tradew-ai/`

**Exposes:** one internal endpoint (`POST /agents/:name/invoke`), called only by `services/api` — never directly by `apps/*`.

**Hard boundary:** never calls `services/trading-engine`, never places an order. See ARCHITECTURE.md §4 and TRADEW-AI.md §4.

**Status:** design-only, no code exists yet.
