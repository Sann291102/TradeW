# TradeW Engineering Handbook

```
████████╗██████╗  █████╗ ██████╗ ███████╗██╗    ██╗
╚══██╔══╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██║    ██║
   ██║   ██████╔╝███████║██║  ██║█████╗  ██║ █╗ ██║
   ██║   ██╔══██╗██╔══██║██║  ██║██╔══╝  ██║███╗██║
   ██║   ██║  ██║██║  ██║██████╔╝███████╗╚███╔███╔╝
   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚══════╝ ╚══╝╚══╝

         E N G I N E E R I N G   H A N D B O O K
              Volume 1 — The Platform
```

**TradeW LLC — Internal Engineering Handbook**
**Volume 1: The Platform**

| Field | Value |
|---|---|
| Document ID | `TW-HB-001` |
| Version | 1.0 |
| Status | **Binding** for all engineering work on the TradeW monorepo |
| Effective date | 2026-07-23 |
| Owner | Office of the CTO |
| Classification | **Confidential — Internal Use Only** |
| Supersedes | Nothing. This is the first consolidated edition. |
| Subordinate to | `docs/product-architecture/TRADEW-OS.md` (the Platform Constitution) |
| Review cadence | Every minor release; mandatory review at each Genesis phase boundary |

---

## Confidential Notice

This document contains proprietary architecture, algorithms, business logic, threat models, and commercial strategy belonging to TradeW LLC. It is distributed to employees, contractors, and authorised agents under a confidentiality obligation.

**You may not:**

- share this document, or any excerpt of it, outside TradeW LLC
- upload it to any third-party service that retains, trains on, or indexes content, except services explicitly approved in Chapter 19 (Security)
- reproduce its diagrams or decision records in external presentations, blog posts, conference talks, or job applications

**You may:**

- read it, annotate your own copy, and quote it in internal design documents, RFCs, code review comments, and commit messages
- propose changes through the RFC process in Chapter 25

Sections marked **⚖️ Compliance-critical** describe controls that exist to satisfy Indian securities regulation (SEBI) and data-protection law (DPDP Act 2023). Changing behaviour described in those sections requires sign-off from the compliance owner, not just an engineering approver. Sections marked **🔒 Security-critical** require a security review.

---

## Revision History

| Version | Date | Author | Summary |
|---|---|---|---|
| 0.1 (draft) | 2026-07-14 | Consolidation working group | `CONSOLIDATION-PLAN.md` — audit of the four inherited codebases; what to keep, what to archive. Not a handbook, but the origin of this one. |
| 0.2 (draft) | 2026-07-16 | Architecture | `ARCHITECTURE.md` — the binding service-boundary document. Established the "one public ingress" and "no AI-initiated trades" rules that this handbook inherits verbatim. |
| 0.3 (draft) | 2026-07-17 | Product Architecture | Genesis v2 blueprint: 21 product-architecture documents including `TRADEW-OS.md`, promoted to constitution. |
| 0.4 (draft) | 2026-07-21 | Architecture + Product | Full platform and product audit. Ground-truth code pass reconciled against the doc set; Sentinel's brief decoupling reversed. |
| 0.5 (draft) | 2026-07-23 | Engineering | `TRADEW_DEVELOPER_REFERENCE.md` and `PROJECT_TEST_AUDIT.md` — repository reverse-engineering and QA audit. |
| **1.0** | **2026-07-23** | **Office of the CTO** | **First consolidated Engineering Handbook.** Merges the constitution, the architecture document, all 21 product-architecture blueprints, the engineering knowledge vault, the developer reference, and the QA audit into one onboarding-complete text. Adds the PRD, engineering standards, process definitions, and the five-year vision, none of which previously existed in written form. |

### Amendment procedure

This handbook is version-controlled in the monorepo at `docs/handbook/`. It changes the same way code changes:

