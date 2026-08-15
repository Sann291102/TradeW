# agents/ 🟡

Declarative AI agent definitions — system prompts, allowed tools, guardrail/disclaimer configuration — as version-controlled files, reviewed like code. Split into two subfolders because **TradeW AI and Sentinel are separate systems** (`../docs/product-architecture/README.md`), each with its own runtime (`services/tradew-ai`, `services/sentinel`) and its own agent roster.

- **`tradew-ai/`** — AI Researcher, Company Analysis, News Analysis, Option Chain Analysis, Technical Analysis, Strategy Builder, Portfolio Insights, Learning Assistant. Full spec: `../docs/product-architecture/TRADEW-AI.md`.
- **`sentinel/`** — Market & Technical Intelligence, Emotion Intelligence, Trap & Safety Intelligence, Compliance & Audit, Sentinel Orchestrator. Full spec: `../docs/product-architecture/SENTINEL.md`.

**Hard rule every definition in either subfolder must encode:** no agent output converts into a real order without an explicit, separate user action, and no agent calls `services/trading-engine`. This is a product/compliance boundary, not just a technical one.

**Status:** each subfolder now has a `definitions.json`. The Sentinel agents' actual logic already runs inside `services/sentinel/src/{intelligence,compliance,orchestrator}/` (the declarative files here are the reviewed config, not the runtime); the TradeW AI roster is still being fleshed out and is not yet wired through `services/tradew-ai`. See each subfolder's README.
