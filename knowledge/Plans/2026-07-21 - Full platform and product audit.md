---
type: plan
date: 2026-07-21
tags: [plan, audit, roadmap, product, reconciliation]
status: active
---

# Full platform and product audit (2026-07-21)

## For future Claude
This is the entry point for "what is TradeW, really, right now" — read this before [[2026-07-17 - Platform audit and implementation roadmap]] (the engineering-only audit it extends) and before re-reading all 21 `docs/product-architecture/` files from scratch. This note reconciles four things that had drifted apart: the engineering vault's own prior audits (some stale, corrected in-place — see each note's "Update 2026-07-21" section), the 21-file product-architecture doc set (product vision, mostly pre-implementation), a ground-truth code pass (real vs. stub, file-by-file), and the LLC-root consolidation history (what TradeW was assembled from, what's still sitting unmigrated).

## 1. Ground truth: what's real vs. stub (2026-07-21 code pass)

**Real, substantive code:** `apps/web` (110 files — full Phase 1 redesign: dockable workspace, Market Workspace, unified Trade page, AI-assisted Option Chain, Knowledge Workspace, Command Palette all confirmed present as code, not just commit-message claims), `services/api` (90 files, 8 NestJS modules: auth/entitlements/health/instruments/knowledge/market-data/sentinel/sim), `services/sentinel` (75 files incl. `brain/` — 818 lines, 11 files, zero stubs), `packages/ai-core` (~1,697 lines — **this is where TradeW AI's actual agent/RAG/memory/provider logic lives**, not in `services/tradew-ai`), `packages/ui` (16 files, design-system components, built 2026-07-18), `packages/database` (21 Prisma models, 5 migrations, zero drift), `infra/docker` (working compose + Caddy + backup script).

**README-only stubs, zero source:** `apps/admin`, `apps/mobile`, `apps/terminal` (static HTML only), `services/auth`, `services/market-data`, `services/trading-engine`, `services/notification`, `services/analytics`, `services/tradew-ai`, `packages/sdk`, `packages/shared`, `agents/tradew-ai`, `infra/k8s`, `infra/terraform`, `infra/oci`, `workflows`, `scripts`. `agents/sentinel` is partial (has `definitions.json`, a config file, not source).

**Key structural finding:** several folders documented in `ARCHITECTURE.md` as future independent microservices (`services/auth`, `services/market-data`, `services/tradew-ai`) have their *actual* logic already living inside `services/api` (as NestJS modules) or `packages/ai-core` (as a library) — this is intentional per `ARCHITECTURE.md` §2.1's extraction-trigger model, not drift, but it means the current system is a modular monolith (`services/api`) + one separate service (`services/sentinel`) + one separate library (`packages/ai-core`), not the multi-service diagram the folder names alone suggest.

**Tooling:** npm workspaces (root `package.json`), not pnpm/Turborepo — no `pnpm-workspace.yaml`/`turbo.json` exists.

## 2. Product vision recap (21 docs in `docs/product-architecture/`)

`TRADEW-OS.md` is the constitution everything else answers to: "AI-powered trading operating system," one workspace many surfaces, always-alive (Workspace Continuity, resume not restart), observation-never-advice as product identity + compliance posture + hard architectural rule simultaneously.

Four pillars, not three: **Core Platform** (market data/charts/orders, no dedicated AI doc), **TradeW AI** (Research — 8-agent roster, ambient copilot + Research workspace, extended by **TradeW Assistant**'s voice/nav layer), **Sentinel** (Safety Nets — 4 agents + orchestrator, Trap Detection's 13 composite signals, own nav-level workspace), **Learning Hub** (education, fed by the Continuous Learning Pipeline). Plus a 5th navigable surface: **TradingView Workspace** (embedded, SSO handoff, hosting model undecided).

Memory spine (one physical store, not parallel systems): Research Vault (raw) → Validation Engine (new, ≥2-signal corroboration) → Knowledge Graph (validated, versioned, never deleted) → feeds Learning Hub content + Sentinel/TradeW AI context. Explainability is the resulting non-negotiable: every premium conclusion shows reasoning/evidence/confidence/sources.

Monetization: Demo tiers (Free/₹99 weekly/₹199 monthly), Learning Hub Lifetime ₹299, Sentinel ₹999-1,399/mo by commitment term — **order placement itself is never gated by any tier.**

Status: almost everything in this doc set is explicitly "design, pre-implementation." Exceptions actually shipped: Workspace Shell (dockable dock/palette/theme engine), client-local Workspace Continuity (localStorage only, no server-side `workspace_session` table yet), Market Workspace/dashboard, Sentinel's shell unification with 2 live endpoints.

`GENESIS-V2-BLUEPRINT.md` §-numbered 11-phase roadmap (authoritative sequencing): 1 Terminal modernization (done) → 2 Onboarding+entitlements → 3 Assistant nav/voice → 4 Learning Hub v1 → 5 Research Vault+KG read surface → 6 Continuous Learning Pipeline → 7 Learning Hub v2 → 8 Sentinel tiers+auto-invoke+explainability → 9 TradingView → 10 server-side Workspace Continuity → 11 n8n build-out.

## 3. LLC-root context (what TradeW was assembled from)

`CONSOLIDATION-PLAN.md` (LLC root, 2026-07-14) audited `tradew-prototype` (×3 copies), `extreme_algo_package` (the real Dhan options bot, destined for `services/trading-engine`, **still not migrated in** as of 2026-07-21), and static HTML prototypes — decided what to keep/archive, nothing executed yet beyond what `TradeW/archive/` now holds (see its corrected README). `TradingBot` (separate Next.js/Supabase/Binance/Claude crypto bot) and `n8n-master` (vendored OSS) are explicitly out of scope, left untouched. Two folders (`AI trading system repos/`, `ai-model-distillation-for-financial-data-main/`) sit at the LLC root **unaudited by the consolidation plan** — unclear if they're reference material or need evaluation; flag for the user.

One item from the consolidation plan needs a live check: a Neon Postgres credential was flagged as committed in cleartext in the old top-level `tradew-prototype/backend/prisma/schema.prisma` (§0, urgent). That's the superseded prototype, not the current `TradeW` monorepo (which uses its own `.env`-based `DATABASE_URL`), but the credential itself should be confirmed rotated regardless of whether that prototype folder is ever touched again.

## 4. Corrections made to prior notes this session

Each of these was appended to in-place (not rewritten, per repo archive-don't-delete policy):
- [[../../archive/README.md]] — "Status: empty" corrected; 2 files are actually present (informal M2 archiving).
- [[../Research/2026-07-17 - Oracle migration assessment]] — resolution recorded (staying on Postgres, per the OCI plan's same-day note), status changed from "blocked-pending-decision" to resolved.
- [[../Research/2026-07-17 - Sentinel Brain audit]] — blockers confirmed resolved per the 07-18 Backend audit; `packages/ai-core` location of real AI logic noted.
- [[2026-07-17 - Platform audit and implementation roadmap]] — `packages/ui` rating corrected to 🟢; `packages/ai-core` flagged as a missing matrix row; Sprint 1 completion explicitly marked unconfirmed/unresolved; npm-workspaces (not pnpm/Turborepo) tooling fact added.

## 5. Open decisions still needing the user (not resolved by this audit)

1. Two disagreeing simulated-market-data engines (`services/api`'s `SimulatedEngineService` vs. `services/sentinel`'s `SimMarketDataProvider`) must be reconciled before Market Data Migration 2 (`Candle`) — see [[../Decisions/2026-07-18 - Market Data domain architecture review]].
2. OCI Free Tier deployment is fully designed (Dockerfiles, compose, CI/CD, Caddy, backups) but **never actually provisioned/deployed** — see [[2026-07-17 - OCI Free Tier deployment]].
3. Billing provider unspecified (Razorpay assumed as natural default, not decided) — `SUBSCRIPTIONS.md`.
4. TradingView hosting model (self-host vs. licensed white-label embed) undecided — `TRADINGVIEW-WORKSPACE.md`.
5. Whether/when to migrate `extreme_algo_package` into `services/trading-engine` (real money bot, currently un-migrated) — needs explicit execution approval per `ARCHITECTURE.md` §2 and the consolidation plan.
6. The two unaudited LLC-root folders (`AI trading system repos/`, `ai-model-distillation-for-financial-data-main/`) — evaluate, archive-in-place, or leave alone?
7. Sprint 1 engineering hardening (tests, rate limiting, boot-time secret validation) — confirm done or schedule it; currently unconfirmed either way.

## Related
- [[2026-07-17 - Platform audit and implementation roadmap]]
- [[2026-07-17 - OCI Free Tier deployment]]
- [[../Research/2026-07-17 - Sentinel Brain audit]]
- [[../Research/2026-07-17 - Oracle migration assessment]]
- [[../Research/2026-07-18 - Backend audit (Milestone 4 Step 0)]]
- [[../Decisions/2026-07-18 - Market Data domain architecture review]]
- [[../_INDEX.md]]
