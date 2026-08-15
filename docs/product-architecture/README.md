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

Cross-cutting systems, each with its own doc: [`RESEARCH-VAULT.md`](RESEARCH-VAULT.md) (raw evidence, pre-validation), [`KNOWLEDGE-GRAPH.md`](KNOWLEDGE-GRAPH.md) (validated institutional knowledge, extends Sentinel's Brain), [`SENTINEL-KNOWLEDGE-GRAPH.md`](SENTINEL-KNOWLEDGE-GRAPH.md) (**implemented** — the concept ontology and reasoning layer behind Sentinel's explanations; companion to the previous doc), [`CONTINUOUS-LEARNING-PIPELINE.md`](CONTINUOUS-LEARNING-PIPELINE.md) (Research→Validation→Knowledge, sources Learning Hub content), [`AGENT-ARCHITECTURE.md`](AGENT-ARCHITECTURE.md) (modular agents; n8n orchestrates them), [`EXPLAINABILITY.md`](EXPLAINABILITY.md) (core principle), [`WORKSPACE-CONTINUITY.md`](WORKSPACE-CONTINUITY.md) (resume on return) + [`WORKSPACE-SHELL.md`](WORKSPACE-SHELL.md) (its implemented client-local form: dockable workspace, command palette, theme engine, notifications), [`SUBSCRIPTIONS.md`](SUBSCRIPTIONS.md), [`ONBOARDING.md`](ONBOARDING.md), [`TRADINGVIEW-WORKSPACE.md`](TRADINGVIEW-WORKSPACE.md), [`N8N-WORKFLOWS.md`](N8N-WORKFLOWS.md), [`DHAN-MARKET-DATA-INTEGRATION.md`](DHAN-MARKET-DATA-INTEGRATION.md) (plan for replacing the simulated feed with a real one).

**These are product pillars, not repo folders.** In the monorepo (`ARCHITECTURE.md` §2), all four pillars — Core Platform, TradeW AI, Sentinel and Learning Hub — are served by one `apps/web` and backed by separate runtime services where it matters (`services/tradew-ai` and `services/sentinel` vs. Core Platform's `services/api`/`trading-engine`/`market-data`; Learning Hub reuses `services/api` + `services/tradew-ai`, no new runtime). One app, N shared workspaces, distinct backends where it matters — this is deliberate: users should move between them like switching tabs in one product, never like switching to a different product.

**Sentinel is a workspace inside that app, not an exception to it** — the flagship premium intelligence workspace and the AI intelligence layer beneath the rest of the platform. "Separate system" throughout this document means a separate *runtime and agent roster* from TradeW AI, never a separate product: `services/tradew-ai` and `services/sentinel` stay independent of each other underneath, while both surface inside the same shell.

> A 2026-07-21 direction change briefly made Sentinel an exception here — its own marketing site and standalone application, reachable only through its own entry points rather than the TradeW sidebar. That was a misreading of the product vision and was reversed the same day; it was never executed in code. See `TRADEW-OS.md` §1, `ARCHITECTURE.md` §2.2, `SENTINEL.md` §5.

## Why they're separate systems

- **Different question.** TradeW AI: "what does this mean?" Sentinel: "am I about to make a mistake?"
- **Different data.** TradeW AI reads market/company/news data. Sentinel additionally reads the user's *own* behavioral history — a materially different, more sensitive data dependency.
- **Different tone.** TradeW AI explains. Sentinel reflects and questions.
- **Different compliance posture.** Sentinel's output is logged and SEBI-labelled by its own Compliance & Audit agent (see SENTINEL.md §2) — a requirement that doesn't apply to TradeW AI's research answers the same way.

## What's shared

Both stay backed by the same auth, entitlement, and single-ingress model, and follow the same non-negotiable rule: **analyze and explain, never execute.** Neither `services/tradew-ai` nor `services/sentinel` ever calls `services/trading-engine` directly (ARCHITECTURE.md §1, §4).

**Everything platform-level is shared and must never be duplicated per pillar:** authentication, users, organizations, permissions, entitlements, billing, market data, portfolio data, orders, positions, watchlists, AI infrastructure, backend services, APIs, database, event system, notifications. Both pillars also sit inside the same app shell — top bar, index ticker, sidebar, Paper/Live toggle (`docs/design-reference/DESIGN-SYSTEM.md` §3). What differs is the *content* of each workspace, not the chrome around it.

## Reading order for implementers

1. `docs/product-architecture/TRADEW-OS.md` — **the constitution.** Product philosophy, non-negotiable principles, module boundaries, extension rules. Read before anything else; everything below is subordinate to it.
2. `docs/design-reference/DESIGN-SYSTEM.md` — the visual/component system, extracted from the Emergent mockups, binding for `packages/ui`.
3. `docs/product-architecture/TRADEW-AI.md` + `TRADEW-ASSISTANT.md` — full agent roster, feature set, workflows for Research, plus the voice/navigation/app-control assistant and its Sentinel auto-invocation.
4. `docs/product-architecture/SENTINEL.md` — full agent roster, the Trap Detection composite-signal design, feature set, workflows for Safety Nets.
5. `docs/product-architecture/LEARNING-HUB.md`, `RESEARCH-VAULT.md`, `KNOWLEDGE-GRAPH.md`, `SENTINEL-KNOWLEDGE-GRAPH.md`, `CONTINUOUS-LEARNING-PIPELINE.md` — the 4th pillar and the cross-cutting memory lifecycle (raw research → validation → knowledge) that feeds it. `SENTINEL-KNOWLEDGE-GRAPH.md` is the one doc in this group with shipped code behind it; read its §1 first if the three things named "knowledge" in this repo are at all unclear.
6. `docs/product-architecture/AGENT-ARCHITECTURE.md`, `EXPLAINABILITY.md`, `WORKSPACE-CONTINUITY.md` + `WORKSPACE-SHELL.md` — modular agents, the explainability contract, session continuity, and the implemented dockable-workspace/command-palette/theme/notification shell.
7. `docs/product-architecture/SUBSCRIPTIONS.md`, `ONBOARDING.md`, `TRADINGVIEW-WORKSPACE.md`, `N8N-WORKFLOWS.md` — monetization, first-run flow, charting workspace, ops automation.
8. `docs/product-architecture/GENESIS-V2-BLUEPRINT.md` — how all of the above fit together, plus the phased roadmap.
9. `../../ARCHITECTURE.md` — how these map onto services, communication patterns, and the dependency graph.

## Status

This is the product architecture — the blueprint layer. **Implementation is well underway** against it: Sentinel (both the TypeScript `services/sentinel` and the newer Python `services/sentinel-py` personal strategy watcher), the market-data + charts stack, subscriptions/entitlements + Razorpay payments, the workspace shell, notifications, and the operator console (`apps/admin`) are all built. See [`../APPLICATION-STATUS.md`](../APPLICATION-STATUS.md) for exactly what runs today and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the service map. The docs here remain the binding spec — where a doc and the code disagree, that's a reconciliation task, not licence to drift. Docs marked **implemented** inline (e.g. `SENTINEL-KNOWLEDGE-GRAPH.md`, `WORKSPACE-SHELL.md`) have shipped code behind them; the rest are still primarily forward specs (TradeW AI Research, n8n workflows, the public SDK).
