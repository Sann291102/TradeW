# agents/tradew-ai/ 🟡

Agent definitions for the TradeW AI (Research) pillar. See `../../docs/product-architecture/TRADEW-AI.md` §3 for each agent's job, inputs, and boundaries: `ai-researcher`, `company-analysis`, `news-analysis`, `option-chain-analysis`, `technical-analysis`, `strategy-builder`, `portfolio-insights`, `learning-assistant`.

**Status:** a `definitions.json` config file now exists here; per-agent source definitions are still to be fully fleshed out, and the roster is not yet wired through `services/tradew-ai` (see that service's README). Flesh out `ai-researcher` first — it's the router every ambient-dock conversation goes through.
