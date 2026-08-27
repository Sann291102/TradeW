# TradeW Genesis v2 — Unified Blueprint

Status: design, pre-implementation. Governed by [`TRADEW-OS.md`](TRADEW-OS.md) — the platform constitution, which every doc here is subordinate to. This is the summary layer tying together the Genesis v2 brief's deliverables. It does not restate what's already binding in `TRADEW-OS.md`, `ARCHITECTURE.md`, `TRADEW-AI.md`, `SENTINEL.md`, or `DESIGN-SYSTEM.md` — it links to those and to the new docs this brief added, and resolves the cross-cutting pieces (roadmap, API matrix approach, accessibility, performance) that don't belong in any single pillar doc.

**No code should be written against this document until it's reviewed** — same review gate every other product-architecture doc in this folder carries (`README.md`'s Status section).

> **Direction update (2026-07-17) folded in.** The final product-direction update added: the constitutional `TRADEW-OS.md`; a `RESEARCH-VAULT.md` (raw evidence, distinct from validated Knowledge); `EXPLAINABILITY.md` (core principle); `WORKSPACE-CONTINUITY.md`; `AGENT-ARCHITECTURE.md` (modular agents, n8n orchestrates them); and TradeW AI auto-invoking Sentinel via the api layer (`TRADEW-ASSISTANT.md` §6). All are reflected in §1 and §2 below.

## 1. The four pillars, now

```
TradeW Platform
│
├── Core Platform         market data, charts, portfolio, orders, watchlists, scanner, screener, trading engine
├── TradeW AI (Research)  → TRADEW-AI.md, TRADEW-ASSISTANT.md (voice/nav extension)
├── Sentinel (Safety Nets) → SENTINEL.md
└── Learning Hub           → LEARNING-HUB.md   [NEW — 4th pillar]
```

Cross-cutting systems that touch multiple pillars, each with its own doc:

- **Platform constitution** → `TRADEW-OS.md` — the source of truth every other doc references; read first
- **Research Vault** → `RESEARCH-VAULT.md` — raw evidence, pre-validation; same store as the graph, separated by stage
- **Institutional Knowledge Graph** → `KNOWLEDGE-GRAPH.md` — validated knowledge; extends Sentinel's existing Postgres+pgvector Brain, not a new store
- **Continuous Learning Pipeline** → `CONTINUOUS-LEARNING-PIPELINE.md` — Research Vault → Validation → Knowledge Graph; feeds Learning Hub content
- **Agent Architecture** → `AGENT-ARCHITECTURE.md` — modular agent roster; n8n orchestrates agents, never holds logic
- **Explainability** → `EXPLAINABILITY.md` — core principle: every premium conclusion shows its reasoning/evidence/history/confidence/sources
- **Workspace Continuity** → `WORKSPACE-CONTINUITY.md` — resume tabs/watchlists/charts/conversations/progress on return
- **Subscriptions & Monetization** → `SUBSCRIPTIONS.md` — Demo Trading, Learning Hub lifetime, Sentinel tiers
- **Onboarding** → `ONBOARDING.md`
- **TradingView Workspace** → `TRADINGVIEW-WORKSPACE.md`
- **n8n Workflow Catalog** → `N8N-WORKFLOWS.md`

## 2. Deliverable map (the brief's 20 sections → where each is answered)

