# Chapter 5 — System Architecture

> **Source of truth:** `ARCHITECTURE.md` (service boundaries) subordinate to `docs/product-architecture/TRADEW-OS.md` (the constitution). This chapter explains and extends both; where it disagrees with them, they win.

---

## 5.1 The four rules, restated as architecture

Every structural decision in this chapter derives from four rules. They are not guidelines.

| ID | Rule | Enforced by |
|---|---|---|
| **ARCH-1** | **One public ingress.** `apps/*` reach the backend only through `services/api`. | `ServiceTokenGuard` on every internal service; network topology; code review |
| **ARCH-2** | **No AI-initiated trades.** No AI service calls the order path — not gated, not with an override. | Absence of the tool; absence of the client; absence of the arrow in §5.8 |
| **ARCH-3** | **Sentinel never gates.** It observes in parallel with the order flow. | Sentinel is never awaited on an order path; `/observe` is a separate endpoint |
| **ARCH-4** | **Observation, never advice.** | `CORE_GUARDRAILS` in every prompt; deterministic fallback composition; copy review |

Two supporting rules from `ARCHITECTURE.md` §1 that come up almost as often:

| ID | Rule |
|---|---|
| **ARCH-5** | **One schema owner per table.** Two runtimes may share a Postgres instance; never one ORM over one table from two places. |
| **ARCH-6** | **Every service ships its own `.env.example`.** No shared "god" env. Config validated at boot, fail-fast. |

---

## 5.2 Physical topology

### 5.2.1 What actually runs today

```
                         ┌───────────────┐
                         │    Browser    │
                         └───────┬───────┘
                                 │ HTTPS
                         ┌───────▼───────┐
                         │     Caddy     │  TLS termination, auto-cert
                         │  (reverse     │  infra/docker/Caddyfile
                         │   proxy)      │
                         └───┬───────┬───┘
                    /        │       │  /api/*
              ┌─────────────▼─┐   ┌─▼────────────────────┐
              │  apps/web     │   │  services/api        │  :4000
              │  Next.js 14   │   │  NestJS              │
              │  :3000        │   │  THE ONLY INGRESS    │
              └───────────────┘   └──┬────────┬─────┬────┘
                                     │        │     │
                    x-service-token  │        │     │ Prisma
                        ┌────────────▼──┐  ┌──▼─────▼──────────┐
                        │ services/     │  │  Postgres 16      │
                        │ sentinel      │  │  + pgvector       │
                        │ :4100         │  │  :5432            │
                        └───────┬───────┘  └───────────────────┘
                                │ Prisma (own client, own tables)
                                │
              ┌─────────────────▼──────────────────┐
              │  services/market-data   :4500      │  SINGLETON
              │  + live-feed bridge     :4600      │  (per-account
              │  Dhan WS │ OU simulator            │   feed resource)
              └────────────────────────────────────┘
```

**Five processes. Not fifteen.** The folder count in `services/` suggests a microservice fleet; the process count is a modular monolith plus two specialised runtimes. This is deliberate (Principle 7) and §5.7 gives the triggers that change it.

### 5.2.2 The port map

| Service | Port | Public? | Auth |
|---|---|---|---|
| `apps/web` | 3000 | ✅ via Caddy | — |
| `services/api` | 4000 | ✅ via Caddy `/api/*` | user JWT |
| `services/sentinel` | 4100 | ❌ private network only | `x-service-token` |
| `services/market-data` | 4500 | ❌ | internal |
| live-feed bridge | 4600 | ❌ | internal |
| Postgres | 5432 | ❌ | credentials |

Anything with ❌ in the "Public?" column being reachable from the internet is a **security incident**, not a configuration preference.

---

## 5.3 Why exactly one ingress

`services/api` is a Backend-for-Frontend, and centralising it buys five things that are individually cheap and collectively decisive:

1. **One auth surface.** JWT verification lives in one guard. There is no second place to get token validation subtly wrong.
2. **One entitlement surface.** `CapabilityGuard`, and `EntitlementsService` as the only place premium access is decided.
3. **One rate-limit surface.** Per-user and per-IP limits apply once. 🔵
4. **One audit surface.** ⚖️ Every user action passes one place that can write `AuditEvent`. A regulator's question — "show me everything this user did on this date" — has one answer, not five.
5. **One aggregation point.** `apps/web` gets one response shape for a screen that needs portfolio + positions + quotes, not three round trips it has to join in the browser.

### 5.3.1 What the rule costs

Honesty: an extra hop. A Sentinel observation is `browser → api → sentinel → api → browser` rather than `browser → sentinel`. On a local network that is single-digit milliseconds, and Sentinel is off the critical path (ARCH-3), so nobody notices.

The rule would genuinely hurt on a sub-150 ms path, which is why there is one documented exception, described next.

### 5.3.2 The one documented exception

**TradingView strategy webhooks go directly to `services/trading-engine`**, not through `services/api`.

Reasons, from `ARCHITECTURE.md` §3:
- The path is already hardened (HMAC-SHA256 with timing-safe comparison)
- It is latency-sensitive in a way user-facing reads are not
- Routing through `services/api` would add a redundant hop **and a second signature-verification surface** — more attack surface, not less

This is a good example of what a legitimate exception looks like: written down, reasoned, bounded, and it makes the system *more* secure rather than less. An exception that does neither of those things is just a violation.

---

## 5.4 Service inventory

| Service | Runtime | Status | Owns | Reached by |
|---|---|---|---|---|
| `services/api` | NestJS 10 | 🟢 90 files | users, auth, entitlements, instruments, quotes (read), paper OMS, journal | browser |
| `services/sentinel` | NestJS 10 | 🟢 75 files | observations, Brain, concept graph | `api` only |
| `services/market-data` | NestJS 10 | 🟡 | `Quote` writes, feed connection, hot cache | `api` (read), internal |
| `services/auth` | — | 🔵 folder | contract boundary for extraction | — |
| `services/trading-engine` | Python/Flask | 🔵 un-migrated | real-money OMS, webhooks | `api` internal REST |
| `services/tradew-ai` | — | 🔵 folder | Research runtime | `api` only |
| `services/notification` | — | 🔵 folder | alert fan-out | `api`, n8n |
| `services/analytics` | — | 🔵 folder | portfolio analytics | `api` only |

### 5.4.1 `services/api` module map 🟢

```
services/api/src/
├── app.module.ts          composition root
├── main.ts                bootstrap: CORS, ValidationPipe, port
├── health.controller.ts   GET /health
├── prisma/                PrismaService (one client, module-scoped)
├── auth/                  guard · service · controller (8 endpoints)
├── entitlements/          service · CapabilityGuard · controller (7)
├── instruments/           search
├── market-data/           quote reads (4 endpoints)
├── knowledge/             vault viewer + KnowledgeGuard (6 endpoints)
├── sentinel/              proxy to services/sentinel (8 endpoints)
└── sim/                   the paper OMS — 7 files
    ├── sim.controller.ts       11 endpoints, class-validator DTOs
    ├── order.service.ts        428 lines — placement, fills, margin, wallet
    ├── position.service.ts     138 lines — position DTOs and P&L
    ├── portfolio.service.ts     56 lines — account rollup
    ├── matching-engine.service  123 lines — 3s poller for resting orders
    ├── market-price.service     162 lines — live Dhan bridge client
    └── ist-time.util.ts         IST session boundaries
```

### 5.4.2 `services/sentinel` module map 🟢

