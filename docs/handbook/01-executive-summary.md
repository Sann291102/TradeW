# Chapter 1 — Executive Summary

> *"The market is a device for transferring money from the impatient to the patient. Most trading software is a device for making users impatient."*
> — the thesis this platform is built to disprove

---

## 1.1 Purpose of this handbook

This handbook exists to answer, without a meeting, the questions a competent engineer will ask in their first ninety days at TradeW:

- What are we building, and for whom?
- Where does the code live, and why is it arranged that way?
- What am I allowed to change, and what requires an architecture review?
- What has already been tried and rejected, and why?
- What is real today versus specified for later?
- How do I ship something without breaking a regulated, latency-sensitive, money-adjacent system?

It is deliberately not a marketing document, not an overview deck, and not a beginner's tutorial on trading or on React. It assumes you can read TypeScript, that you have shipped production software before, and that you would rather read a decision record than be told "it's just how we do it."

It is also, deliberately, **honest about status**. A handbook that describes an aspirational architecture as though it were running is worse than no handbook: it sends engineers looking for code that does not exist and lets them assume behaviour that has never been implemented. Every subsystem in this book carries the status legend from the front matter. Roughly 40% of what follows is 🟢 shipped, 20% is 🟡 partial, and 40% is 🔵 specified. The specified 40% is not filler — it is binding design that constrains whoever builds it — but it is not running, and this book says so at the top of every section.

### 1.1.1 What this handbook is subordinate to

```
                    ┌──────────────────────────────┐
                    │  TRADEW-OS.md                │  ← The Constitution.
                    │  (Platform Constitution)     │    Wins every conflict.
                    └──────────────┬───────────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            │                      │                      │
   ┌────────▼────────┐   ┌─────────▼─────────┐   ┌────────▼────────┐
   │ ARCHITECTURE.md │   │ docs/product-     │   │ CLAUDE.md       │
   │ service         │   │ architecture/*    │   │ workspace rules │
   │ boundaries      │   │ (21 blueprints)   │   │ (Rules 1–4)     │
   └────────┬────────┘   └─────────┬─────────┘   └────────┬────────┘
            │                      │                      │
            └──────────────────────┼──────────────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  THIS HANDBOOK               │  ← Synthesis + standards
                    │  docs/handbook/*             │    + process + PRD.
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  knowledge/ (Obsidian vault) │  ← Living memory.
                    │  Decisions/Patterns/Gotchas  │    Updated per task.
                    └──────────────────────────────┘
```

Where this handbook appears to contradict `TRADEW-OS.md`, the constitution wins and this handbook has a bug — file it. Where it appears to contradict the code, the code wins and *both* have bugs — file both.

---

## 1.2 Vision

**To become the operating system that Indian retail derivatives traders live inside — the way an analyst lives inside a Bloomberg Terminal and a developer lives inside VS Code.**

The word *operating system* is load-bearing and is not a metaphor we use loosely. An operating system has properties a website does not:

| OS property | What it means in TradeW |
|---|---|
| **Persistent state** | Your workspace layout, open panels, active symbol, and drawing tools survive a reload, a logout, and eventually a device change. You *resume*, you don't *restart*. |
| **One shell, many applications** | Sidebar, top bar, command palette, theme, notifications, and search are shared by every pillar. The content area changes; the environment does not. |
| **Shared services** | Auth, entitlements, market data, portfolio, and notifications are platform services. No pillar owns a second copy of any of them. Duplicating one is an architecture violation, not a style choice. |
| **Ambient intelligence** | Sentinel and TradeW AI observe continuously, in the background, without being asked — the way a filesystem indexer runs without being invoked. |
| **Extensibility with rules** | New surfaces are added as workspaces under the shared chrome (Chapter 5, §5.10). "Add a standalone page" is a rejected pattern. |

The benchmark set is explicit and we hold ourselves to it: **Bloomberg Terminal** (density, speed, professional trust), **Microsoft 365 / Adobe Creative Cloud** (many products, one ecosystem), **Notion** (one shell, infinite surfaces), **Linear** (interaction latency as a feature), **Zerodha Kite** (Indian market fluency and the discipline of not over-decorating a trading screen).

### 1.2.1 What we are explicitly not building

Stating the anti-vision saves more argument than stating the vision.

