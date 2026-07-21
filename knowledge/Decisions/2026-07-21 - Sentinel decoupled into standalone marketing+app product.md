---
type: decision
date: 2026-07-21
tags: [decision, sentinel, product-direction, navigation, marketing, superseded]
status: reversed
superseded_by: "2026-07-21 - Sentinel reinstated as a TradeW workspace (decoupling reversed)"
---

# Sentinel decoupled into a standalone marketing site + application

> # ⛔ REVERSED — DO NOT IMPLEMENT
>
> **This decision was reversed on 2026-07-21, the same day it was recorded.** It
> misread the product vision: TradeW is **one ecosystem** — the Bloomberg
> Terminal / Microsoft 365 / Adobe Creative Cloud / Notion model — and Sentinel
> is its flagship premium intelligence **workspace**, not a separate
> application.
>
> Retained per `CLAUDE.md` Rule 1 (archive, never delete) because the audit
> findings in "Ground truth confirmed" below are still accurate and useful, and
> because the reasoning trail matters. **The direction is not.**
>
> Superseded by [[2026-07-21 - Sentinel reinstated as a TradeW workspace (decoupling reversed)]].
>
> Nothing here was ever executed in code.

## For future Claude
Read this before touching `/sentinel`, `docs/product-architecture/SENTINEL.md`, `TRADEW-OS.md`, or `docs/design-reference/DESIGN-SYSTEM.md` again. The product direction changed a second time in one day (see [[../Plans/2026-07-21 - Full platform and product audit]] for the first change, which made Sentinel the sole visible nav item but kept it inside the shared shell — reverted same session when it left no way to navigate elsewhere). This is a bigger, more explicit pivot: Sentinel now has **its own marketing site + its own application**, with zero shared navigation to Research/Trade/Learning/TradeW AI at all, still built on the same backend/auth/entitlements. A full audit was requested and delivered as a chat artifact before any doc or code changes — this note is the durable summary in case that artifact isn't visible in a later session.

## The core tension this creates
`TRADEW-OS.md` §1 states as a constitutional non-negotiable: "One workspace, many surfaces... never separate products bolted together" and lists Sentinel as one such surface. The new direction makes Sentinel an explicit **exception** to that principle at the frontend-presentation layer only — the backend service boundary (`services/api` single ingress, `services/sentinel` internal-only, shared auth/entitlements) is unaffected and stays fully compliant with the constitution. `TRADEW-OS.md` itself says "where a lower doc appears to conflict with this constitution, this constitution wins and the lower doc is the bug" — so this exception must be written into the constitution itself, not left as an implicit contradiction. **This is the single highest-priority doc change once execution begins.**

## Root cause of the current "Sentinel is a workspace tab" model
Traced to `docs/design-reference/DESIGN-SYSTEM.md` §3 (the original, canonical, Emergent-mockup-derived spec): "Persistent left icon-rail sidebar: Home, Trading, Options, Sentinel, Research, Portfolio, Demo Trade, Explorer... shared across every workspace." Everything downstream (`ARCHITECTURE.md` §4's "one app, three workspaces", `docs/product-architecture/README.md`'s "four pillars, one app", `SENTINEL.md` §5's "shares the same top bar/sidebar chrome as every other workspace", `apps/web/README.md`, root `README.md`) inherits this framing. All of these need updating once execution begins — none yet edited.

## Ground truth confirmed during the audit (2026-07-21)
- No marketing site exists anywhere in the repo. `apps/web/src/app/page.tsx` hard-redirects `/` → `/dashboard`, with a comment explicitly invoking TRADEW-OS.md §1's "no login wall, workspace-first, not a broker marketing site" philosophy — the literal opposite of what a marketing→signup→app funnel needs. Reusing `/` for Sentinel's marketing site would collide with Core Platform's own entry point — flagged as an open decision, not resolved.
- `/sentinel` today (post this session's earlier redesign) already matches the new 5-question content model closely (Day Classification, Market Context, Live Safety Feed with Explainability "Why", Contextual Training, Timeline) but still renders inside the full shared shell (11-item Sidebar, TopBar's Paper/Live toggle + "Ask TradeW AI" button + generic Upgrade CTA) — all Core-Platform/TradeW-AI chrome that needs to come out for a true standalone app.
- `apps/terminal/README.md` calls itself "THE TradeW app," a single static HTML file bundling Core + TradeW AI + Sentinel — a dead, superseded prototype (confirmed stub in the 2026-07-21 ground-truth code audit) that still claims to be canonical. Needs its README corrected to mark it historical/superseded (never delete the file itself, per repo policy).
- `services/sentinel/README.md` and `agents/sentinel/README.md` both still say "no code exists yet" / "empty" — flatly false; `services/sentinel/src/` has 75 real files and the Brain is ~78% complete per [[../Research/2026-07-17 - Sentinel Brain audit]] and [[../Research/2026-07-18 - Backend audit (Milestone 4 Step 0)]]. Unrelated to the new direction but a real accuracy gap surfaced by this audit.
- `ONBOARDING.md`'s single unified flow (Signup → Welcome → Trading Experience → Goals → Preferred Markets → Risk Profile → Workspace Setup → Platform Tour → Dashboard → Sentinel Introduction → Trading) assumes Core Platform navigation concepts (Workspace Setup, Platform Tour) that don't apply to a Sentinel-only entry point. Needs a shorter Sentinel-specific sub-flow: Signup → Welcome → Risk Profile (kept — seeds Emotion Intelligence) → Sentinel Introduction → App.
- `TRADEW-ASSISTANT.md`'s auto-invoke-Sentinel-via-api flow (merging Sentinel's output into "the same conversational surface" as TradeW AI) needs an explicit boundary decision: does it still apply to Core Platform users, with standalone-Sentinel users never seeing the Assistant at all? Not resolved in the audit — flagged for the user.

## What does NOT change
Backend service boundaries, `services/api` single ingress, JWT + entitlements/capabilities auth model, all REST endpoints, the "observation, never advice" principle, and every backend Sentinel doc not listed above (`AGENT-ARCHITECTURE.md`, `KNOWLEDGE-GRAPH.md`, `RESEARCH-VAULT.md`, `CONTINUOUS-LEARNING-PIPELINE.md`, `EXPLAINABILITY.md`, market-data docs) — all confirmed still accurate and unaffected, since this is a frontend-presentation and documentation change only.

## Status
Audited, not yet executed. Full doc-by-doc KEEP/UPDATE/MERGE/DEPRECATE verdicts and the phased roadmap were delivered as a chat artifact per the user's explicit "audit before any changes" instruction — no `docs/product-architecture/*.md` file and no application code was edited during this audit. Next step (pending user go-ahead): amend `TRADEW-OS.md` first, then cascade through `ARCHITECTURE.md`, `docs/product-architecture/README.md`, `DESIGN-SYSTEM.md`, `SENTINEL.md`, before any frontend code changes.

## Related
- [[../Plans/2026-07-21 - Full platform and product audit]]
- [[../Research/2026-07-18 - Backend audit (Milestone 4 Step 0)]]
- [[../Research/2026-07-17 - Sentinel Brain audit]]
- [[../_INDEX.md]]
