# TRADEW-OS.md — The Platform Constitution

Status: **binding, foundational.** This is the constitutional source of truth for the entire TradeW platform. Every other architecture document — `ARCHITECTURE.md`, every file in `docs/product-architecture/`, every future design doc — is subordinate to this one and must reference it. Where a lower doc appears to conflict with this constitution, this constitution wins and the lower doc is the bug.

It sits *above* `ARCHITECTURE.md` (which remains the binding technical service-boundary reference) — this doc says *what TradeW is and the rules it must never break*; `ARCHITECTURE.md` says *how the services are wired*. Read this first, always.

---

## 1. Product philosophy

**TradeW is an AI-powered trading operating system — not an app, a chatbot, or a dashboard.** The benchmark experience is opening VS Code, Obsidian, or a Bloomberg Terminal: a single, coherent workspace a professional lives inside, not a broker website they visit. Concretely, this means:

- **One workspace, many surfaces. No exceptions.** Core Platform, TradeW AI, Sentinel, Learning Hub, Research, TradingView are *surfaces of one OS*, sharing chrome, auth, state, and memory — never separate products bolted together (`README.md`'s "one app, N workspaces"). The benchmark is Bloomberg Terminal, Microsoft 365, Adobe Creative Cloud, Notion: each contains many products and workspaces, and each is still experienced as **one ecosystem**. A user moving between Dashboard, Markets, Trading, Portfolio, Watchlists, Research, AI, Sentinel and Settings must never feel they have left the platform.

  A surface may have its own workspace, layouts, screens and workflows where its job genuinely differs — Sentinel's does — but it lives inside the ecosystem and follows the same design language, navigation philosophy, authentication and user experience. **Sentinel is the platform's flagship premium intelligence workspace and the AI intelligence layer beneath the whole product, not a separate application.** It is one of the primary reasons users subscribe.

  *(A 2026-07-21 direction change briefly made Sentinel an explicit exception here — its own marketing site and standalone application with no shared navigation. That was reversed on the same date as a misreading of the product vision; it was never executed in code. See `SENTINEL.md` §5.)*

- **Marketing surface ≠ application architecture.** A dedicated Sentinel landing page, marketing site, domain or subdomain, and independent SEO and product marketing are all fine and expected — marketing reaches people who are not yet users. The rule binds from sign-in onward: once authenticated, Sentinel is experienced as part of TradeW. Never let a marketing decision propagate into the application's navigation, shell, or identity.
- **The application is always alive.** Live data, ambient intelligence, and restored state mean the product is never a cold, empty page — it resumes (§ Workspace Continuity, `WORKSPACE-CONTINUITY.md`).
- **Observation, never advice.** TradeW explains, reflects, and educates. It never issues buy/sell instructions and never places a trade on the user's behalf. This is a product identity, a compliance posture (SEBI/DPDP), and a hard architectural rule all at once — see §5.

## 2. Architectural principles (the non-negotiables)

1. **Extend before you build.** If existing infrastructure can be cleanly extended, extend it — do not stand up a parallel system. The canonical example: the product Knowledge Graph and Research Vault extend Sentinel's already-implemented Postgres+pgvector Brain rather than introducing a second memory system (`KNOWLEDGE-GRAPH.md`, `RESEARCH-VAULT.md`). Duplicate infrastructure is a violation, not a style choice.
2. **One public ingress.** `apps/*` reach the backend only through `services/api`. One place for auth, entitlement, rate-limiting, and audit. (`ARCHITECTURE.md` §1.)
3. **No AI-initiated trades, ever.** No AI service (`tradew-ai`, `sentinel`) calls `trading-engine` or places an order — not even gated. A human action through the normal order-entry flow is the only path from an AI observation to a real order. (`ARCHITECTURE.md` §1, §3, §4.)
4. **AI systems are independent; orchestration lives at the ingress.** `services/tradew-ai` and `services/sentinel` never call each other directly (`ARCHITECTURE.md` §9). When a single user request needs both — e.g. TradeW AI "auto-invoking" Sentinel for premium reasoning — `services/api` is the orchestrator that fans the request out to both and merges the result. "TradeW AI invokes Sentinel" is always shorthand for "the api layer, handling a TradeW AI interaction, also invokes Sentinel and composes" — never a direct service-to-service call. (See §5, and `TRADEW-AI.md`.)
5. **One schema owner per table.** Explicit table ownership; never two ORMs over one table. (`ARCHITECTURE.md` §4.)
6. **Everything premium is explainable.** Any premium AI conclusion must be able to show its reasoning, evidence, historical precedent, confidence, sources, and what changed. Non-optional. (`EXPLAINABILITY.md`.)
7. **Knowledge is versioned, never deleted.** Superseded knowledge is archived and superseded by a new version linked back to what it replaced — the same "archive, never delete" rule `CLAUDE.md` Rule 1 applies to code, applied to data. (`KNOWLEDGE-GRAPH.md` §4.)

## 3. AI orchestration model

TradeW's intelligence is a set of **modular agents**, not monolithic prompts. The full roster and responsibilities live in `AGENT-ARCHITECTURE.md`; the constitutional rules are:

- **Agents are modular and single-responsibility.** Market, Research, News, Learning, Memory, Chart, Portfolio, Risk, Behavior, Sentinel — each does one thing, each is independently testable and replaceable.
- **n8n orchestrates agents; it does not contain business logic.** Workflows sequence, fan-out, and wait-for agents. The reasoning lives in the agents (`services/tradew-ai`, `services/sentinel`), not baked into an n8n node. n8n is coordination and ops automation, never the brain. (`N8N-WORKFLOWS.md`, `AGENT-ARCHITECTURE.md`.)
- **Two runtimes, one orchestration boundary.** Agents live in `services/tradew-ai` or `services/sentinel` by pillar; `services/api` is where a user-facing request is composed across them (§2.4).
- **Entitlement gates reasoning, not visibility.** Users always *see* Sentinel; premium reasoning runs only when trial/subscription allows (§5, `SUBSCRIPTIONS.md`).

## 4. Knowledge lifecycle

TradeW draws a hard line between **research (raw evidence)** and **knowledge (validated understanding)** — the single most important conceptual distinction in the platform's memory:

```
Observation → Research (raw evidence, RESEARCH-VAULT.md)
            → Historical comparison → News correlation
            → Validation → Confidence scoring
            → Knowledge Graph (validated, KNOWLEDGE-GRAPH.md)
            → Learning Hub / Sentinel (consumers)
            → Permanent memory (versioned, never deleted)
```

- **Research is provisional; knowledge is earned.** Raw evidence enters the Research Vault freely; it becomes institutional Knowledge only after passing the validation pipeline with a sufficient confidence score. (`CONTINUOUS-LEARNING-PIPELINE.md`, `RESEARCH-VAULT.md`.)
- **Nothing becomes permanent unvalidated.** The Validation Engine is the one-way gate (`CONTINUOUS-LEARNING-PIPELINE.md` §2).
- **Everything connects.** Knowledge is a graph of relationships, not isolated notes — a node with zero edges after pipeline processing is a bug (`KNOWLEDGE-GRAPH.md` §3).

## 5. Module boundaries

| Module | Owns | Never does |
|---|---|---|
| **Core Platform** (`services/api`, `trading-engine`, `market-data`) | market data, charts, orders, portfolio, watchlists; the single ingress + entitlement + orchestration | — |
| **TradeW AI** (`services/tradew-ai`) | workspace agent: text/voice/navigation/search/app-control + research analysis; available to every user | place orders; call `sentinel` directly; give buy/sell advice |
| **Sentinel** (`services/sentinel`) | premium institutional reasoning: research, behavior, market context, knowledge reasoning, portfolio intelligence, historical similarity, emotional protection; owns the Brain (Knowledge Graph + Research Vault store) | block/delay an order; talk to the user except via its Orchestrator; run premium reasoning without entitlement |
| **Learning Hub** (`services/api` + `services/tradew-ai`) | curriculum, lessons, progress; self-improving from validated knowledge | become a signal service; recommend trades |
| **Research Vault** (Sentinel Brain store) | raw evidence pre-validation | be treated as institutional truth before validation |
| **Knowledge Graph** (Sentinel Brain store) | validated, versioned trading knowledge | be confused with `TradeW/knowledge/` (engineering vault) |

**TradeW AI ↔ Sentinel, precisely stated:** TradeW AI is the always-available workspace agent. When a user's question requires premium institutional reasoning *and* their entitlement allows it, the api layer invokes Sentinel and returns Sentinel's explainable output through the same conversational surface. When entitlement does not allow it, the surface shows Start Free Trial / Upgrade Plan instead of the reasoning — never a silent absence (`SUBSCRIPTIONS.md` §4). The two services stay independent (§2.4); the *product* experience is unified.

## 6. Extension rules (how to add to TradeW without breaking it)

1. **Search before you build.** Check whether an existing service/table/agent already does most of it. Extend it if so (§2.1).
2. **New user-facing capability → a workspace surface under the shared chrome**, not a standalone page that breaks the OS feel (§1).
3. **New intelligence → a modular agent** in the correct runtime by pillar, not logic embedded in `apps/web` or an n8n node (§3).
4. **New persistent knowledge → through the validation pipeline**, landing in Research Vault first, Knowledge Graph only after validation (§4).
5. **New premium output → must satisfy the explainability contract** (`EXPLAINABILITY.md`) before it ships.
6. **New cross-service coordination → orchestrate at `services/api` or via n8n**, never a new direct arrow between AI services (§2.4).
7. **Every new doc references this file.** A product-architecture doc that doesn't tie back to TRADEW-OS.md is incomplete.

## 7. Scalability principles

- **Don't build a distributed system before load demands it.** Redis Streams before Kafka; in-process module before extracted service; monolith-of-services before microservice sprawl (`ARCHITECTURE.md` §2.1, §3). Scale is earned by measured need, not anticipated by guess.
- **Independent scaling where load actually diverges.** A `trading-engine` spike must not force scaling `analytics` — one deployment per service, path-triggered CI (`ARCHITECTURE.md` §7).
- **Background work never blocks the request path.** The learning pipeline, graph validation, and research ingestion run off the user's request (`CONTINUOUS-LEARNING-PIPELINE.md` §5).

## 8. Performance expectations

- Real-time surfaces (watchlist, chart, option chain) update at row/cell granularity — never full-page re-renders (`GENESIS-V2-BLUEPRINT.md` §6).
- Micro-interactions ≤150ms, panels 200–300ms, routes ≤350ms; motion communicates state, never gates an action (`GENESIS-V2-BLUEPRINT.md` §3).
- AI responses stream token-by-token; skeleton loaders (not spinners) above ~150ms latency.
- Speed-to-information is the product's core metric — a trader judges TradeW on how fast the number they need appears.

## 9. Maintainability standards

- **Incremental only.** Small phases; after each, explain what/why, list changed files, remaining work, risks. No big-bang commits. (`CLAUDE.md` Rule 3.)
- **Document-driven.** Architecture is decided in docs before code; new work matches documented boundaries (`CLAUDE.md` Rule 2).
- **Never delete; archive.** Superseded code → `archive/`, superseded knowledge → versioned node. Targeted edits, not whole-file rewrites. (`CLAUDE.md` Rule 1.)
- **One design system.** `packages/ui` implements `DESIGN-SYSTEM.md` exactly; shared motion/token modules, no per-component ad hoc styling.
- **Explainability and audit are features, not afterthoughts** — built in from the first version of any premium surface, not retrofitted.

---

## Reference map

Every document below is subordinate to this constitution:

- `../../ARCHITECTURE.md` — technical service boundaries, communication, dependency graph
- `README.md` — pillar overview and reading order
- `GENESIS-V2-BLUEPRINT.md` — unified deliverable map + phased roadmap
- Pillars: `TRADEW-AI.md`, `TRADEW-ASSISTANT.md`, `SENTINEL.md`, `LEARNING-HUB.md`
- Memory: `KNOWLEDGE-GRAPH.md`, `RESEARCH-VAULT.md`, `CONTINUOUS-LEARNING-PIPELINE.md`
- Cross-cutting: `AGENT-ARCHITECTURE.md`, `EXPLAINABILITY.md`, `WORKSPACE-CONTINUITY.md`, `SUBSCRIPTIONS.md`, `ONBOARDING.md`, `TRADINGVIEW-WORKSPACE.md`, `N8N-WORKFLOWS.md`
- Design: `../design-reference/DESIGN-SYSTEM.md`
