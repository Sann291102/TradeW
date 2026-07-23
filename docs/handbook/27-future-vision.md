# Chapter 27 — Future Vision

**A five-year engineering roadmap.** Product view in Chapter 3 §3.12.

Everything here is ⚪ **roadmap** unless marked otherwise: directionally agreed, not designed in detail, and nothing is binding. Expect it to change — and expect the reasons it changes to be more informative than the plan itself.

---

## 27.0 The two things that never change

Before any roadmap, the constraints that survive every horizon:

```
   ❌ AUTOMATED EXECUTION OF AI-GENERATED SIGNALS
   ❌ DISCRETIONARY INVESTMENT ADVICE
```

Absent in Year 5 for the same reason they are absent in Year 1 (ADR-002, ADR-004). Every item below is designed so that neither becomes possible as a side effect.

A third, softer constraint: **we do not custody client funds.** Real-money order flow, when it exists, routes to a licensed broker under the user's own credentials.

---

## 27.1 The shape of the next five years

```
  Y1  FINISH GENESIS              close the gap between design and reality
      ─────────────────           11 phases · measured NFRs · first paying cohort

  Y2  REAL MONEY, CAREFULLY       the highest-consequence year
      ────────────────────        trading-engine migration · live routing ·
                                  ⚖️ SEBI audit surface

  Y3  AUTONOMY IN RESEARCH        never in execution
      ──────────────────          overnight agents · multi-broker · mobile

  Y4  SCALE AND PLATFORM          earned, not anticipated
      ──────────────────          Kafka IF a real need appears · ClickHouse ·
                                  public SDK

  Y5  ENTERPRISE                  the model already exists in the schema
      ──────────                  org entitlements · white-label · compliance desk
```

---

## 27.2 Year 1 — Finish Genesis

**Theme: close the gap between what is designed and what runs.**

The platform's defining characteristic today is that roughly 40% of it is specified-not-built. Year 1 is about that ratio, not about new ideas.

### 27.2.1 The engineering prerequisites

Before any Genesis phase ships to a real user, roughly **one engineer-week** of gaps must close:

```
   🔒 SEC-0   Neon credential rotation confirmed
   🔒 SEC-3   RBAC — admin endpoints are currently open to any authenticated user
   🔒 SEC-4   rate limiting — /auth/login accepts unlimited attempts
   🔒 SEC-6   dependency scanning (20 minutes, closes the largest unknown)
   🔒 SEC-7   security headers in the Caddyfile
   ⚖️ SEC-8   incident-response plan (DPDP requires one)
   ⚙️ OPS-1   matching-engine leader lock
   ⚙️ OPS-7   backup restore DRILLED and timed
```

### 27.2.2 The three foundational investments

| # | Investment | Why it is first | Effort |
|---|---|---|---|
| **1** | **Test suite** (Chapter 21) | The system computes money-shaped numbers whose worst failure is *plausible wrong output*. There is no compensating control. | 4 weeks |
| **2** | **Measurement** (Chapter 20 §20.9) | Every performance number is currently a target. Without measurement, optimisation is guesswork. | 2 weeks |
| **3** | **Staging + deployment** (Chapter 22) | The platform has never been deployed. Every infrastructure decision is an untested hypothesis. | 1 week |

**These three come before feature work**, and the order matters: tests make change safe, measurement makes change directed, deployment makes change real.

### 27.2.3 Genesis completion

| Phase | Work | From → To |
|---|---|---|
| 2 | Onboarding flow (entitlements already live) | 🟡 → 🟢 |
| 3 | Assistant navigation + voice | 🔵 → 🟢 |
| 4 | Learning Hub v1 | 🔵 → 🟢 |
| 5 | Research Vault + KG read surface | 🟡 → 🟢 |
| 6 | Continuous Learning Pipeline — **the ≥2-signal validation gate** | 🔵 → 🟢 |
| 7 | Learning Hub v2 (content from validated KG) | ⚪ → 🔵 |
| 8 | Sentinel tiers + auto-invoke + explainability | 🟡 → 🟢 |
| 9 | TradingView workspace (blocked on **OD-4**) | 🔵 → 🟢 |
| 10 | Server-side workspace continuity | 🔵 → 🟢 |
| 11 | n8n ops build-out | 🔵 → 🟢 |