- **Not a signal service.** No "BUY NIFTY 24500 CE, target 180, SL 120." Not in a card, not in a notification, not in an AI response, not in a backtest export.
- **Not a robo-advisor.** We do not construct portfolios for users, do not run discretionary mandates, and do not hold client funds.
- **Not an algo-trading marketplace.** Users cannot deploy strategies that place orders automatically against their own real broker account through TradeW.
- **Not a broker.** We do not clear, settle, or custody. Real-money order flow, when it exists, is routed to a licensed broker (Dhan) under the user's own credentials.
- **Not a chatbot with a chart bolted on.** The AI is a layer beneath the product, not a feature inside it.

Each of these is a live commercial temptation. Each has been explicitly rejected. The reasoning is in Chapter 26 (Decision Records) and the compliance consequence is in Chapter 19 (Security & Compliance).

---

## 1.3 Mission

**Help traders learn, improve, and trade responsibly using AI-first research, paper trading, behavioural coaching, and institutional-grade analytics.**

Four verbs, four product pillars, in order:

```
   LEARN                IMPROVE              TRADE                  UNDERSTAND
   ─────                ───────              ─────                  ──────────
   Learning Hub    →    Sentinel        →    Paper Trading     →    TradeW AI
   curriculum,          behavioural          full OMS with          research,
   lessons,             observation,         real prices,           explanation,
   progress             coaching,            zero risk              market context
                        safety nets

   ↑                    ↑                    ↑                      ↑
   │                    │                    │                      │
   └────────────────────┴────────────────────┴──────────────────────┘
                     one shell, one auth, one memory
```

### 1.3.1 "Learn before you risk" as an architectural constraint

The mission phrase *"users should learn before risking real money"* is not a marketing line; it has three concrete consequences visible in the codebase today:

1. **Paper trading is the default and primary mode, not a demo.** `PaperWallet` grants ₹10,00,000 of simulated capital on first order (`packages/database/prisma/schema.prisma:319`). The paper OMS is a full order lifecycle — MARKET/LIMIT/SL/SL_M, modify, cancel, partial fills, margin blocking, IST session expiry — not a toy. See Chapter 11.

2. **Paper prices are the *real* prices.** `MarketPriceService` deliberately reads the live Dhan bridge rather than the simulated `Quote` table, because filling paper orders against a random walk while the user watches a real chart is "confusing at best, wrong at worst" (`services/api/src/sim/market-price.service.ts:54-72`). A paper fill has to be a real lesson.

3. **Order placement is never gated by subscription tier.** Every monetisation surface in `SUBSCRIPTIONS.md` gates *intelligence*, never *execution*. A free user can place every order type. This is a deliberate refusal of the obvious revenue lever, on the grounds that gating practice contradicts the mission.

### 1.3.2 "Responsibly" as an architectural constraint

The word *responsibly* produces the platform's single most distinctive design rule, and it is worth stating in its strongest form:

> **Sentinel — the entire behavioural safety system — has no authority.**
> It cannot block an order. It cannot delay an order. It cannot add a confirmation step. It cannot even be a synchronous dependency of the order path. It observes, in parallel, and comments.

This is counterintuitive. If you have built a risk system before, your instinct is to make it a gate — that is what a risk system *is*. We deliberately did the opposite, for three reasons:

- **Product:** a system that blocks you is a system you learn to route around. A system that observes you is a system you argue with, and arguing with an observation is how a habit gets noticed.
- **Compliance:** a system that blocks a trade is making a trading decision. A system that observes is producing an educational observation. The regulatory distance between those two is enormous.
- **Engineering:** a risk engine on the order path is a latency budget, a failure mode, and a single point of failure. Sentinel being non-blocking means Sentinel can be down and the platform is still fully functional. That property is worth more than the intervention we gave up.

---

## 1.4 Engineering philosophy

Ten sentences, each of which has already changed a real decision in this codebase.

### 1.4.1 Extend before you build

If existing infrastructure can be cleanly extended, extend it. Duplicate infrastructure is a violation, not a style choice (`TRADEW-OS.md` §2.1).

**Applied:** the product Knowledge Graph and Research Vault extend Sentinel's already-implemented Postgres + pgvector Brain rather than introducing a second memory system. When Genesis v2 proposed a "knowledge graph for the Learning Hub," the answer was `MemoryRecord` + `GraphNode`, not a new store.

**Counter-applied:** the Concept Knowledge Graph (`ConceptNode`/`ConceptEdge`) *is* a second graph, deliberately, because the existing `GraphNode`/`GraphEdge` graph is an **entity** graph whose two relations (`mentions`, `co_occurs_with`) carry no meaning and therefore cannot be reasoned over. Extending it would have meant overloading a structural graph with semantics. Chapter 26, ADR-014 records the argument. This is what "cleanly" is doing in the rule.

