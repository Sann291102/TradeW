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

## Patterns
Reusable engineering patterns, workflow improvements, development standards.
- [[Patterns/2026-07-17 - Knowledge Workspace]] — in-app `/knowledge` vault viewer (services/api module + apps/web page): FS-backed, no DB, SSE live updates, snapshot-diff poller, dev-gated + authed

## Gotchas
Debugging discoveries, bug resolutions, lessons learned — things that cost time once and shouldn't cost time twice.
- (empty)

## Research
Research summaries and verified findings from trusted external sources.
- [[Research/2026-07-17 - Sentinel Brain audit]] — end-to-end audit: every Brain component (PrismaMemoryStore, PrismaKnowledgeGraph, ConceptLearningEngine, Knowledge Center, pgvector) is fully implemented, not stubbed; the only gaps are operational (no local Postgres/docker-compose/.env yet)
- [[Research/2026-07-17 - Oracle migration assessment]] — BLOCKER: Oracle standardization = full Prisma removal (Prisma has no Oracle provider); no SQL Server exists to replace; pgvector needs Oracle 23ai; decision required before any code

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