### 27.2.4 Market data completion

Blocked on **OD-A** (the Dhan licensing question), which is a legal answer, not a technical one.

```
   Phase 3  historical backfill → Candle        Migration 2
   Phase 4  live WS feed        transport wiring (parser + lifecycle done)
   Phase 5  option chain → OptionMetrics        Migration 3
   Phase 6  push to frontend    SSE fan-out
            + CorporateAction   Migration 4
```

`Candle` unblocks: chart replay, the scanner, screeners, volume profile, and Sentinel running against persisted history instead of an ephemeral simulator.

### 27.2.5 Sentinel completion

```
   □ the remaining 7 of 14 trap signals
   □ Options Intelligence as a real department (needs OptionMetrics)
   □ Portfolio Intelligence — ⭐ hidden_correlation is the highest-value
     unbuilt signal in the platform
   □ push observations (SSE) — the ambient promise is not kept by polling
   □ LLM streaming
   □ a real scheduler for EOD summaries and promotion review
   □ ⚖️ the evaluation suite (AI-1) — prompt changes currently ship on judgement
```

### 27.2.6 Year 1 exit criteria

```
   ✅ deployed, with users
   ✅ ≥70% test coverage; ⚖️ compliance suite gating CI at 100%
   ✅ every NFR-P target MEASURED, not asserted
   ✅ all 11 Genesis phases 🟢
   ✅ a first paying Sentinel cohort
   ⭐ the behavioural thesis MEASURED (Chapter 10 §10.16) —
      including the possibility that it is falsified
```

That last line is the one that matters. A behavioural product that never defines what would falsify it is not a product, it is a belief.

---

## 27.3 Year 2 — Real money, carefully

**Theme: the highest-consequence year in the roadmap.**

Everything before this is reversible. Real order routing is not: a bug loses someone's money.

### 27.3.1 The `trading-engine` migration (OD-5)

```
   PRE-MIGRATION
     □ ⚖️ SEBI posture review — what changes when orders are real?
     □ 🔒 security review of the entire order path
     □ OD-C: static IP reserved and whitelisted with Dhan
     □ explicit written execution approval (ADR-045)

   MIGRATION, sequenced
     1. move the code into services/trading-engine, behaviour unchanged
     2. SQLite → shared Postgres, with explicit table ownership (OD-1)
     3. REST API → internal-only, service-token authenticated
     4. wire into services/api aggregation
     5. re-validate the HMAC webhook path end to end
     6. ⭐ KEEP order_poller.py exactly as it is (ADR-045)

   POST-MIGRATION
     □ paper and live are visibly, unmistakably distinct in the UI
     □ ⚖️ every real order carries a full audit trail
     □ a kill switch that stops live routing without a deploy
```

> ⭐ **`order_poller.py` stays.** Polling-based fill reconciliation is how you find out about a fill whose webhook never arrived. It is a safety net, not a stopgap, and the temptation to "modernise it to webhooks" during the migration must be resisted.

### 27.3.2 The paper/live boundary

The single most important UX problem of Year 2.

```
   ⚠️ A user must NEVER be uncertain which mode they are in.

   □ persistent, unmissable mode indicator (the top bar toggle exists)
   □ visually distinct colour treatment for live mode
   □ explicit confirmation on every mode switch
   □ ⚠️ NO shared order tickets between modes — a mis-click must not
     be able to route a paper-intent order to a real broker
   □ separate P&L, separate history, separate everything
```

### 27.3.3 What must NOT change

```
   ❌ Sentinel still never gates, blocks, or delays — ARCH-3 holds
      for real orders exactly as for paper
   ❌ no AI service reaches the real order path — ARCH-2
   ❌ observation, never advice — ARCH-4 becomes MORE important,
      not less, when real money is involved
```

⚖️ The compliance stakes rise sharply. Every control in Chapter 19 §19.8 that is currently prudent becomes mandatory.

### 27.3.4 Also in Year 2