| # | Deliverable | Where |
|---|---|---|
| 0 | Platform constitution / architecture principles | `TRADEW-OS.md` (direction update §16) — the source of truth all others reference |
| 1 | Design System | `DESIGN-SYSTEM.md` (existing, binding) — color, typography, layout, component inventory extracted from the Emergent mockups |
| 2 | UX Principles | `DESIGN-SYSTEM.md` + this doc §5 (accessibility), §6 (performance) |
| 3 | Component Library | `DESIGN-SYSTEM.md` §4 (component inventory) — becomes `packages/ui` per `ARCHITECTURE.md` §6 |
| 4 | Folder Structure | `ARCHITECTURE.md` §2 (existing monorepo structure) — unchanged by this brief; new services this brief might imply (none — see §4 below) |
| 5 | Frontend Architecture | `ARCHITECTURE.md` §2, §6 (`apps/web` + `packages/ui`/`types`/`sdk`) |
| 6 | Motion Guidelines | §3 below |
| 7 | API Integration Matrix | §4 below (template + process, not a speculative full matrix) |
| 8 | n8n Workflow Architecture | `N8N-WORKFLOWS.md` |
| 9 | AI Assistant Architecture | `TRADEW-AI.md` + `TRADEW-ASSISTANT.md` |
| 10 | Sentinel Architecture | `SENTINEL.md` (existing, binding) |
| 11 | Obsidian Knowledge Graph Architecture | `KNOWLEDGE-GRAPH.md` |
| 12 | Continuous Learning Pipeline | `CONTINUOUS-LEARNING-PIPELINE.md` |
| 13 | Learning Hub Architecture | `LEARNING-HUB.md` |
| 14 | Subscription System | `SUBSCRIPTIONS.md` |
| 15 | TradingView Integration | `TRADINGVIEW-WORKSPACE.md` |
| 16 | Dashboard Layout | `DESIGN-SYSTEM.md` §3 (existing Home/card-grid layout) — no change needed for Core Platform's own Risk/Brain-adjacent widgets. Sentinel surfaces on Home as a briefing card/widget linking into the `/sentinel` workspace, as one pillar among several (`SENTINEL.md` §5). |
| 17 | Onboarding Flow | `ONBOARDING.md` |
| 18 | Performance Strategy | §6 below |
| 19 | Accessibility Checklist | §5 below |
| 20 | Phased Implementation Roadmap | §7 below |

Direction-update additions (2026-07-17), beyond the original 20:

| Item | Where |
|---|---|
| Research Vault (raw evidence vs. validated knowledge) | `RESEARCH-VAULT.md` |
| Explainability as a core principle | `EXPLAINABILITY.md` |
| Workspace Continuity (resume on return) | `WORKSPACE-CONTINUITY.md` |
| Agent Architecture (modular agents, n8n orchestrates) | `AGENT-ARCHITECTURE.md` |
| TradeW AI auto-invokes Sentinel (api-layer orchestration) | `TRADEW-ASSISTANT.md` §6, `TRADEW-OS.md` §2.4 |
| Full application control by the assistant | `TRADEW-ASSISTANT.md` §5 |

## 3. Motion guidelines

Framer Motion is a usability tool here, not decoration — it should communicate state change, not add visual noise on top of a dense trading terminal. Rules:

