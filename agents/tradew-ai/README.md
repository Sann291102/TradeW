# agents/tradew-ai/ 🟡

Agent definitions for the TradeW AI (Research) pillar. See `../../docs/product-architecture/TRADEW-AI.md` §3 for each agent's job, inputs, and boundaries: `ai-researcher`, `company-analysis`, `news-analysis`, `option-chain-analysis`, `technical-analysis`, `strategy-builder`, `portfolio-insights`, `learning-assistant`.

**Status (corrected 2026-08-21):** `definitions.json` **is loaded** — by `services/tradew-ai/src/assistant/assistant.service.ts` — and its one agent, `assistant-planner`, runs for real on `POST /assistant/interpret`. Its `description` and `guardrails` take effect; its `allowedTools` and `systemPromptId` do not, because no tool and no prompt template is registered anywhere in the repo.

The eight-agent roster named above (`ai-researcher`, `company-analysis`, …) does **not** exist in any form. See `../../docs/product-architecture/AGENT-LAYERS.md`.
