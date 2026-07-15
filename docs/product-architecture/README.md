# Product Architecture — Core Platform / TradeW AI / Sentinel

This is the product-level blueprint layer, one step above `ARCHITECTURE.md`'s technical service boundaries. Read this before writing any feature code for the AI or safety-net layers — it's the blueprint every agent should build against, so implementation doesn't make product decisions on the fly.

## The three pillars

```
TradeW Platform
│
├── Core Platform        market data, charts, portfolio, orders, watchlists, scanner, screener, trading engine
├── TradeW AI (Research)  → docs/product-architecture/TRADEW-AI.md
└── Sentinel (Safety Nets) → docs/product-architecture/SENTINEL.md
```

**These are product pillars, not repo folders.** In the monorepo (`ARCHITECTURE.md` §2), all three are served by one `apps/web` and backed by separate runtime services (`services/tradew-ai`, `services/sentinel` vs. Core Platform's `services/api`/`trading-engine`/`market-data`). One app, three workspaces, distinct backends — this is deliberate: users should move between them like switching tabs in one product, never like switching to a different product, while the AI and safety-net systems stay architecturally independent per the instruction that started this document ("TradeW AI and Sentinel should not be the same system").

## Why they're separate systems

- **Different question.** TradeW AI: "what does this mean?" Sentinel: "am I about to make a mistake?"
- **Different data.** TradeW AI reads market/company/news data. Sentinel additionally reads the user's *own* behavioral history — a materially different, more sensitive data dependency.
- **Different tone.** TradeW AI explains. Sentinel reflects and questions.
- **Different compliance posture.** Sentinel's output is logged and SEBI-labelled by its own Compliance & Audit agent (see SENTINEL.md §2) — a requirement that doesn't apply to TradeW AI's research answers the same way.

## What's shared

Both pillars sit inside the same app shell (top bar, index ticker, sidebar, Paper/Live toggle — see `docs/design-reference/DESIGN-SYSTEM.md`) and follow the same non-negotiable rule: **analyze and explain, never execute.** Neither `services/tradew-ai` nor `services/sentinel` ever calls `services/trading-engine` directly (ARCHITECTURE.md §1, §4).

## Reading order for implementers

1. `docs/design-reference/DESIGN-SYSTEM.md` — the visual/component system, extracted from the Emergent mockups, binding for `packages/ui`.
2. `docs/product-architecture/TRADEW-AI.md` — full agent roster, feature set, workflows for Research.
3. `docs/product-architecture/SENTINEL.md` — full agent roster, the Trap Detection composite-signal design, feature set, workflows for Safety Nets.
4. `../../ARCHITECTURE.md` — how these map onto services, communication patterns, and the dependency graph.

## Status

This is the product architecture. No implementation should begin against it until it's reviewed — per the instruction that produced it, the next phase is refining this blueprint (complete workflows, edge cases, agent prompt specs), not writing code yet.