1. Open an RFC (Chapter 25, §25.3) describing the amendment and its blast radius.
2. If the amendment contradicts `TRADEW-OS.md`, **stop**. The constitution is amended first, on its own, with its own review — never as a side effect of a handbook edit. A change that requires amending the constitution to stop being a violation is a signal to re-check the change, not the constitution.
3. Land the amendment as a targeted edit (`CLAUDE.md` Rule 1 — never a whole-file rewrite).
4. Add a row to the table above. Never delete a row; superseded guidance is struck through and annotated, not removed.

---

## Acknowledgements

TradeW is not a greenfield product. This handbook exists because several bodies of prior work were audited, argued over, and either kept or deliberately archived:

- **`tradew-prototype`** (three divergent copies) — contributed the NestJS backend skeleton, the auth module with refresh-token rotation and audit logging, and the first Prisma schema. Its watchlist page survives, ported, in `apps/web`.
- **`extreme_algo_package`** — the real Dhan options bot: HMAC-verified TradingView webhook ingestion, `order_poller.py`'s polling-based fill reconciliation, and `mock_dhanhq.py` as a paper broker. It is the designated source for `services/trading-engine` and remains, deliberately, un-migrated pending explicit approval (Chapter 5, §5.9).
- **The Emergent AI interface mockups** (14 screenshots) — treated as *the design system*, not as inspiration. `packages/ui` implements what those mockups describe, not a reinterpretation of them. Chapter 24 is essentially their formalisation.
- **The NVIDIA AI model-distillation blueprint for financial data** — the source of the thirteen-category news-event taxonomy now modelled by `NewsEvent` and `packages/ai-core/src/news/news-event-classifier.ts`.
- **The engineering knowledge vault** (`knowledge/`, an Obsidian vault, `CLAUDE.md` Rule 4) — every "we tried this and it cost us a day" note in this handbook's Gotchas boxes came from there. It stays the living memory; this handbook is the stable summary.
- **`n8n`** — vendored out-of-tree, used as an orchestration engine, never imported as source.

Special note on the **archive-never-delete** discipline (`CLAUDE.md` Rule 1). Every superseded implementation described in this handbook still exists under `archive/`. This is unusual and it is intentional: in a trading system, "why did we stop doing it the old way?" is a question that gets asked at 3 a.m. during an incident, and a `git log` archaeology session is a bad answer.

---

## How to read this book

This handbook is long. It is not meant to be read front-to-back on day one, and reading it that way is a poor use of a new engineer's first week.

### Reading paths

**New engineer, week 1 — "what is this thing?"**
Chapters 1 → 2 → 4 → 5. Then set up your machine with Appendix C and get `docker compose up` green. Do not read the Sentinel chapters yet.

**New engineer, week 2 — "what am I working on?"**
Whichever of Chapters 11 (paper trading), 12 (market data), 13 (charts), 15 (frontend), 16 (backend) covers your first ticket. Then Chapter 23 (coding standards) before your first pull request.

**Working on Sentinel or any AI surface.**
Chapters 6 → 7 → 8 → 9 → 10, then Chapter 18 (AI architecture). Chapter 6 §6.4 (the never-does contract) is not optional and is not negotiable.

**Working on anything a user pays for.**
Chapter 3 (PRD) §3.11 and Chapter 4 §4.17 (subscriptions and entitlements). Entitlement gates *reasoning*, never *visibility* — get this wrong and you ship a product bug, not a billing bug.

**On call.**
Chapter 22 (DevOps), Chapter 25 §25.6 (incident response), Appendix E (runbooks).

**Reviewing someone else's design.**
Chapter 5 (architecture), Chapter 26 (decision records). Check the proposal against the dependency graph in §5.8 before anything else — most bad designs are bad because of an arrow that shouldn't exist.

### Status legend

TradeW is a young platform with a mature design. Much of what this handbook describes is specified and not yet built, and pretending otherwise would make the document useless. **Every subsystem section carries a status marker:**

