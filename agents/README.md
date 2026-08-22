# agents/ 🟡

Declarative AI agent definitions — system prompts, allowed tools, guardrail/disclaimer configuration — as version-controlled files, reviewed like code. Split into two subfolders because **TradeW AI and Sentinel are separate systems** (`../docs/product-architecture/README.md`), each with its own runtime (`services/tradew-ai`, `services/sentinel`) and its own agent roster.

- **`tradew-ai/`** — AI Researcher, Company Analysis, News Analysis, Option Chain Analysis, Technical Analysis, Strategy Builder, Portfolio Insights, Learning Assistant. Full spec: `../docs/product-architecture/TRADEW-AI.md`.
- **`sentinel/`** — Market & Technical Intelligence, Emotion Intelligence, Trap & Safety Intelligence, Compliance & Audit, Sentinel Orchestrator. Full spec: `../docs/product-architecture/SENTINEL.md`.

**Hard rule every definition in either subfolder must encode:** no agent output converts into a real order without an explicit, separate user action, and no agent calls `services/trading-engine`. This is a product/compliance boundary, not just a technical one.

**Status (corrected 2026-08-21 — see `../docs/product-architecture/AGENT-LAYERS.md`):**

- **`sentinel/definitions.json` is read by no code.** Sentinel runs no LLM-backed agent on any path. Its reasoning is ten deterministic TypeScript classes in `services/sentinel/src/sentinel-intelligence/agents/` plus six signal engines behind `/observe`. Every field in that file is inert, and the five names in it are not agent ids that run.
- **`tradew-ai/definitions.json` IS loaded**, by `services/tradew-ai`, which runs its one agent (`assistant-planner`) on `POST /assistant/interpret`. `description` and `guardrails` take effect there.
- **`allowedTools` and `systemPromptId` are inert in both files.** No tool and no prompt template is registered anywhere in the repo, so the tool registry is always empty and the prompt lookup always misses.
- **`POST /agents/:name/invoke` does not exist** in either runtime, despite `../ARCHITECTURE.md` §4 specifying it.

The hard rule above still holds and is enforced in code, not by these files: no agent output converts into a real order without an explicit, separate user action, and no agent calls `services/trading-engine`.
