---
type: decision
date: 2026-07-21
tags: [decision, sentinel, product-direction, navigation, architecture]
status: active
supersedes: "2026-07-21 - Sentinel decoupled into standalone marketing+app product"
---

# Sentinel reinstated as a TradeW workspace (decoupling reversed)

## For future Claude
**Sentinel is a workspace inside TradeW. It is not a separate application.**

If you find any document, plan, or comment describing Sentinel as a standalone
product, standalone app, or "its own application with no shared sidebar" — that
is stale text from a reversed decision. Fix it.

Supersedes [[2026-07-21 - Sentinel decoupled into standalone marketing+app product]],
which is retained (Rule 1) but marked **REVERSED — DO NOT IMPLEMENT**.

## The correct product model
TradeW is **one platform** — an operating system for traders. The benchmark is
Bloomberg Terminal, Microsoft 365, Adobe Creative Cloud, Notion: many products
and workspaces, experienced as **one ecosystem**.

Sentinel is:
- one of the major workspaces in that ecosystem,
- the platform's **flagship premium intelligence system**,
- the **AI intelligence layer** beneath Market Intelligence, Market Context
  Detection, Institutional Analysis, Research, Trade Explanations, Risk
  Analysis, Safety Nets and the AI Copilot,
- one of the biggest reasons users subscribe to Premium.

It may have its own layouts, screens and workflows because its job differs. It
still uses the shared shell, design language, navigation, auth and entitlements.

## The distinction that caused the error
**Marketing surface ≠ application architecture.**

A dedicated Sentinel landing page, marketing site, domain or subdomain, separate
SEO and independent product marketing are all fine — marketing reaches people
who are not yet users. The rule binds **from sign-in onward**: once
authenticated, Sentinel is experienced as part of TradeW.

The reversed decision collapsed those two things together and let a marketing
decision propagate into the application's navigation, shell and identity.

## Never duplicate these for Sentinel
Authentication · users · organizations · permissions · entitlements · billing ·
market data · portfolio data · orders · positions · watchlists · AI
infrastructure · backend services · APIs · database · event system ·
notifications.

A second implementation of any of these for Sentinel is an architecture
violation, not a style choice (`TRADEW-OS.md` §2.1, "extend before you build").

## Why this was caught late
The reversed decision was recorded as `status: audited-not-yet-executed` and
propagated into **19 documents** before anyone implemented it. That is the
failure mode worth remembering: a direction change written into the constitution
and cascaded through every dependent doc is expensive to unwind even when zero
code was written.

`TRADEW-OS.md` itself says "where a lower doc appears to conflict with this
constitution, this constitution wins and the lower doc is the bug." The reversed
decision noted it conflicted with §1's "never separate products bolted together"
and resolved the conflict by **amending the constitution** rather than by
treating the conflict as evidence the new direction was wrong. When a change
requires editing the constitution to stop being a violation, that is a signal to
re-check the change, not the constitution.

## The code was already right
No application code was ever changed. Better: the codebase had **already
rejected** this direction empirically, before it was written down.

- `apps/web/src/app/sentinel/page.tsx` renders inside the shared shell and says
  so in its header comment.
- An earlier chrome-less `/sentinel` pass was reverted the same day —
  `archive/web-sentinel-standalone-shell.tsx.txt`, and `archive/README.md`
  records why: *"it left no way to navigate back out to the rest of the app, a
  dead end rather than 'standalone.'"*
- `nav-config.tsx`'s `STANDALONE_ROUTES` is **empty**.

Trust that signal next time: a UI that cannot be navigated out of is not a
product boundary, it is a bug.

## What was corrected (19 files)
Constitution and binding architecture: `TRADEW-OS.md` §1, `ARCHITECTURE.md` §2.2
and §4, `SENTINEL.md` §1 and §5, `DESIGN-SYSTEM.md` §3 and §4,
`docs/product-architecture/README.md`.

Cascade: `GENESIS-V2-BLUEPRINT.md` (Phase 8a withdrawn), `SUBSCRIPTIONS.md`,
`WORKSPACE-SHELL.md`, `WORKSPACE-CONTINUITY.md`, `TRADEW-ASSISTANT.md`,
`ONBOARDING.md` §7, `SENTINEL-KNOWLEDGE-GRAPH.md` §10.

READMEs: root, `apps/web`, `apps/terminal`, `services/sentinel`.

Two substantive corrections beyond wording:
- **`ONBOARDING.md` §7** had specified a shorter Sentinel-only signup dropping
  Trading Experience, Goals, Preferred Markets, Workspace Setup and Platform
  Tour "because none of which exists inside the standalone Sentinel
  application." All of it exists. Restored to the full flow, with
  `workspace_default: sentinel` as the only difference for that entry path.
- **`GENESIS-V2-BLUEPRINT.md` Phase 8a** (a whole roadmap phase for building the
  standalone frontend) is withdrawn — no work implied.

## Related
- [[2026-07-21 - Sentinel decoupled into standalone marketing+app product]] — reversed, retained for provenance
- [[../Plans/2026-07-21 - Full platform and product audit]]
- [[../_INDEX.md]]
- `docs/product-architecture/TRADEW-OS.md` §1 — the constitutional statement
- `docs/product-architecture/SENTINEL.md` §5 — the binding UI model
