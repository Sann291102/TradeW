# TradeW — Target Architecture Scaffold

This folder is the **blueprint** for the final consolidated TradeW monorepo, agreed after the audit in [`../CONSOLIDATION-PLAN.md`](../CONSOLIDATION-PLAN.md). It currently contains **structure and documentation only** — no source code has been moved here yet.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) first — it's the single document that defines service boundaries, communication patterns, the AI/Sentinel architecture, environment strategy, deployment, observability, and the dependency graph that all future development must follow. Then read [`docs/product-architecture/README.md`](docs/product-architecture/README.md) for the product-level blueprint of the two AI systems before writing any feature code for them.

Every subfolder below has its own `README.md` explaining: what it's for, what real code (from the audited projects) will eventually land there, and its current status.

```
TradeW/
├── ARCHITECTURE.md          ← read this first
├── apps/           web, admin, mobile — user-facing frontends (web hosts every workspace as one app: Core Platform, Research, Sentinel, Learning — see TRADEW-OS.md §1)
├── services/       api, trading-engine, market-data, tradew-ai, sentinel, notification, auth, analytics
├── packages/       ui, types, sdk, database, shared — code shared across apps/services
├── agents/         declarative agent definitions, split into tradew-ai/ and sentinel/ — separate systems
├── workflows/      versioned n8n workflow exports
├── docs/
│   ├── product-architecture/   ← product blueprint for TradeW AI & Sentinel — read before implementing either
│   └── product, build-plan, design-reference   (design-reference includes the Emergent-mockup-derived design system)
├── infra/          docker, k8s, terraform — deployment infrastructure as code
├── scripts/        repo-wide tooling (codegen, seed, bootstrap)
└── archive/        superseded code, retained not deleted
```

**Status legend used in each README:** 🟢 real code exists today and maps directly here · 🟡 new service/package, designed but not yet built · ⚪ documentation/config only, no runtime code expected soon.