| Marker | Meaning | What you can rely on |
|---|---|---|
| 🟢 **Shipped** | Real, substantive code exists and runs. | The described behaviour matches `main`. If it doesn't, that's a bug in one of the two — report it. |
| 🟡 **Partial** | Some of it is real; some is stub, mock, or hard-coded. | The chapter says exactly which half is which. Do not assume the rest. |
| 🔵 **Specified** | Designed, documented, reviewed, agreed — **zero code**. | The design is binding for whoever builds it. Building something different requires an RFC. |
| ⚪ **Roadmap** | Directionally agreed, not yet designed in detail. | Nothing is binding. Expect the design to change. |
| ⛔ **Reversed** | Was decided, then un-decided. Retained for the reasoning. | Do not implement. Read it to understand why. |

A chapter that describes a 🔵 system in the present tense ("the scanner evaluates predicates against the quote cache") is describing the *specification*, not observed behaviour. The status marker at the top of the section is the disambiguator. When in doubt, the code wins and the handbook has a bug.

### Conventions

- **File references** are repo-relative: `services/api/src/sim/order.service.ts`.
- **Rules** are numbered and stable: "ARCH-1" (one public ingress) means the same thing in every chapter and in code review comments.
- **Gotcha boxes** (> ⚠️) record something that has already cost the team time. They are not hypothetical.
- **Latency numbers** are targets unless labelled "measured". Very few things in this handbook are labelled "measured", and Chapter 20 §20.9 explains why that is the single largest gap in our engineering practice today.
- All monetary values are Indian Rupees (₹). All times are IST (UTC+05:30) unless marked otherwise — the market we serve opens at 09:15 IST and the codebase has an `ist-time.util.ts` for exactly this reason.

---

## Table of Contents — Volume 1

### Part I — Foundations
| Ch | Title | Pages |
|---|---|---|
| 1 | [Executive Summary](01-executive-summary.md) | Purpose, vision, mission, engineering philosophy, product philosophy, core principles, long-term roadmap |
| 2 | [Company Principles](02-company-principles.md) | The ten principles, each with its engineering consequence |
| 3 | [Product Requirements Document](03-product-requirements.md) | Problem, users, personas, goals, metrics, scope, requirements, stories, acceptance criteria, release plan |

### Part II — The Platform
| Ch | Title | Pages |
|---|---|---|
| 4 | [Platform Overview](04-platform-overview.md) | Every module, one by one, with status |
| 5 | [System Architecture](05-system-architecture.md) | Service boundaries, ingress, communication, dependency graph, extraction triggers |

### Part III — Sentinel
| Ch | Title | Pages |
|---|---|---|
| 6 | [Sentinel — Foundations](06-sentinel-foundations.md) | Purpose, goals, AI philosophy, design principles, the never-does contract |
| 7 | [Sentinel — Departments](07-sentinel-departments.md) | All intelligence departments, input→processing→output |
| 8 | [Sentinel — Analytical Engines](08-sentinel-engines.md) | Volatility, options analytics, flow, liquidity, structure, FVG, order blocks, volume profile, OI, PCR, IV, Greeks, rotation, correlation |
| 9 | [Sentinel — Runtime](09-sentinel-runtime.md) | Event architecture, orchestration, memory, reasoning, caching, streaming, failure handling, scaling, monitoring |
| 10 | [Safety Nets](10-safety-nets.md) | Behavioural protections and the coaching engine |

### Part IV — Core Domains
| Ch | Title | Pages |
|---|---|---|
| 11 | [Paper Trading Engine](11-paper-trading-engine.md) | Order lifecycle, matching, margin, P&L, recovery |
| 12 | [Market Data](12-market-data.md) | Live, historical, ticks, OHLC, options, corporate actions, error recovery |
| 13 | [Chart Engine](13-chart-engine.md) | Rendering, indicators, drawing tools, replay, layouts, performance |

