# services/tradew-ai 🟡

The runtime for the **TradeW AI (Research)** pillar — replaces the earlier, more generic "ai-orchestrator" concept now that TradeW AI and Sentinel have been split into separate systems (see `../../docs/product-architecture/README.md` for why).

**Full blueprint:** `../../docs/product-architecture/TRADEW-AI.md` — agent roster (AI Researcher, Company Analysis, News Analysis, Option Chain Analysis, Technical Analysis, Strategy Builder, Portfolio Insights, Learning Assistant), workflows, and guardrails.

**Loads agent definitions from:** `../../agents/tradew-ai/`

**Exposes:** one internal endpoint (`POST /agents/:name/invoke`), called only by `services/api` — never directly by `apps/*`.

**Hard boundary:** never calls `services/trading-engine`, never places an order. See ARCHITECTURE.md §4 and TRADEW-AI.md §4.

**Status (updated 2026-08-15):** a thin NestJS **runtime scaffold now exists** here (`src/main.ts`, `app.module.ts`, `service-token.guard.ts`, and an `assistant/` controller+service with a `plan-schema.ts`) — enough to boot and enforce the service-token boundary. The substantive TradeW AI intelligence (agent/RAG/memory/provider logic) still lives in `packages/ai-core`, and the research agent roster in `TRADEW-AI.md` is **not yet wired** through this service — the live TradeW AI surface today is the in-app *app-control* assistant in `apps/web`, not per-symbol research. Treat `packages/ai-core` as the implementation of record and this service as the (still mostly empty) runtime shell it will be composed into.