```
services/sentinel/src/
├── app.controller.ts       ServiceTokenGuard + 7 endpoints
├── domain.ts               Signal, TradeSummary, ObserveRequest/Response
├── orchestrator/           the ONLY producer of user-facing copy
├── intelligence/
│   ├── market-intelligence.service.ts   snapshot + structural signals
│   ├── emotion-intelligence.service.ts  behavioural signals
│   ├── trap-intelligence.service.ts     composite trap signals
│   ├── news-intelligence.service.ts     news-correlated signals
│   └── indicators.ts                    ema, rsi, macd, vwap, cpr, oiTrend…
├── compliance/             ⚖️ SEBI category labelling + audit persistence
├── explain/                explainability contract
├── brain/                  11 files — memory, patterns, similarity, learning
│   └── ontology/           5 files — 15 domains, 13 relations, seeding
└── market-data/            SimMarketDataProvider (dev)
```

---

## 5.5 Communication patterns

### 5.5.1 The three legitimate patterns

```
 A. Browser → services/api                 user JWT, HTTPS
 B. services/api → internal service        x-service-token, private network
 C. internal service → Postgres            Prisma, own tables (ARCH-5)
```

**Any other arrow is a violation.** Specifically:

| ❌ Forbidden | Why |
|---|---|
| Browser → `sentinel` / `market-data` / `trading-engine` | ARCH-1 |
| `sentinel` → `tradew-ai` | Independent systems; orchestration lives at the ingress |
| `sentinel` → `trading-engine` | ARCH-2 |
| Any AI service → order path | ARCH-2 |
| Two services writing one table | ARCH-5 |
| End-user JWT on an internal call | A compromised user token must not reach an internal API |

### 5.5.2 Why AI services never call each other

`services/tradew-ai` and `services/sentinel` have **no arrow between them**. When one user request needs both — the "TradeW AI auto-invokes Sentinel for premium reasoning" product behaviour — `services/api` fans out and composes.

> *"TradeW AI invokes Sentinel" is always shorthand for "the api layer, handling a TradeW AI interaction, also invokes Sentinel and composes" — never a direct service-to-service call.* (`TRADEW-OS.md` §2.4)

This matters because it keeps entitlement, rate limiting, and audit in one place. A direct `tradew-ai → sentinel` call would bypass the entitlement check for Sentinel reasoning — which is exactly the premium capability the whole business model rests on.

### 5.5.3 The service-token boundary, in code

```ts
// services/sentinel/src/app.controller.ts
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.SERVICE_TOKEN;
    if (!expected) throw new UnauthorizedException('SERVICE_TOKEN not configured');
    const req = context.switchToHttp().getRequest();
    if (req.headers['x-service-token'] !== expected) {
      throw new UnauthorizedException('Invalid service token');
    }
    return true;
  }
}
```

Two properties worth noticing:

- **Fails closed on missing config.** No token configured ⇒ every request rejected. A misconfigured deployment is unreachable, not open. This is the correct default and it is easy to get backwards.
- **Not on `/health`.** Health checks must work without credentials, or your orchestrator cannot tell "unhealthy" from "unauthorised."

🔵 **Planned hardening:** shared secret → mTLS once infra supports it. The guard is the seam where that swap happens.

### 5.5.4 Event bus — deferred, deliberately

Today: `services/api` fans out synchronously.

Specified for v1.0+: **Redis Streams first, not Kafka.**

```
  trading-engine publishes:
      OrderFilled · OrderRejected · PositionUpdated · PnLSnapshot
              │
      ┌───────┼───────────────┬──────────────────┐
      ▼       ▼               ▼                  ▼
   api    notification    analytics          sentinel
  (state)  (tell user)   (recompute)      (observe, non-blocking)
```

This decouples "an order filled" from "notify the user" from "recompute analytics." **Kafka only when a concrete consumer-group / durability / replay requirement genuinely cannot be met by Redis Streams** — not on a date, not because Kafka is the grown-up choice.

---

## 5.6 Data ownership (ARCH-5)

