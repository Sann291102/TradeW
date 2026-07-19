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
- (empty)

## Research
Research summaries and verified findings from trusted external sources.
- [[Research/2026-07-17 - Sentinel Brain audit]] — end-to-end audit: every Brain component (PrismaMemoryStore, PrismaKnowledgeGraph, ConceptLearningEngine, Knowledge Center, pgvector) is fully implemented, not stubbed; the only gaps are operational (no local Postgres/docker-compose/.env yet)
- [[Research/2026-07-17 - Oracle migration assessment]] — BLOCKER: Oracle standardization = full Prisma removal (Prisma has no Oracle provider); no SQL Server exists to replace; pgvector needs Oracle 23ai; decision required before any code
- [[Research/2026-07-18 - Backend audit (Milestone 4 Step 0)]] — only services/api + services/sentinel are real; auth/market-data/notification/tradew-ai/analytics are README-only placeholders; trading-engine (live-money bot) not yet migrated in; full endpoint/DB/Prisma/frontend-client inventory + per-subsystem readiness map

## Agents
Agent responsibilities and roster notes (Sentinel, TradeW AI, Claude Code subagents), prompt improvements.
- (empty)

## Plans
Future implementation plans, milestones, strategy documentation.
- [[Plans/2026-07-17 - Platform audit and implementation roadmap]] — full platform audit (endpoints, auth matrix, DB ownership, security findings, tech debt, production-readiness ratings) + prioritized build order + sprint plan
- [[Plans/2026-07-17 - OCI Free Tier deployment]] — Oracle Cloud (host only, Postgres stays) deployment: Dockerfiles + prod compose + Caddy/SSL + backups + CI/CD for a single Ampere A1 arm64 VM; canonical design in infra/oci/README.md

## API
API integration notes — auth quirks, rate limits, payload shapes, gotchas specific to a third-party API.
- (empty)

## What does NOT belong here
Live market data, real-time analytics, raw session logs/transcripts, anything already canonically documented in [ARCHITECTURE.md](../ARCHITECTURE.md) or [docs/product-architecture/](../docs/product-architecture/) (link to those instead of duplicating them). Trading-domain memory (market patterns, symbol history) lives in Sentinel's own Postgres Persistent Knowledge Brain (`services/sentinel/src/brain/`), not here.
