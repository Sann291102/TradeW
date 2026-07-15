# agents/ 🟡

Declarative AI agent definitions — system prompts, allowed tools, guardrail/disclaimer configuration — as version-controlled files, reviewed like code. Split into two subfolders because **TradeW AI and Sentinel are separate systems** (`../docs/product-architecture/README.md`), each with its own runtime (`services/tradew-ai`, `services/sentinel`) and its own agent roster.

- **`tradew-ai/`** — AI Researcher, Company Analysis, News Analysis, Option Chain Analysis, Technical Analysis, Strategy Builder, Portfolio Insights, Learning Assistant. Full spec: `../docs/product-architecture/TRADEW-AI.md`.
- **`sentinel/`** — Market & Technical Intelligence, Emotion Intelligence, Trap & Safety Intelligence, Compliance & Audit, Sentinel Orchestrator. Full spec: `../docs/product-architecture/SENTINEL.md`.

**Hard rule every definition in either subfolder must encode:** no agent output converts into a real order without an explicit, separate user action, and no agent calls `services/trading-engine`. This is a product/compliance boundary, not just a technical one.

**Status:** no definitions exist yet. Write the first ones once their backing data services (`services/market-data`, `services/analytics`) exist — an agent explaining a feature that isn't built yet has nothing to read.