| Table group | Owner | Read by |
|---|---|---|
| `User`, `RefreshToken`, `UserPreference`, `AuditEvent` | `services/api` (auth) | — |
| `Plan`, `PlanGrant`, `Subscription`, `EntitlementOverride`, `UsageCounter` | `services/api` (entitlements) | — |
| `Instrument` | `services/market-data` (writes), `services/api` (reads) | both |
| `Quote` | **`services/market-data` only** | `services/api` |
| `Order`, `Trade`, `Position`, `PaperWallet` | `services/api` (sim) | — |
| `MemoryRecord`, `MemoryRelation`, `GraphNode`, `GraphEdge` | `services/sentinel` (Brain) | `api` via `/knowledge` |
| `ConceptNode`, `ConceptEdge`, `ConceptObservation`, `ConceptPromotion` | `services/sentinel` (ontology) | — |
| `SentinelObservation` | `services/sentinel` (compliance) | `api` read-only |
| `JournalEntry` | `services/api` | `sentinel` via request data |
| `NewsEvent` | `services/sentinel` (news) | `api` read-only |

### 5.6.1 The inversion that protects trading data

**Sentinel never queries `Order` / `Trade` / `Position`.** It receives `TradeSummary[]` on the `/observe` request body:

```ts
// services/sentinel/src/domain.ts
/** Trade summary passed in by services/api (Sentinel never queries trading tables). */
export interface TradeSummary {
  id: string; symbol: string; side: 'BUY' | 'SELL';
  quantity: number; fillPrice: number;
  realizedPnl?: number; createdAt: string;
}
```

It would be *easier* to give Sentinel a Prisma client and let it query. The reason we do not:

- **Blast radius.** A compromised Sentinel has no credentials for trading data. It cannot exfiltrate positions because it cannot see them.
- **Coupling.** Sentinel's contract is a DTO, not a schema. The trading schema can evolve without touching Sentinel.
- **Testability.** `emotion.signals(trades)` is a pure function over an array. It needs no database to test — which is why it is the one part of the system that is genuinely easy to unit test.

This is the single best security-and-design decision in the codebase, and it costs one interface.

### 5.6.2 The two-graph decision

Two graph systems coexist, deliberately:

| | `GraphNode` / `GraphEdge` | `ConceptNode` / `ConceptEdge` |
|---|---|---|
| Kind | **Entity** graph | **Concept** graph |
| Nodes | `NSE:RELIANCE`, `concept:bull-trap`, events | 66 market concepts |
| Relations | `mentions`, `co_occurs_with` (2, structural) | 13, closed, semantic |
| Meaning | none — records co-occurrence | every edge states *how* two ideas relate |
| Reasoning | impossible | best-first traversal with polarity + decay |
| Written by | `ConceptLearningEngine`, at runtime | seeder, from YAML |
| Bridged by | `ConceptObservation.symbol` — not a join | |

**Why not extend the entity graph?** Because "A `mentions` B" carries no information a reasoner can use. `is_a` / `causes` / `contradicts` do — and `polarity` and `transitive` on each relation are load-bearing:

- `causes` is **transitive** and **supporting** — A causes B, B causes C, so A weakly supports C, with per-hop decay
- `contradicts` is **not transitive** — A contradicts B, B contradicts C says *nothing* about A and C, and chaining it would manufacture false conflict
- `is_a` is transitive and **neutral** — it navigates the taxonomy without asserting anything

An unknown relation string would silently weight a conclusion wrong, which is why the vocabulary is closed and a new relation is an ontology change reviewed on its own.

---

## 5.7 Extraction triggers

The most useful table in this chapter. Every "should we split this out?" question is answered by a **measured condition**, never by taste.

| Currently | Extract to | Trigger | Not a trigger |
|---|---|---|---|
| auth module in `services/api` | `services/auth` | ~50k concurrent sessions | "auth feels important" |
| sim module in `services/api` | `services/trading-engine` | real-money order routing goes live | paper volume growth |
| sync HTTP fan-out | Redis Streams | a consumer must not lose events across a restart | "events are cleaner" |
| Redis Streams | Kafka | a durability / replay / consumer-group need Redis cannot meet | scale anxiety |
| Postgres analytics | ClickHouse | aggregate queries p95 > 2 s | table row count |
| `packages/ai-core` library | `services/tradew-ai` | AI workload needs independent scaling *or* a different runtime | folder tidiness |
| single Postgres | read replicas | read p95 > 200 ms attributable to contention | "we should have replicas" |
| Node market-data | — | **never** — singleton by design | any load argument |