### 1.4.2 Don't build a distributed system before the load demands one

Redis Streams before Kafka. In-process module before extracted service. Modular monolith before microservice sprawl. Scale is earned by measured need, not anticipated by guess.

**Applied:** `services/auth`, `services/market-data`, and `services/tradew-ai` all exist as folders in the repository, and their *actual logic* lives inside `services/api` (as NestJS modules) or `packages/ai-core` (as a library). This is not drift — it is the extraction-trigger model from `ARCHITECTURE.md` §2.1 working as designed. The folder is the **contract boundary**; the extraction is a lift of an already-isolated module when a real trigger fires, not a rewrite.

The extraction triggers are written down (Chapter 5, §5.7) so that "should we split this out?" is answered by a number, not by taste.

### 1.4.3 One public ingress

`apps/*` reach the backend only through `services/api`. One place for auth, entitlement checks, rate limiting, and audit logging.

**Enforced in code:** `services/sentinel`'s `ServiceTokenGuard` rejects any request without the shared `SERVICE_TOKEN` header (`services/sentinel/src/app.controller.ts:26-33`). Only `services/api` holds that token. There is no code path from a browser to Sentinel.

### 1.4.4 No AI-initiated trades, ever

Not gated. Not with a confirmation. Not "for the sandbox." The `ToolRegistry` in `packages/ai-core/src/tools/` contains no order-placement tool, and its absence is documented as intentional in the package's own index docstring.

### 1.4.5 Document-driven architecture

Architecture is decided in documents *before* code (`CLAUDE.md` Rule 2). `ARCHITECTURE.md` opens with "approved design, not yet implemented" and that is not an apology — it is the method.

The cost is real: 21 product-architecture blueprints exist for a platform where much is unbuilt, and an engineer can waste a day reading a design for something that does not exist. The mitigation is the status legend and the audit note (`knowledge/Plans/2026-07-21 - Full platform and product audit.md`) that reconciles docs against a ground-truth code pass. Read the audit note before the blueprints.

### 1.4.6 Archive, never delete

Superseded code moves to `archive/`. It is never removed — not in bypass-permissions mode, not during a cleanup, not because it is "obviously dead" (`CLAUDE.md` Rule 1).

Corollary at the data layer: **knowledge is versioned, never deleted.** `Instrument.active` is a soft-delete flag because `Order`/`Trade`/`Position` rows reference delisted instruments forever. `ConceptObservation` is append-only because learned edge weights are derived from those rows, and mutating one would rewrite history that a past explanation already cited.

### 1.4.7 Work incrementally

Small phases. After each: what changed, why, which files, what remains, what the risks are. No big-bang commits (`CLAUDE.md` Rule 3).

This is enforced socially rather than mechanically, and it is the rule most often under pressure. Chapter 25 §25.1 explains how sprint planning is shaped to make small phases the path of least resistance rather than an act of discipline.

### 1.4.8 Every premium conclusion is explainable

Any premium AI output must be able to show reasoning, evidence, historical precedent, confidence, sources, and what changed. Non-optional (`EXPLAINABILITY.md`).

**In code today:** every Sentinel signal carries `evidence: string[]`, every surfaced observation carries `confidence: number`, every Live Safety Feed card has a "Why" panel, and `SentinelObservation` persists the evidence array alongside the text. The orchestrator's fallback composition — used when no LLM provider is configured — produces the same evidence → pattern → soft-suggestion structure deterministically (`sentinel-orchestrator.service.ts:141`). Explainability does not depend on the model being available.

### 1.4.9 Degrade, don't fail

Every enrichment is wrapped so that its failure is non-fatal. Pattern persistence failing must not break `/observe`. Historical similarity lookup failing must not break the synthesis. Market context failing must not break the response. One order's evaluation failing must not stop the rest of the book being evaluated this tick.

Grep the codebase for `non-fatal` and `never break` and you will find this rule written into comments at every seam. It is the single most consistently applied engineering principle in the repository.

### 1.4.10 Comment the *why*, never the *what*

The code in this repository is unusually heavily commented, and the comments are unusually good, because they explain decisions rather than mechanics. Two representative examples:

```ts
// packages/database/prisma/schema.prisma:16-20
/// Added with the scrip-master importer: the Dhan master classifies FUTIDX /
/// FUTSTK contracts, and without this value they would have to be mislabelled
/// as EQUITY or dropped. Not reachable under the default segment allowlist
/// (IDX_I + NSE_EQ) — it matters when F&O segments are enabled.
FUTURE
```

```ts
// services/api/src/sim/order.service.ts:32-38
/**
 * Simplified simulated margin — NOT real SPAN/exposure margin. A paper
 * engine needs *some* number to block so "available balance" is meaningful
 * and "insufficient margin" can genuinely reject an order, without
 * reimplementing an exchange's actual margin engine. Documented here rather
 * than silently presented as authoritative.
 */
```

Neither comment describes what the code does. Both prevent a future engineer from "fixing" something that is deliberate. Chapter 23 §23.6 makes this a review standard.

---

## 1.5 Product philosophy

### 1.5.1 The core bet

**Retail derivatives traders lose money primarily to behaviour, not to information.**

The information asymmetry story — "professionals have better data" — is largely obsolete for Indian retail. Price, volume, and option chain data are cheap and near-universal. What professionals actually have is *process*: position sizing discipline, a pre-defined invalidation, an absence of revenge trading, and an institution that stops them.

TradeW's bet is that software can supply part of that process, and that the market for "help me not do the stupid thing" is larger and more defensible than the market for "tell me what to buy" — which is crowded, commoditised, regulated, and adversarial.

### 1.5.2 Observation, never advice

This is the product's defining constraint and its defining feature. Concretely, the output contract is fixed at three parts and never varies:

```
    ┌───────────────┐    ┌────────────────┐    ┌───────────────────┐
    │   EVIDENCE    │ →  │  PATTERN NAME  │ →  │  SOFT SUGGESTION  │
    └───────────────┘    └────────────────┘    └───────────────────┘

    "Price crossed        "This resembles       "Consider waiting
     resistance 24,810     a low-conviction      for confirmation."
     but volume is 62%     breakout."
     of the 20-bar
     average, and open
     interest is
     declining."
```

Never: *"Don't buy."* Never: *"Sell now."* Never: *"Target 180, SL 120."*

The register is diagnostic and reflective. Sentinel's behavioural cards are literally phrased as questions — *"What pattern do you notice about your exit timing?"* — because a question makes the user do the reasoning, and a user who reasons is a user who learns.

### 1.5.3 Speed to information is the product metric

> Micro-interactions ≤150 ms. Panels 200–300 ms. Routes ≤350 ms. UI interaction target ≈20 ms where technically feasible. (`TRADEW-OS.md` §8.)

A trader judges a terminal on how fast the number they need appears. Not on how it looks, not on how smart it is — on latency. This is why Chapter 20 exists as a full chapter rather than a section, why real-time surfaces update at row/cell granularity rather than re-rendering a page, and why "add a spinner" is a rejected answer to a slow path.

The ~20 ms figure deserves precision, because taken literally it is impossible for anything that crosses a network. What it means, exactly, is defined in Chapter 20 §20.1: **20 ms from user input to first visual acknowledgement**, achieved by rendering from cache/optimistic state immediately and reconciling with the network asynchronously. Network round-trips get their own, larger budgets.

### 1.5.4 Always alive

The application is never a cold, empty page. Live data is streaming, ambient intelligence is observing, and the previous workspace state is restored. You **resume**, you do not **restart**.

Today this is client-local (`workspaceStore` persisted to `localStorage` with `skipHydration: true` and a manual `rehydrate()` — see the Gotchas in Chapter 15). Server-side continuity, which makes it survive a device change, is Genesis Phase 10.

### 1.5.5 One ecosystem, honestly

The strongest product rule, and the one that has already been violated and corrected once:

> On 2026-07-21, a direction change made Sentinel a standalone product with its own marketing site and its own application with no shared navigation. It was reversed the same day, before any code shipped, as a misreading of the product vision.

The reversal note is worth internalising because it contains a general-purpose heuristic:

> **A change that requires amending the constitution to stop being a violation is a signal to re-check the change.**

An earlier attempt at a chrome-less Sentinel page had already been reverted, for a concrete and memorable reason: *it left the user no way to navigate back out.* The architecture rule and the usability failure turned out to be the same fact viewed from two angles. That is usually what a good architectural rule is.

**Marketing surface ≠ application architecture.** A Sentinel landing page, subdomain, and independent SEO are all fine and expected. The rule binds from sign-in onward.

---