| Item | Trigger |
|---|---|
| `services/auth` extraction | ~50k concurrent sessions (ADR-007) |
| ⚖️ SEBI-aligned audit surface | real orders |
| Scanner + screener | `Candle` + a fundamentals source (OD-7) |
| Options strategy builder with payoff visualiser | ⚠️ ADR-004 — describe, never recommend |
| Advanced portfolio analytics | `services/analytics` |
| DPDP erasure + export flows | ⚖️ legally required |

⭐ **The analytics payoff:** joining `SentinelObservation` against subsequent `Trade` outcomes answers *"does this user's revenge trading actually lose them money, and how much?"* No competitor can produce that number, because no competitor logs behavioural observations with evidence and timestamps.

---

## 27.4 Year 3 — Autonomy in research, never in execution

**Theme: the AI does more work, with the same boundary.**

### 27.4.1 Autonomous research agents

```
   OVERNIGHT, 16:00–08:00 IST

   Research Planner    what does the Brain not know that it should?
        ▼
   Research Workers    parallel, rate-limited, budget-capped
        ▼
   Validation Engine   ⭐ ≥2 independent signals must corroborate
        ▼
   Research Vault (raw) ──gate──► Knowledge Graph (validated)
        ▼
   Morning briefing    what was learned, what changed, what contradicts
                       something previously believed
```

**The rules that keep this safe:**

```
   □ Research produces KNOWLEDGE, never signals
   □ Everything lands in the Research Vault first; the validation
     gate is one-way (TRADEW-OS §4)
   □ ⭐ Sentinel proposes; only humans promote to canonical (ADR-016)
   □ Hard token and cost budget per night, enforced, not advisory
   □ ⚖️ Every autonomous run is fully audited
   □ ❌ No agent may produce a trade recommendation, ever
```

⭐ **"What contradicts something previously believed" is the most valuable output.** A knowledge system that only accumulates becomes confidently wrong; one that surfaces its own contradictions stays honest. The `contradicts` relation exists in the ontology for exactly this.

### 27.4.2 Multi-broker abstraction

Trigger: a second broker relationship, **not** an abstraction built in anticipation.

```
   BrokerProvider          the interface
     ├── DhanProvider      the only implementation for two years
     └── <second>          the first real test of the abstraction
```

The market-data provider abstraction (ADR-013) is the template: it earned its shape by having two real implementations (Dhan and the simulator) from the start. A broker abstraction with one implementation is a guess about what the second one will need.

### 27.4.3 Mobile (OD-2)

Not a port. A different product for a different moment.

```
   MOBILE IS FOR                    MOBILE IS NOT FOR
   ────────────                     ─────────────────
   checking positions               a full trading terminal
   receiving observations           the dockable workspace
   the journal                      multi-chart analysis
   Learning Hub                     the option chain
   quick order entry                the command palette
```

React Native consuming `packages/types` + `packages/sdk`. ⚠️ `packages/ui` is source-only and Metro cannot consume it as-is (ADR-028) — either a build step or a parallel token package is needed, and that is a real decision, not a detail.

---

## 27.5 Year 4 — Scale and platform

**Theme: earned, not anticipated. Every item has a trigger.**

### 27.5.1 The trigger table

| Change | Trigger | Not a trigger |
|---|---|---|
| Redis Streams → **Kafka** | a durability, replay, or consumer-group need Redis **genuinely cannot meet** | scale anxiety |
| Postgres → **ClickHouse** (analytics) | aggregate queries p95 > 2 s | row count |
| Single Postgres → **read replicas** | read p95 > 200 ms **attributable to contention** | "we should have replicas" |
| Single VM → **Kubernetes** | load a single VM demonstrably cannot serve | "real companies run Kubernetes" |
| `packages/ai-core` → **`services/tradew-ai`** | AI workload needs independent scaling or a different runtime | folder tidiness |
| Add **PgBouncer** | 4+ API replicas | — |

> ⭐ **Every row's "not a trigger" column is the more useful one.** Each names the argument that will actually be made in the room.

### 27.5.2 The public developer API

`packages/sdk`, generated from `services/api`'s OpenAPI spec.