### 5.7.1 Why `services/market-data` can never scale horizontally

This is not a "not yet" — it is a "not ever, as designed."

The broker feed connection set is a **per-account resource**. Dhan permits a bounded number of WebSocket subscriptions per account and enforces a **1 request/second** cap on the quote REST API. A second replica does not double throughput; it halves each replica's budget and doubles the chance of a rate-limit ban.

The scaling path when one ingestor is insufficient is therefore *not* replication. It is:

1. **Fan-out** — one ingestor writes; N stateless readers serve from the cache (this scales fine)
2. **Partition by account** — if we ever hold multiple broker accounts, shard the instrument universe across them
3. **Vertical** — the ingestor is I/O-bound, not CPU-bound; it has a lot of headroom

> ⚠️ **This is the most likely architecture mistake a new engineer will make.** "The market-data service is a bottleneck, let's add replicas" is wrong, and the failure mode is a rate-limit ban on the production broker account during market hours.

---

## 5.8 The dependency graph

```
apps/web ──────┐
apps/admin ────┼──► services/api ──► packages/database
apps/mobile ───┘         │        ──► packages/types
                         │        ──► packages/shared
                         │        ──► packages/market-data
                         │
                         ├──► services/auth            (in-process module today)
                         ├──► services/trading-engine  (internal REST, service token)
                         ├──► services/market-data     (internal REST)
                         ├──► services/tradew-ai       (internal REST)
                         ├──► services/sentinel        (internal REST)
                         ├──► services/notification    (internal REST / event bus)
                         └──► services/analytics       (internal REST)

services/sentinel   ──► packages/ai-core
                    ──► packages/market-data
                    ──► agents/sentinel/ (definitions)

services/market-data ──► packages/market-data

services/notification ◄──► n8n (external) ◄──► workflows/ (versioned exports)

packages/ui, packages/sdk ──► consumed by apps/* only
packages/database         ──► consumed by services/api only
```

### 5.8.1 The invariants this graph enforces

1. **No arrow from `packages/*` back into `apps/*` or `services/*`.** No circular dependencies, ever.
2. **No arrow from `apps/*` to anything except `services/api` and the listed packages.** ARCH-1 made concrete.
3. **No arrow between `services/tradew-ai` and `services/sentinel`.** They are independent systems that happen to share a caller.
4. **No arrow from any AI service to `trading-engine`.** ARCH-2 made concrete.
5. **`packages/database` is consumed by `services/api` only.** `trading-engine` owns its own store. `services/sentinel` uses its *own* Prisma client against its *own* tables — sharing the instance is fine; sharing the ORM ownership is not (ARCH-5).

### 5.8.2 Using the graph in review

> **The first question in any architecture review is: does this add an arrow?**

If yes, the burden of proof is on the proposal. Most bad designs are bad because of one arrow that should not exist, and catching it at the graph level takes thirty seconds versus catching it at the code level taking a week.

---

## 5.9 The un-migrated real-money engine

`services/trading-engine` is a **README-only folder**. The actual code — `extreme_algo_package`, a working Dhan options bot — sits at the LLC root, audited but not migrated.

**What it contains:**

| Component | Function |
|---|---|
| TradingView webhook receiver | HMAC-SHA256, timing-safe compare |
| ~8 REST endpoints | positions, orders, fills, P&L |
| `order_poller.py` | polling-based fill reconciliation |
| `mock_dhanhq.py` | paper broker for local development |
| SQLite | its own store, not the shared Postgres |