## 1.6 Core principles (the ten that bind)

Full treatment in Chapter 2. Stated here as the index:

| # | Principle | The one-line engineering consequence |
|---|---|---|
| 1 | **Customer First** | Order placement is never gated by tier. |
| 2 | **Learning Before Profit** | Paper trading is primary and uses real prices. |
| 3 | **AI-Assisted Decisions** | AI never decides. It observes, explains, and cites evidence. |
| 4 | **Research Driven** | Raw evidence and validated knowledge are different stores with a one-way gate between them. |
| 5 | **Performance Matters** | ~20 ms interaction target; cell-level updates; no full-page re-renders on tick. |
| 6 | **Security First** | One ingress, service tokens between services, append-only audit, secrets never in the repo. |
| 7 | **Scalability First** | Design for the boundary, deploy the monolith. Extraction triggers are written down. |
| 8 | **Reliability** | Every enrichment is non-fatal. Sentinel down ≠ platform down. |
| 9 | **Maintainability** | Archive never delete; targeted edits; document-driven; one design system. |
| 10 | **Developer Happiness** | Local dev works with zero API keys and zero cloud dependencies. |

Principle 10 is not a perk. `createProviderManager(loadProvidersConfigFromEnv())` returning no provider is a **supported state**: Sentinel composes its output deterministically, the market data layer falls back to an Ornstein–Uhlenbeck simulator, and the whole platform runs on `docker compose up` with no keys. An engineer who cannot run the product locally in fifteen minutes does not contribute for a week, and a platform that requires a paid API key to boot has decided that its own onboarding is someone else's problem.

---

## 1.7 Long-term roadmap

The authoritative sequencing is the eleven-phase Genesis v2 roadmap (`GENESIS-V2-BLUEPRINT.md` §7). Phase numbers are stable identifiers and are referenced throughout this handbook.

```
 PHASE   NAME                                    STATUS      HANDBOOK CH.
 ─────   ────────────────────────────────────    ────────    ────────────
   1     Terminal modernisation                  🟢 done      Ch 15, 24
         (dockable workspace, palette, theme)

   2     Onboarding + entitlements               🟡 partial   Ch 4 §4.17
         (auth + entitlements live;                           Ch 16 §16.6
          onboarding flow not built)

   3     Assistant navigation + voice            🔵 spec      Ch 18 §18.9

   4     Learning Hub v1                         🔵 spec      Ch 4 §4.13
         (static curriculum, progress)

   5     Research Vault + KG read surface        🟡 partial   Ch 9 §9.5
         (Brain shipped; read surface not)

   6     Continuous Learning Pipeline            🔵 spec      Ch 18 §18.11
         (validation engine, ≥2-signal
          corroboration gate)

   7     Learning Hub v2                         ⚪ roadmap    Ch 4 §4.13
         (self-improving from validated KG)

   8     Sentinel tiers + auto-invoke +          🟡 partial   Ch 6–9
         explainability

   9     TradingView workspace                   🔵 spec      Ch 13 §13.2

  10     Server-side Workspace Continuity        🔵 spec      Ch 15 §15.7

  11     n8n build-out (ops automation)          🔵 spec      Ch 22 §22.9
```

Beyond Genesis, the five-year direction (Chapter 27) is:

| Horizon | Theme | Headline |
|---|---|---|
| **Year 1** | Finish Genesis | All eleven phases; first paying Sentinel cohort; measured latency budgets replacing targets. |
| **Year 2** | Real money, carefully | `services/trading-engine` migration; Dhan live order routing under user credentials; SEBI-aligned audit surface; `services/auth` extraction if session load triggers it. |
| **Year 3** | Autonomy in research, never in execution | Autonomous research agents that run overnight and file evidence into the Research Vault; multi-broker abstraction; mobile. |
| **Year 4** | Scale and platform | Redis Streams → Kafka if and only if a durability need Redis cannot meet appears; ClickHouse for analytics; public developer API via `packages/sdk`. |
| **Year 5** | Enterprise and institutional | Team/organisation entitlements (`Subscription.organizationId` already exists for this); white-label; compliance-desk product. |

Two things are deliberately absent from every horizon: **automated execution of AI-generated signals**, and **discretionary advice**. They are absent in Year 5 for the same reason they are absent in Year 1.

---

## 1.8 Where TradeW actually is today

A candid snapshot, so nobody is surprised in week two. Source: the ground-truth code pass of 2026-07-21 plus the 2026-07-23 repository reverse-engineering.