```
   PREREQUISITES
     □ OpenAPI spec emitted (API-1) — currently missing
     □ API versioning introduced (deliberately absent today, ADR: one
       consumer deployed in lockstep means versioning buys nothing)
     □ per-key rate limiting and quotas
     □ developer documentation and a sandbox
     □ ⚖️ ToS clarifying that TradeW provides DATA and OBSERVATIONS,
       never signals — and that redistribution is bounded by OD-A
```

⚠️ **The API cannot expose anything the product does not.** No endpoint returns a recommendation, because none exists to return.

### 27.5.3 Where the architecture must change to reach 250k users

Honestly assessed:

| Component | Current ceiling | Change needed |
|---|---|---|
| `services/api` | horizontal — fine | more replicas + PgBouncer |
| `services/sentinel` | horizontal, stateless — fine | ⚠️ **a real scheduler** (the piggyback pattern is single-instance-friendly but not time-bound) |
| `services/market-data` | ⭐ **singleton, permanently** | fan-out, then partition by account. **Never replication** (ADR-021) |
| Postgres | vertical + replicas | partition `SentinelObservation`, `AuditEvent`, `Candle` |
| Matching engine | 3 s poll | leader lock (OPS-1); revisit interval at ~50k resting orders |
| Vector search | ⚠️ **unindexed today** | HNSW (DB-1) — this is the first thing to fail |

---

## 27.6 Year 5 — Enterprise

**Theme: the model already exists in the schema.**

`Subscription.organizationId` is present and unused. It was added in the entitlements design (2026-07-16) against exactly this horizon — an example of paying a free design cost early.

### 27.6.1 Organisations and teams

```
   Organization
     ├── members (roles: owner · admin · analyst · member)
     ├── org-level subscription and entitlements
     ├── ⚖️ shared knowledge namespace (MemoryRecord.namespace exists)
     ├── org-level audit and compliance reporting
     └── SSO / SAML
```

`MemoryRecord.namespace` and `userId`-nullable already model shared-versus-personal knowledge. The org boundary is a third scope on an existing axis, not a new system.

### 27.6.2 White-label

A broker or advisory firm running TradeW under their own brand.

```
   ⚙️ REQUIRES
     □ per-tenant theming (the token architecture already supports it —
       three themes prove the mechanism)
     □ tenant isolation at the data layer
     □ per-tenant broker credentials (OD-A becomes per-tenant)
     □ per-tenant ⚖️ compliance configuration
```

⚠️ **The compliance surface multiplies.** Each tenant may operate under a different regulatory posture, and ARCH-4 must hold for all of them simultaneously. A white-label tenant asking for "just a small buy/sell indicator" is the year-5 version of the pressure ARCH-4 exists to resist.

### 27.6.3 The compliance-desk product

The most defensible enterprise idea available to us, and it falls out of the architecture rather than being bolted on:

> ⚖️ A supervisory surface for a broker or advisory firm: behavioural observation across a client book, with full evidence trails, SEBI-relevant categorisation, and per-observation audit.

Everything it needs already exists: `SentinelObservation` with evidence and categories, the append-only audit trail, the explainability contract, and the composite gate that keeps output signal-dense rather than noisy.

⚠️ **And the boundary holds even here.** The compliance desk *observes* a book. It does not instruct anyone to do anything about it.

---

## 27.7 Technology bets

### 27.7.1 What we are betting on

| Bet | Confidence | Reasoning |
|---|---|---|
| **PostgreSQL for everything, including vectors** | high | ADR-012. One operational surface. Ceiling far beyond our horizon. |
| **Provider-agnostic AI** | high | ADR-013. Already paid for itself: distillation becomes a config change. |
| **Deterministic core, LLM as stylist** | **very high** | ADR-010. Compliance guaranteed by code; works with no key; reproducible. |
| **Modular monolith with written triggers** | high | ADR-006. Reversible in the direction that matters. |
| **TypeScript everywhere** | high | one language, shared types, one hiring profile |
| **Own the render path (charts)** | medium | ADR-030. Cost: drawing tools and replay must be built. |

### 27.7.2 What we are explicitly not betting on

| Not betting on | Why |
|---|---|
| A single LLM vendor | the abstraction exists precisely so we do not have to |
| Frontier-model-only inference | distillation is planned for the high-volume, low-complexity path |
| Kubernetes as a default | a trigger, not a destination |
| Microservices as a virtue | boundaries are a design property, not a deployment topology |
| An external vector database | ADR-012 |
| Real-time everything | the option chain is rate-limit-bound to ~12 s; pretending otherwise is a lie in the interface |