**Why it has not been migrated.** It handles real money. Migrating it is not a file move — it is: reworking the persistence layer onto shared Postgres with explicit table ownership; converting its REST API to internal-only with service-token auth; wiring it into the `services/api` aggregation; and re-validating the webhook path end-to-end. Every one of those steps can lose someone's money if done carelessly. It therefore requires **explicit execution approval** (`ARCHITECTURE.md` §2, consolidation plan).

**Two design decisions already made about it:**

1. `order_poller.py`'s polling-based reconciliation is **kept exactly as it is.** It is a good safety net, not a stopgap to replace with webhooks. Polling is how you find out about a fill whose webhook never arrived.
2. Its REST API becomes **internal-only** — reachable solely from `services/api` and `services/analytics` inside the private network. Never public, never called with an end-user JWT.

---

## 5.10 Extension rules

From `TRADEW-OS.md` §6. These are the rules for adding to TradeW without breaking it.

| # | Rule | Failure mode it prevents |
|---|---|---|
| 1 | **Search before you build.** Does an existing service/table/agent already do most of it? | Duplicate infrastructure |
| 2 | **New user-facing capability → a workspace surface under the shared chrome.** | A standalone page that breaks the OS feel |
| 3 | **New intelligence → a modular agent in the correct runtime by pillar.** | Reasoning logic embedded in `apps/web` or an n8n node |
| 4 | **New persistent knowledge → through the validation pipeline.** Research Vault first; Knowledge Graph only after validation. | Unvalidated claims presented as institutional truth |
| 5 | **New premium output → satisfies the explainability contract before it ships.** | An unexplainable conclusion the user cannot audit |
| 6 | **New cross-service coordination → orchestrate at `services/api` or via n8n.** | A new direct arrow between AI services |
| 7 | **Every new doc references `TRADEW-OS.md`.** | An orphan design nobody can trace |

### 5.10.1 Worked example — "add a Scanner"

```
Rule 1  Search: does anything scan? No. Does anything read Candle?
        Not yet — Candle itself doesn't exist. → BLOCKED on Migration 2.

Rule 2  Surface: a workspace under the shared chrome. One row in NAV_ITEMS,
        one dockable panel in PANEL_REGISTRY. Not a standalone page.

Rule 3  Intelligence? A predicate evaluator is not an agent. It goes in
        services/api as a module — no new runtime.

Rule 4  Does it create persistent knowledge? A saved scan is user config
        (UserPreference), not knowledge. No pipeline needed.

Rule 5  Premium? Yes, quota'd. → needs a reason-typed entitlement decision
        and a locked state, not a hidden nav item.

Rule 6  Cross-service? No.

Rule 7  Write docs/product-architecture/SCANNER.md, referencing TRADEW-OS.md.

RESULT: buildable as a services/api module + a dock panel, after Migration 2.
        No new service. No new arrow. One nav row.
```

Twelve lines of analysis that prevent a scanner microservice.

---

## 5.11 Environment & deployment tiers

| Tier | Infrastructure | Secrets | Market data | Broker |
|---|---|---|---|---|
| **local** | `docker compose` | `.env` files | OU simulator | paper OMS |
| **staging** 🔵 | Kubernetes namespace | secrets manager | Dhan sandbox | paper |
| **production** 🔵 | Kubernetes / OCI | Vault / AWS SM | Dhan live | real, tightly scoped |

### 5.11.1 Config discipline (ARCH-6)

- **No shared god `.env`.** Each service owns its `.env.example`. This directly fixes the "three disconnected credential surfaces" debt item from the consolidation audit.
- **Validated at boot, not at first use.** A missing `DATABASE_URL` should crash the process at startup, not throw at 09:16 IST on the first order.
- `packages/shared`'s config loader is specified to do this. 🔵 It is currently a folder — a real gap, since `ARCHITECTURE.md` §6 says every Node service consumes it.

### 5.11.2 Deployment status