### Part V — Engineering
| Ch | Title | Pages |
|---|---|---|
| 14 | [Monorepo](14-monorepo.md) | Structure, packages, apps, build, configuration |
| 15 | [Frontend Architecture](15-frontend-architecture.md) | React, Next.js, state, data fetching, accessibility, performance |
| 16 | [Backend Architecture](16-backend-architecture.md) | NestJS, API design, WebSockets, authn/authz, RBAC, rate limits, jobs, observability |
| 17 | [Database](17-database.md) | Schema, indexes, partitioning, migrations, Redis, retention, backup, recovery |
| 18 | [AI Architecture](18-ai-architecture.md) | LLMs, embeddings, prompts, agents, memory, reasoning, tools, guardrails, evaluation |
| 19 | [Security](19-security.md) | OWASP, encryption, JWT, secrets, audit, threat model, compliance, DR |
| 20 | [Performance Engineering](20-performance-engineering.md) | The 20 ms target, caching, budgets, profiling, benchmarking |
| 21 | [Testing](21-testing.md) | Unit, integration, E2E, load, stress, security, regression, chaos |
| 22 | [DevOps](22-devops.md) | CI/CD, Docker, Kubernetes, monitoring, tracing, flags, rollout strategies |
| 23 | [Coding Standards](23-coding-standards.md) | TypeScript, React, backend, naming, comments, review rules, git strategy |
| 24 | [Design System](24-design-system.md) | Tokens, typography, spacing, colour, icons, dark mode, responsive, components |
| 25 | [Engineering Processes](25-engineering-processes.md) | Sprints, architecture reviews, RFCs, bugs, incidents, postmortems, releases |

### Part VI — Reference
| Ch | Title | Pages |
|---|---|---|
| 26 | [Decision Records](26-decision-records.md) | Every architectural decision, why, and what was rejected |
| 27 | [Future Vision](27-future-vision.md) | The five-year roadmap |
| 28 | [Appendices](28-appendices.md) | Glossary, environment variables, API reference, schema reference, runbooks |

---

## One page, if you only read one page

TradeW is an **AI-powered trading operating system** for the Indian retail derivatives market. The product bet is that traders lose money primarily to *behaviour*, not to *information*, and that a platform which observes behaviour, explains market structure, and refuses to give instructions is more valuable — and more defensible — than one more signal service.

Four things follow from that bet, and they are the four things you must not break:

1. **Observation, never advice.** No surface, agent, prompt, or endpoint produces Buy/Sell/Entry/Target language. This is simultaneously our product identity, our SEBI compliance posture, and a hard architectural rule enforced at the `packages/ai-core` prompt layer and the `services/api` ingress.
2. **No order without a mandate.** *(Changed 2026-09-01 — ADR-046 superseded ADR-002 when the company's SEBI registration removed the premise behind it.)* `services/tradew-ai` still cannot reach the order path at all: a conversational runtime with an order tool is a different and much worse thing, and nothing authorises it. An **execution agent** may place orders, but only through an `ExecutionProfile` — a written, bounded, revocable grant naming the symbol, the strategy roster, the size, the daily order and loss caps, the square-off time and the account, armed by two separate acts and, on a real person's account, that person's own recorded consent. An order outside a mandate is still a rejected change, not a design discussion.
3. **Sentinel never blocks the order flow.** It comments in parallel. A user who ignores every Sentinel card must still be able to place an order in the same number of milliseconds as a user who has never seen one.
4. **One workspace, many surfaces.** Bloomberg Terminal, not a website with tabs. A user moving from Dashboard to Sentinel to Learning has not left the platform, and no pillar re-implements auth, entitlements, market data, or design tokens for itself.

Everything else in these 28 chapters is engineering detail in service of those four sentences.

---

*Next: [Chapter 1 — Executive Summary](01-executive-summary.md)*