- **Duration budget**: micro-interactions (hover, tab switch, tooltip) ≤150ms; panel/drawer/modal transitions 200–300ms; page/route transitions ≤350ms. A trading terminal is judged on speed-to-information — nothing should feel like it's making the user wait for a chart or the order book.
- **What gets motion**: sidebar expand/collapse, docked AI panel open/close, drawer/modal enter-exit, skeleton-loader → content swap, watchlist row price-flash (color pulse on tick change — already implied by the existing HTML's `.up`/`.dn` classes and `pulse` keyframe), toast/notification enter-exit, route transitions between shared workspaces (Core/Research/Sentinel/Learning), search-result transitions. Sentinel is one of these shared-shell route transitions like any other workspace (`SENTINEL.md` §5).
- **What does NOT get motion**: live numeric ticks themselves (price/PnL values update instantly, no animated count-up — traders need the real number now, not an animated approach to it), anything on the order-submission critical path (confirm/submit buttons react immediately, no animation gating an action).
- **Reduced motion**: honor `prefers-reduced-motion` — collapse all transition durations to near-zero, keep state changes but drop the animation, per the accessibility checklist (§5).
- **Consistency**: one shared `packages/ui` motion-variants module (easing curves, duration tokens) — no per-component ad hoc `transition={{...}}` reinventing timing.

## 4. API Integration Matrix — process, not a speculative table

The brief asks for "UI → API Endpoint → Nest Service → Database Table → Status" for every component, plus flags for Missing APIs / Unused Services / Unused Tables / Dead Environment Variables / Disconnected Features. That audit is only meaningful against the **actual current codebase state** — inventing endpoint names and table names now, before `services/api` for these new features exists, would just be guessing. The right process:

1. Once a pillar/system in §1 moves from "design" to "build," its implementer fills in a matrix row per UI component touched, following exactly this shape:
   `UI component → API endpoint → NestJS service/module → Prisma table → status (live / mock / missing)`
2. This matrix lives as a living doc per phase (§7) — e.g. `docs/product-architecture/api-matrix/PHASE-1.md` — not one giant upfront table, because most of these tables/endpoints don't exist yet and a static matrix would be stale the moment implementation starts.
3. "Replace every mock with real backend services" (the brief's Backend Integration section) is the acceptance criterion for exiting each phase, not a one-time pass — see the roadmap's per-phase "no `apps/web` component may call a mocked endpoint by the end of this phase" rule.

## 5. Accessibility checklist

- Full keyboard navigation for every workspace — trading terminals are used by power users who expect keyboard-first flows (per the brief's own "keyboard-first workflow" principle); every nav item, watchlist row, and order-entry field must be reachable and operable without a mouse.
- Visible focus states on all interactive elements (buttons, table rows, chart toolbar controls) — the dark-first theme (`DESIGN-SYSTEM.md` §1) must keep focus rings at sufficient contrast against `bg.surface`.
- Color is never the sole signal — green/red for gains/losses always pairs with a `+`/`-` prefix or up/down icon, not color alone (screen-reader and color-blind users need the non-color cue).
- `prefers-reduced-motion` respected everywhere motion is used (§3).
- ARIA live regions for price/PnL updates that matter to screen-reader users (portfolio total, active order status) — not for every tick, which would be unusable noise.
- Voice input (`TRADEW-ASSISTANT.md`) is an *addition* to text input, never a replacement — every voice-triggered action must have an equivalent keyboard/click path.
- Minimum contrast ratios (WCAG AA) checked against both the dark theme and any light-mode variant, if one is ever built — the current HTML reference already ships both (`body[data-theme="dark"]`).

## 6. Performance strategy

- **Real-time data path**: watchlist/chart/option-chain updates should not trigger full-page or full-list re-renders — row-level or cell-level updates only (the existing HTML's tick-level `.wrow` update pattern is the right granularity to preserve when porting to React).
- **Code-splitting per workspace**: Core Platform, Research, Sentinel, Learning Hub and TradingView each lazy-load as separate route bundles within `apps/web` — a user who never opens Learning Hub shouldn't pay its bundle cost, and the same applies to Sentinel. Being one application does not mean one bundle; route-level splitting is how a shared shell stays cheap (`SENTINEL.md` §5).
- **Skeleton loaders, not spinners**, for anything above ~150ms of expected latency (chart load, option chain fetch) — matches the existing "Skeleton loaders" motion guideline and keeps layout stable (no content-jump on load).
- **AI assistant responses stream**, not wait-for-complete — TradeW AI/Sentinel responses render token-by-token where the underlying model call supports it, so the docked panel never shows a long blank wait.
- **Knowledge Graph/pipeline work stays off the request path** — the Continuous Learning Pipeline (`CONTINUOUS-LEARNING-PIPELINE.md`) runs as background processing; no user-facing request ever blocks on a graph-validation pass.
- Defer to `ARCHITECTURE.md` §8 (Observability) for the metrics that make performance regressions visible — this section states the design intent, that section states how it's measured.

## 7. Phased implementation roadmap

Ordered by dependency, not by brief section order — each phase must leave the platform in a shippable state, per `CLAUDE.md` Rule 3 (work incrementally, no big-bang commits).

| Phase | Scope | Depends on |
|---|---|---|
| **1 — Terminal modernization** | Convert the existing HTML terminal (`Planning/tradew-site/index.html`) into `packages/ui` React components; add Framer Motion per §3; accessibility pass per §5. No new backend. | none — pure frontend conversion of the master visual reference |
| **2 — Onboarding + entitlement foundation** | `ONBOARDING.md` flow; `entitlements`/`demo_order_counter`/`billing_transactions` tables; Demo Trading limits (`SUBSCRIPTIONS.md` §1) | Phase 1 (needs the shell to route into) |
| **3 — TradeW Assistant (nav + voice)** | Intent classifier, navigation command grammar (`TRADEW-ASSISTANT.md`), voice input — layered onto the *existing* TradeW AI ambient copilot, not a rebuild. **Scope expanded 2026-08-10** to the full AI-shell layer: named persona chosen pre-signup (`AI-PERSONA.md`), wake word + duplex voice (`AI-VOICE.md`), trading-day conversation persistence (`AI-CONVERSATION-LIFECYCLE.md`), the six-stage request pipeline and server-side compliance gate (`TRADEW-ASSISTANT.md` §9–§11). The navigation half shipped 2026-07-26 (`apps/web/src/lib/assistant/`); the analysis half needs `services/tradew-ai` to exist | Phase 1 |
| **4 — Learning Hub v1** | `lessons`/`learning_paths`/`learning_progress`/`learning_bookmarks` tables, static/manually-curated initial content, Lifetime Access entitlement | Phase 2 (entitlement gate) |
| **5 — Research Vault + Knowledge Graph read surface** | Add `stage`/`validation_status` discriminator to the Brain (`RESEARCH-VAULT.md` §2); node-type taxonomy + read API on top of Sentinel's existing Brain (`KNOWLEDGE-GRAPH.md` §2) | none new — Sentinel Brain already exists; this is additive |
| **6 — Continuous Learning Pipeline** | Validation Engine, Market/Research/Historical/News agent chain, n8n orchestration of the sequence (`CONTINUOUS-LEARNING-PIPELINE.md`, `AGENT-ARCHITECTURE.md` §3) | Phase 5 (needs Research Vault + graph to write into) |
| **7 — Learning Hub v2 (self-updating)** | Lesson generation sourced from validated graph nodes (`LEARNING-HUB.md` §3) | Phase 4 + Phase 6 |
| **8 — Sentinel subscription tiers + auto-invoke + explainability** | Full pricing UI (`SUBSCRIPTIONS.md` §3), Start Free Trial / Upgrade Plan gating; api-layer TradeW AI→Sentinel escalation (`TRADEW-ASSISTANT.md` §6, Core Platform only); explainability block on premium responses (`EXPLAINABILITY.md`) | Phase 2 (entitlement) + Phase 5 (evidence to explain) |
| ~~**8a — Sentinel standalone marketing site + application**~~ **(withdrawn 2026-07-21)** | Would have decoupled Sentinel's frontend from the shared shell — its own marketing site and its own minimal application shell replacing the shared Sidebar/TopBar. **Withdrawn the same day it was added**: it contradicted `TRADEW-OS.md` §1's one-ecosystem principle and was a misreading of the product vision. Sentinel is a workspace inside the shared shell (Phase 8), and its frontend needs no separate phase. A dedicated pre-auth *marketing page* remains fine and is a marketing deliverable, not an architecture phase. | — (withdrawn; no work implied) |
| **9 — TradingView workspace** | `tv.tradew-setup.com` integration, SSO handoff (`TRADINGVIEW-WORKSPACE.md`) | Phase 1 (shared chrome must exist) |
| **10 — Workspace continuity** | `workspace_session` layer, restore-on-return (`WORKSPACE-CONTINUITY.md`) | Phases 1–4 (needs surfaces/state worth restoring) |
| **11 — n8n workflow build-out** | Implement the catalog in `N8N-WORKFLOWS.md` as usage from Phases 2–10 creates real triggers; n8n orchestrates agents, never holds logic (`AGENT-ARCHITECTURE.md` §3) | ongoing, per-phase — not a single big phase |

Explainability (`EXPLAINABILITY.md`) is not a single phase — it's an acceptance criterion baked into every premium surface from Phase 6 onward (`TRADEW-OS.md` §9: built in, not retrofitted). Agent naming (`AGENT-ARCHITECTURE.md`) is a conceptual layer applied as each agent is built, not a standalone phase.

Each phase closes with: an updated API Integration Matrix entry (§4), an accessibility re-check (§5) for anything new, and — per `CLAUDE.md` Rule 3 / `TRADEW-OS.md` §9 — an explanation of what/why, changed files, remaining work, and risks before moving to the next phase.

## 8. What this document deliberately does not do

- It does not invent database schemas beyond the table names already named in each pillar doc — exact columns/types are an implementation-time decision.
- It does not pick a billing provider (`SUBSCRIPTIONS.md` §6) or a TradingView hosting model (`TRADINGVIEW-WORKSPACE.md` §6) — both are flagged open, not guessed.
- It does not restate `ARCHITECTURE.md`'s service boundaries, communication patterns, or dependency graph — those are unchanged by this brief and remain the binding reference.