| Artifact | Status |
|---|---|
| `infra/docker/docker-compose.yml` (dev) | 🟢 working |
| `infra/docker/docker-compose.prod.yml` | 🟢 written |
| `infra/docker/Caddyfile` (TLS) | 🟢 written |
| `infra/docker/backup.sh` | 🟢 written |
| `.github/workflows/deploy.yml` | 🟢 written |
| `infra/k8s/` | 🔵 README only |
| `infra/terraform/` | 🔵 README only |
| `infra/oci/` | 🔵 fully designed, **never provisioned** |

> **The platform has never been deployed.** The OCI Free Tier design — Dockerfiles, production compose, Caddy/SSL, backups, CI/CD for a single Ampere A1 arm64 VM — is complete and untested against reality. Chapter 22.

---

## 5.12 Observability roadmap

Build in this order (cheapest leverage first), from `ARCHITECTURE.md` §8:

| # | Capability | Status | Rationale |
|---|---|---|---|
| 1 | **Structured JSON logging** in every service | 🟡 Nest `Logger`, not JSON | Trivial cost, immediate debugging value |
| 2 | **Metrics** — Prometheus + Grafana | 🔵 | Start with `trading-engine`, extend to `api` |
| 3 | **Alerting** — one Slack webhook | 🔵 | Don't stand up PagerDuty before there is an on-call rotation to page |
| 4 | **Tracing** — OpenTelemetry across NestJS + Python | 🔵 | One order's path traceable end-to-end |
| 5 | **Log aggregation** — Grafana Loki | 🔵 | ELK is a later-scale target, not a day-one requirement |

Note the ordering principle: **each step must be cheap enough that it actually gets done.** A plan that starts with a full ELK stack ends with no logging at all.

---

## 5.13 Open architectural questions

Deliberately unresolved. Guessing at these would be worse than leaving them open.

| # | Question | Blocks |
|---|---|---|
| OD-1 | Exact schema split when `trading-engine` moves off SQLite — which tables it owns vs. reads cross-schema | real-money migration |
| OD-2 | Is `apps/mobile` React Native (sharing `packages/types`/`sdk`) or separate native? | Y3 mobile |
| OD-3 | Billing provider (Razorpay assumed, not decided) | monetisation |
| OD-4 | TradingView hosting model: self-host vs. licensed white-label embed | Phase 9 |
| OD-5 | When to migrate `extreme_algo_package` | real money |
| OD-6 | Reconciling the two simulated market engines before Migration 2 | `Candle` |
| OD-7 | Fundamentals data source for the screener | FR-SCR |

Each of these is tracked in Chapter 26 §26.9 with its decision owner.

---

## 5.14 Architecture review checklist

Print this. Use it on every design.

```
DEPENDENCY
  □ Does it add an arrow to §5.8? If yes, justify it explicitly.
  □ Does any app talk to anything but services/api?           → ARCH-1
  □ Does any AI service reach the order path?                 → ARCH-2
  □ Is Sentinel synchronous on any user-facing path?          → ARCH-3

DATA
  □ One owner per table?                                      → ARCH-5
  □ Does a service read another service's tables directly?
  □ Is a migration reversible, or forward-only by design?
  □ Does it delete anything? (It must not.)                   → Rule 1

BOUNDARY
  □ Does it duplicate a platform system? (auth, entitlements,
    market data, portfolio, notifications, design tokens)
  □ Could an existing service be extended instead?
  □ If it's a new service: which trigger in §5.7 fired?

COMPLIANCE ⚖️
  □ Any Buy/Sell/Entry/Target language anywhere?              → ARCH-4
  □ Is every AI output disclaimed?
  □ Is every premium conclusion explainable?
  □ Are new observations logged with evidence + category?

RELIABILITY
  □ Is every enrichment non-fatal?
  □ What is the blast radius if this component is down?
  □ Does background work block a request path?

OPERATIONS
  □ Does it ship a .env.example?                              → ARCH-6
  □ Is config validated at boot?
  □ What dashboard/alert covers it?
  □ Is the runbook updated?
```

---

*Next: [Chapter 6 — Sentinel: Foundations](06-sentinel-foundations.md)*
