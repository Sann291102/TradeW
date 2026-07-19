# Product Architecture — Core Platform / TradeW AI / Sentinel / Learning Hub

This is the product-level blueprint layer, one step above `ARCHITECTURE.md`'s technical service boundaries. Read this before writing any feature code for the AI, safety-net, or learning layers — it's the blueprint every agent should build against, so implementation doesn't make product decisions on the fly.

**[`TRADEW-OS.md`](TRADEW-OS.md) is the platform constitution** — the source of truth every doc in this folder is subordinate to. Read it first. **Then [`GENESIS-V2-BLUEPRINT.md`](GENESIS-V2-BLUEPRINT.md)** for the unified map of every doc here, the phased roadmap, and cross-cutting concerns (motion, accessibility, performance, API-matrix process) that don't belong to any single pillar.

## The four pillars

```
TradeW Platform
│
├── Core Platform        market data, charts, portfolio, orders, watchlists, scanner, screener, trading engine
├── TradeW AI (Research)  → docs/product-architecture/TRADEW-AI.md, TRADEW-ASSISTANT.md
├── Sentinel (Safety Nets) → docs/product-architecture/SENTINEL.md
└── Learning Hub           → docs/product-architecture/LEARNING-HUB.md
```

Cross-cutting systems, each with its own doc: [`RESEARCH-VAULT.md`](RESEARCH-VAULT.md) (raw evidence, pre-validation), [`KNOWLEDGE-GRAPH.md`](KNOWLEDGE-GRAPH.md) (validated institutional knowledge, extends Sentinel's Brain), [`CONTINUOUS-LEARNING-PIPELINE.md`](CONTINUOUS-LEARNING-PIPELINE.md) (Research→Validation→Knowledge, sources Learning Hub content), [`AGENT-ARCHITECTURE.md`](AGENT-ARCHITECTURE.md) (modular agents; n8n orchestrates them), [`EXPLAINABILITY.md`](EXPLAINABILITY.md) (core principle), [`WORKSPACE-CONTINUITY.md`](WORKSPACE-CONTINUITY.md) (resume on return) + [`WORKSPACE-SHELL.md`](WORKSPACE-SHELL.md) (its implemented client-local form: dockable workspace, command palette, theme engine, notifications), [`SUBSCRIPTIONS.md`](SUBSCRIPTIONS.md), [`ONBOARDING.md`](ONBOARDING.md), [`TRADINGVIEW-WORKSPACE.md`](TRADINGVIEW-WORKSPACE.md), [`N8N-WORKFLOWS.md`](N8N-WORKFLOWS.md).

**These are product pillars, not repo folders.** In the monorepo (`ARCHITECTURE.md` §2), all four are served by one `apps/web` and backed by separate runtime services (`services/tradew-ai`, `services/sentinel` vs. Core Platform's `services/api`/`trading-engine`/`market-data`; Learning Hub reuses `services/api` + `services/tradew-ai`, no new runtime). One app, four workspaces, distinct backends where it matters — this is deliberate: users should move between them like switching tabs in one product, never like switching to a different product, while the AI and safety-net systems stay architecturally independent per the instruction that started this document ("TradeW AI and Sentinel should not be the same system").

## Why they're separate systems

- **Different question.** TradeW AI: "what does this mean?" Sentinel: "am I about to make a mistake?"
- **Different data.** TradeW AI reads market/company/news data. Sentinel additionally reads the user's *own* behavioral history — a materially different, more sensitive data dependency.
- **Different tone.** TradeW AI explains. Sentinel reflects and questions.
- **Different compliance posture.** Sentinel's output is logged and SEBI-labelled by its own Compliance & Audit agent (see SENTINEL.md §2) — a requirement that doesn't apply to TradeW AI's research answers the same way.

## What's shared

Both pillars sit inside the same app shell (top bar, index ticker, sidebar, Paper/Live toggle — see `docs/design-reference/DESIGN-SYSTEM.md`) and follow the same non-negotiable rule: **analyze and explain, never execute.** Neither `services/tradew-ai` nor `services/sentinel` ever calls `services/trading-engine` directly (ARCHITECTURE.md §1, §4).

## Reading order for implementers

1. `docs/product-architecture/TRADEW-OS.md` — **the constitution.** Product philosophy, non-negotiable principles, module boundaries, extension rules. Read before anything else; everything below is subordinate to it.
2. `docs/design-reference/DESIGN-SYSTEM.md` — the visual/component system, extracted from the Emergent mockups, binding for `packages/ui`.
3. `docs/product-architecture/TRADEW-AI.md` + `TRADEW-ASSISTANT.md` — full agent roster, feature set, workflows for Research, plus the voice/navigation/app-control assistant and its Sentinel auto-invocation.
4. `docs/product-architecture/SENTINEL.md` — full agent roster, the Trap Detection composite-signal design, feature set, workflows for Safety Nets.
5. `docs/product-architecture/LEARNING-HUB.md`, `RESEARCH-VAULT.md`, `KNOWLEDGE-GRAPH.md`, `CONTINUOUS-LEARNING-PIPELINE.md` — the 4th pillar and the cross-cutting memory lifecycle (raw research → validation → knowledge) that feeds it.
6. `docs/product-architecture/AGENT-ARCHITECTURE.md`, `EXPLAINABILITY.md`, `WORKSPACE-CONTINUITY.md` + `WORKSPACE-SHELL.md` — modular agents, the explainability contract, session continuity, and the implemented dockable-workspace/command-palette/theme/notification shell.
7. `docs/product-architecture/SUBSCRIPTIONS.md`, `ONBOARDING.md`, `TRADINGVIEW-WORKSPACE.md`, `N8N-WORKFLOWS.md` — monetization, first-run flow, charting workspace, ops automation.
8. `docs/product-architecture/GENESIS-V2-BLUEPRINT.md` — how all of the above fit together, plus the phased roadmap.
9. `../../ARCHITECTURE.md` — how these map onto services, communication patterns, and the dependency graph.

## Status

This is the product architecture. No implementation should begin against it until it's reviewed — per the instruction that produced it, the next phase is refining this blueprint (complete workflows, edge cases, agent prompt specs), not writing code yet.