### 27.7.3 What could invalidate the strategy

Written down deliberately, because a roadmap without failure modes is a wish list:

| Risk | Impact | Mitigation |
|---|---|---|
| ⚠️ **OD-A resolves badly** — Dhan cannot license data redistribution | severe: every user must link their own broker account | the ingestor is per-credential-set either way; the answer changes config, not architecture |
| ⚖️ **SEBI reclassifies behavioural observation as advice** | existential | the entire compliance posture is documented and auditable; the observation/advice line is defended in code, not policy |
| ⭐ **The behavioural thesis is falsified** (Chapter 10 §10.16) | severe | measure it in Year 1; a defined falsification criterion exists, including "cohort A performs worse" |
| **LLM costs rise sharply** | moderate | the composite gate means <15% of calls reach a model; distillation path ready |
| **A competitor ships the same thesis with more capital** | moderate | the moat is the evidence trail and the accumulated behavioural dataset, not the idea |

---

## 27.8 The engineering culture to preserve

The roadmap is less important than the practices that produced this codebase. Five worth protecting explicitly:

```
   1. ⭐ COMMENT THE WHY
      The single most distinctive quality of this codebase. Every comment
      that prevents a future engineer from "fixing" something deliberate
      is worth more than the code it sits above.

   2. ⭐ DEGRADE, NEVER FAIL
      Every enrichment individually wrapped. Sentinel down ≠ platform down.
      Grep for "non-fatal" — it is written into the code at every seam.

   3. ⭐ ARCHIVE, NEVER DELETE
      Applied to code, schema, AND decisions. A reversed decision retained
      with its reasoning is worth more than a deleted one.

   4. ⭐ DOCUMENT-DRIVEN ARCHITECTURE
      Decide in documents before code. It has already caught one
      significant product misdirection before any code shipped.

   5. ⭐ THE CONSTITUTIONAL CHECK
      "A change that requires amending the constitution to stop being a
      violation is a signal to re-check the change."
      The most useful heuristic this project has produced.
```

### 27.8.1 What to fix about the culture

Equally honest:

```
   ❌ TESTING IS NOT PART OF THE DEFINITION OF DONE — it must become so
   ❌ MEASUREMENT IS NOT PART OF THE PRACTICE — every latency number
      is currently a target
   ❌ STANDARDS ARE ENFORCED BY HUMANS — no linter, so consistency
      depends on reviewer attention
   ❌ OPERATIONAL PROCESS IS ABSENT — no incidents, postmortems, or
      release checklist, because nothing has been deployed
```

The architectural discipline is genuinely strong. The **operational** discipline does not exist yet, and Year 1 is where that is either fixed or becomes the reason the first deployment goes badly.

---

## 27.9 The one-page summary

```
   Y1  FINISH GENESIS
       tests → measurement → deployment → 11 phases → measured NFRs
       → first paying cohort → ⭐ the thesis measured, honestly

   Y2  REAL MONEY, CAREFULLY
       trading-engine migration → live routing under user credentials
       → ⚖️ SEBI audit surface → an unmistakable paper/live boundary
       → ARCH-2/3/4 hold EXACTLY as before

   Y3  AUTONOMY IN RESEARCH, NEVER IN EXECUTION
       overnight research agents → validation gate → multi-broker
       → mobile

   Y4  SCALE AND PLATFORM
       every change has a written trigger → public SDK → ClickHouse
       → Kafka IF AND ONLY IF a real need appears

   Y5  ENTERPRISE
       org entitlements (already in the schema) → white-label
       → ⚖️ the compliance-desk product

   ─────────────────────────────────────────────────────────────
   AT EVERY HORIZON, UNCHANGED:

     ARCH-1  one public ingress
     ARCH-2  no AI-initiated trades
     ARCH-3  Sentinel never gates
     ARCH-4  observation, never advice
   ─────────────────────────────────────────────────────────────
```

---

*Next: [Chapter 28 — Appendices](28-appendices.md)*