### Real, substantive code 🟢

| Component | Scale | What's genuinely there |
|---|---|---|
| `apps/web` | ~110 files | Dockable workspace, command palette, theme engine, Market Workspace, unified Trade page, AI-assisted Option Chain, Knowledge Workspace, Sentinel workspace |
| `services/api` | ~90 files, 8 modules | auth, entitlements, health, instruments, knowledge, market-data, sentinel, sim |
| `services/sentinel` | ~75 files, ~3,500 lines | 4 agents + orchestrator + Brain (11 files, zero stubs) + concept ontology |
| `packages/ai-core` | ~2,300 lines | Providers, memory, RAG, research, brain, context, prompts, tools, agent SDK |
| `packages/market-data` | ~15 files | Dhan feed + binary parser + scrip master, OU simulator, token bucket, quote cache |
| `packages/database` | 21 models, 5 migrations | Zero drift against the live DB |
| `packages/ui` | 16 files | Tokens, Tailwind preset, motion module, primitives |
| `infra/docker` | working | compose (dev + prod), Caddy, backup script |

### README-only stubs — zero source ⚪

`apps/admin`, `apps/mobile`, `apps/terminal` (static HTML), `services/auth`, `services/trading-engine`, `services/notification`, `services/analytics`, `services/tradew-ai`, `packages/sdk`, `packages/shared`, `agents/tradew-ai`, `infra/k8s`, `infra/terraform`, `infra/oci`, `workflows/`, `scripts/`.

`agents/sentinel/` is partial: it holds `definitions.json` (configuration), not source.

### The structural fact that matters most

> Several folders that `ARCHITECTURE.md` describes as future independent microservices have their actual logic living inside `services/api` or `packages/ai-core`.
>
> **The current system is: a modular monolith (`services/api`) + one separate service (`services/sentinel`) + one ingestion runtime (`services/market-data`) + shared libraries.** It is *not* the multi-service diagram the folder names alone suggest.

This is intentional (principle 1.4.2), it is documented, and you should not be surprised by it — but you also should not write code that assumes a network boundary where there is currently a function call, or vice versa. Chapter 5 §5.7 gives the rule for which is which.

### Known gaps, stated plainly

These are the honest weak points of the engineering practice as of this edition. They are not hidden in an appendix.

1. **No test suite.** There is no meaningful automated test coverage anywhere in the repository. Chapter 21 specifies the strategy; almost none of it is implemented. This is the single largest engineering risk in the platform.
2. **No ESLint configuration exists anywhere in the repo.** Confirmed during Market Data Migration 1. Chapter 23 defines the standards; they are currently enforced by review, not by tooling.
3. **Latency targets are targets, not measurements.** No profiling harness, no performance budget enforcement in CI, no RUM. Chapter 20 §20.9.
4. **Never deployed.** The OCI Free Tier deployment is fully designed — Dockerfiles, production compose, Caddy/SSL, backups, CI/CD — and has never been provisioned.
5. **Two divergent simulated market engines** (`services/api`'s legacy path and `services/sentinel`'s `SimMarketDataProvider`) must be reconciled before the `Candle` migration. Partially addressed by the collapse into `packages/market-data`; not finished.
6. **`packages/database/prisma/seed.ts`** throws `bcrypt.hash is not a function` in `seedDemoAccount()` — a `ts-node` ESM/CJS interop bug, pre-existing and unfixed.

A handbook that omitted this list would be a recruiting brochure. Chapter 21 and Chapter 20 exist primarily to close items 1 and 3.

---

## 1.9 The four rules you cannot break

If you retain nothing else from this chapter:

> **ARCH-1 — One public ingress.** `apps/*` talk only to `services/api`. Never directly to `sentinel`, `market-data`, `trading-engine`, or any AI runtime.
>
> **ARCH-2 — No AI-initiated trades.** No AI service reaches the order path. There is no tool for it, no endpoint for it, and no arrow for it in the dependency graph.
>
> **ARCH-3 — Sentinel never gates.** It observes in parallel with the order flow. It cannot block, delay, or add a step.
>
> **ARCH-4 — Observation, never advice.** No Buy/Sell/Entry/Target language anywhere: not in an agent, a prompt, a card, a notification, an email, or an export.

These four are referenced by identifier throughout the handbook and are legitimate, sufficient grounds to reject a pull request with no further discussion.

---

*Next: [Chapter 2 — Company Principles](02-company-principles.md)*
