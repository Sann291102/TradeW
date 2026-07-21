---
type: index
date: 2026-07-17
tags: [index]
---

# TradeW Knowledge Index

Read this first, every time — cheaper than searching, and search should still come before deep reasoning on any task (see [Rule 4](../../CLAUDE.md) in the project root). One line per note, grouped by folder. Update this file whenever a note is created or removed.

## Decisions
Architecture and project decisions, ADR-style — what was decided, why, what was rejected.
- [[Decisions/2026-07-17 - Obsidian Knowledge Layer adopted]] — why this vault exists, its scope, and how it relates to Sentinel's Postgres Brain
- [[Decisions/2026-07-17 - Genesis v2 blueprint added as new product-architecture docs]] — 9 new docs/product-architecture/ files (Learning Hub, Knowledge Graph, Continuous Learning Pipeline, TradeW Assistant, Subscriptions, Onboarding, TradingView Workspace, n8n catalog, summary blueprint); in-app knowledge graph reuses Sentinel's existing Brain, not new infra
- [[Decisions/2026-07-17 - Genesis v2 direction update (TRADEW-OS constitution + Research Vault)]] — direction update added TRADEW-OS.md (constitution, top of doc hierarchy), Research Vault (raw evidence vs validated knowledge, same store/different stage), Explainability principle, Workspace Continuity, Agent Architecture (n8n orchestrates agents not logic); TradeW AI→Sentinel auto-invoke reconciled as api-layer orchestration (no direct arrow, preserves ARCHITECTURE.md §9)
- [[Decisions/2026-07-18 - Market Data domain architecture review]] — 5-10yr schema review before any migration: Quote=latest-snapshot only (needs @@unique+source field, not previously enforced); Candle (new, needed by Charts AND Sentinel's Trap Detection — currently blocked without it); OptionMetrics separate from Quote (cardinality/write-pattern mismatch); Depth L2 never persisted (realtime-only); CorporateAction + Watchlist/WatchlistItem also net-new; 4 migrations sequenced, none applied; full doc: docs/product-architecture/MARKET-DATA-ARCHITECTURE.md

## Patterns
Reusable engineering patterns, workflow improvements, development standards.
- [[Patterns/2026-07-17 - Knowledge Workspace]] — in-app `/knowledge` vault viewer (services/api module + apps/web page): FS-backed, no DB, SSE live updates, snapshot-diff poller, dev-gated + authed
- [[Patterns/2026-07-18 - packages-ui foundation (tokens, preset, transpilePackages)]] — Phase 1 M1: how the shared design system is wired (source-only via transpilePackages, tokens extracted verbatim from canonical HTML, Tailwind preset, dark-first default, buttonClasses recipe, motion module)
- [[Patterns/2026-07-18 - M2 terminal conversion (shell, widgets, terminal slots)]] — Phase 1 M2: HTML terminal→React (path-aware AppFrame shell around existing pages without moving them, config-driven sidebar, dashboard widgets, terminal slot panels, lazy loading, layout reconciliation, trade-page archive decision)
- [[Patterns/2026-07-18 - M3 dockable workspace (zustand store, dock engine, command palette)]] — Phase 1 M3: zustand store + hydration-safety pattern, theme no-flash script, 5-zone dock (not free-floating windows), command palette = unified global search w/ modular+stub providers, state ownership migrated off local useState, browser-automation verification gotchas
- [[Patterns/2026-07-18 - M4 Step1 real auth session (sessionStore, AppFrame remount gotcha)]] — Phase 2 M4 Step 1: real /auth + /entitlements wiring, zero new backend code; sessionStore deliberately unpersisted; AppFrame-doesn't-remount-on-navigation bug found+fixed in login/signup; entitlement UI verified via real admin-API grant+revert round-trip
- [[Patterns/2026-07-18 - Market Data Migration 1 executed (Quote revision, baseline established)]] — Quote revision applied as 2 migrations after live-DB diff caught pre-existing drift (schema.prisma had columns no migration ever shipped); `prisma migrate dev` unusable non-interactively, hand-authored SQL + `migrate deploy` instead; full baseline doc created, flags Sentinel's ephemeral candle simulator as a Migration 2 design question

## Gotchas
Debugging discoveries, bug resolutions, lessons learned — things that cost time once and shouldn't cost time twice.
- `packages/database/prisma/seed.ts`'s `seedDemoAccount()` throws `bcrypt.hash is not a function` — a pre-existing ts-node ESM/CJS interop bug, confirmed unrelated to any recent change via git diff, not yet fixed. See [[Patterns/2026-07-18 - Market Data Migration 1 executed (Quote revision, baseline established)]].
- No ESLint config exists anywhere in the repo (pre-existing, not caused by any specific change) — confirmed during Market Data Migration 1.
- `prisma migrate dev` refuses to run in a non-interactive/non-TTY shell, even with `--create-only` — hand-author migration SQL from `prisma migrate diff --script` output and apply with `prisma migrate deploy` instead. See [[Patterns/2026-07-18 - Market Data Migration 1 executed (Quote revision, baseline established)]].
- Always diff a proposed Prisma migration against the **live DB** (`prisma migrate diff --from-url`), not just the schema file — schema.prisma can be edited ahead of any migration during a design conversation, silently drifting from what's actually applied.
- Zustand stores with `persist` middleware need `skipHydration: true` + a manual `rehydrate()` in `useEffect` (deterministic seed data, no `Math.random()`/`Date.now()` before rehydration) to avoid SSR/client hydration mismatches. See [[Patterns/2026-07-18 - M3 dockable workspace (zustand store, dock engine, command palette)]].
- A mount-only `useEffect` (e.g. in `AppFrame`) does not re-run on client-side route navigation — if "the action succeeded but the shell/UI didn't update," suspect a mount-only effect on a component that doesn't remount on navigation. See [[Patterns/2026-07-18 - M4 Step1 real auth session (sessionStore, AppFrame remount gotcha)]].

## Research
Research summaries and verified findings from trusted external sources.
- [[Research/2026-07-17 - Sentinel Brain audit]] — end-to-end audit: every Brain component (PrismaMemoryStore, PrismaKnowledgeGraph, ConceptLearningEngine, Knowledge Center, pgvector) is fully implemented, not stubbed; the only gaps are operational (no local Postgres/docker-compose/.env yet)
- [[Research/2026-07-17 - Oracle migration assessment]] — BLOCKER: Oracle standardization = full Prisma removal (Prisma has no Oracle provider); no SQL Server exists to replace; pgvector needs Oracle 23ai; decision required before any code
- [[Research/2026-07-18 - Backend audit (Milestone 4 Step 0)]] — only services/api + services/sentinel are real; auth/market-data/notification/tradew-ai/analytics are README-only placeholders; trading-engine (live-money bot) not yet migrated in; full endpoint/DB/Prisma/frontend-client inventory + per-subsystem readiness map

## Agents
Agent responsibilities and roster notes (Sentinel, TradeW AI, Claude Code subagents), prompt improvements.
- **Where the code actually lives (as of 2026-07-21):** TradeW AI's real agent/RAG/memory/provider logic is implemented in `packages/ai-core` (~1,697 lines) — not in `services/tradew-ai` or `agents/tradew-ai`, which remain README-only stubs. Sentinel's agents (Market & Technical Intelligence, Emotion Intelligence, Trap & Safety Intelligence, Compliance & Audit, Orchestrator) are real and live in `services/sentinel/src/{intelligence,compliance,orchestrator}/`. `agents/sentinel/` holds only a `definitions.json` config file, not source. Full agent roster and "never does" boundaries per agent are specified in `docs/product-architecture/TRADEW-AI.md`, `SENTINEL.md`, and `AGENT-ARCHITECTURE.md` (the cross-cutting naming/consolidation layer) — see [[Plans/2026-07-21 - Full platform and product audit]] for the reconciled summary.

## Plans
Future implementation plans, milestones, strategy documentation.
- [[Plans/2026-07-21 - Full platform and product audit]] — **start here.** Reconciles the engineering vault, all 21 product-architecture docs, a ground-truth code pass, and LLC-root consolidation history; lists corrections made to stale notes and open decisions still needing the user
- [[Plans/2026-07-17 - Platform audit and implementation roadmap]] — full platform audit (endpoints, auth matrix, DB ownership, security findings, tech debt, production-readiness ratings) + prioritized build order + sprint plan
- [[Plans/2026-07-17 - OCI Free Tier deployment]] — Oracle Cloud (host only, Postgres stays) deployment: Dockerfiles + prod compose + Caddy/SSL + backups + CI/CD for a single Ampere A1 arm64 VM; canonical design in infra/oci/README.md

## API
API integration notes — auth quirks, rate limits, payload shapes, gotchas specific to a third-party API.
- (empty)

## What does NOT belong here
Live market data, real-time analytics, raw session logs/transcripts, anything already canonically documented in [ARCHITECTURE.md](../ARCHITECTURE.md) or [docs/product-architecture/](../docs/product-architecture/) (link to those instead of duplicating them). Trading-domain memory (market patterns, symbol history) lives in Sentinel's own Postgres Persistent Knowledge Brain (`services/sentinel/src/brain/`), not here.
