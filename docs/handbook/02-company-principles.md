# Chapter 2 — Company Principles

A principle that does not change a decision is a slogan. Each of the ten below is stated, then immediately grounded in a decision it has already changed in this codebase, then given a **falsifier** — the observable thing that would prove we are not living up to it.

Use them in code review. "This violates Principle 3" is a complete review comment.

---

## 2.1 Customer First

> **The user's interest wins over the business's short-term interest, and where the two conflict, we write the conflict down rather than resolving it quietly.**

### What it means concretely

The clearest test of "customer first" in a subscription business is: *what do you refuse to gate?* Anyone will say the customer comes first. The question is what revenue you decline.

**We do not gate order placement.** Not by plan, not by tier, not by trial state. From `SUBSCRIPTIONS.md` §1, verbatim in its own emphasis: *order placement itself is never gated by any tier.*

This is not a small refusal. Gating order count is the single most obvious monetisation lever in a paper-trading product, it is what most competitors do, and it converts well. We decline it because the mission is "learn before you risk real money," and a platform that meters practice has quietly inverted its own mission for revenue.

### What we do gate

| Gated | Not gated |
|---|---|
| Sentinel premium reasoning | Sentinel workspace *visibility* |
| AI research runs (`UsageCounter` metric `ai_requests`) | Market data, charts, option chain |
| Learning Hub advanced curriculum | Learning Hub free tier |
| Historical depth beyond the free window | Order placement, modification, cancellation |
| Neural Brain deep-research invocations | Portfolio, positions, P&L, journal |

### The visibility rule 🔵→🟢

> **Entitlement gates reasoning, not visibility.** (`TRADEW-OS.md` §3, `SUBSCRIPTIONS.md` §4.)

An unentitled user **always sees Sentinel in the sidebar**. They enter the workspace and see a locked state with an Upgrade CTA in place of live observations — never a hidden nav item, never a 404, never a silent absence.

Implemented today as `apps/web/src/components/sentinel/SentinelLocked.tsx`, reached through the same route as the entitled experience. The `CapabilityGuard` (`services/api/src/entitlements/capability.guard.ts`) rejects the *reasoning* call, not the *page*.

Hiding a feature from a user who has not paid for it teaches them the product is smaller than it is. Showing it locked teaches them what they are missing. The second is both more honest and better business.

### Falsifier

If a release note ever contains "limited to N paper trades per day," or if a nav item disappears for an unentitled user, this principle has been abandoned and this section should be struck through rather than quietly ignored.

---

## 2.2 Learning Before Profit

> **The platform optimises for the user becoming a better trader, even where that costs engagement.**

### Concrete consequence 1 — paper trading is not a demo

The paper OMS is a full order-management system, not a mock (Chapter 11):

- Four order types with correct semantics: MARKET, LIMIT, SL, SL_M
- Correct state machine: `PENDING → OPEN → TRIGGER_PENDING → PARTIALLY_FILLED → FILLED | CANCELLED | REJECTED | EXPIRED`
- Real partial fills; quantity-weighted average fill price
- Simulated margin blocking that can genuinely reject an order for insufficient funds
- IST session-close expiry for DAY-validity orders
- Position mathematics that correctly handles add / partial-close / full-close / **close-and-flip**
- Realised vs. unrealised vs. daily P&L, with a session-open anchor snapshot per IST calendar day

The close-and-flip case is the tell. A demo does not implement close-and-flip, because a demo never has a user who sells 150 while long 100 and expects to end up short 50 with the correct realised P&L on the closed 100 and the correct new cost basis on the opened 50. `applyFill()` in `services/api/src/sim/order.service.ts:48` implements exactly that, and it is 25 lines of carefully-reasoned arithmetic because getting it wrong teaches the user something false.

### Concrete consequence 2 — paper prices are real prices

`MarketPriceService` reads the **live Dhan bridge**, not the Postgres `Quote` table, and its docstring explains why at unusual length:

> *"Deliberately NOT `MarketDataService` / Postgres `Quote`: that table is written by a different process, which defaults to a simulated random-walk feed. Filling paper orders against that would silently diverge from the real price the user is looking at on screen — confusing at best, wrong at worst."*
> — `services/api/src/sim/market-price.service.ts:60-68`

A paper fill at a price the user cannot see on their own chart is not a lesson. It is a bug that happens to run.

### Concrete consequence 3 — the coaching is unwelcome by design

Sentinel's behavioural observations are things the user did not ask for and will not enjoy: *"5 entries within 15 minutes of a losing exit this session."* An engagement-optimised product does not tell you that. A learning-optimised product has to.

### Falsifier

If we ever add a leaderboard of paper-trading returns, or a streak counter that rewards trading frequency, we have started optimising engagement over learning.

---

## 2.3 AI-Assisted Decisions

> **AI assists the decision. The human makes it. There is no configuration in which this is reversed.**

This is the principle with the most architectural enforcement, because it is the one with the most commercial pressure against it.

### Enforcement layer 1 — no tool exists

`packages/ai-core/src/tools/` contains a `ToolRegistry`, and the package's own index docstring records the absence as intentional:

```
tools/      Tool Registry (no order-placement tools, by design)
```

An agent cannot place an order because there is no function it can call to do so. Not a disabled function — an absent one. Adding one is a rejected pull request, not a feature flag.

### Enforcement layer 2 — no network path exists

`services/sentinel` cannot reach `services/trading-engine`. The dependency graph (`ARCHITECTURE.md` §9, Chapter 5 §5.8) has no such arrow, and `services/sentinel` has no HTTP client for it. Sentinel reads the user's trade history only as **data passed in by `services/api`** on the `/observe` request — it never queries trading tables itself:

```ts
// services/sentinel/src/intelligence/emotion-intelligence.service.ts:4-9
/**
 * Emotion Intelligence agent (deterministic half).
 * Reads ONLY the trade summaries services/api passes in — Sentinel never
 * queries trading tables itself. Output is reflective, never judgmental.
 */
```

That is a deliberate inversion of the obvious design. It would be easier for Sentinel to query the database. Passing summaries in means Sentinel has *no credentials* for trading data, which means a compromised Sentinel cannot exfiltrate a user's positions.

### Enforcement layer 3 — the prompt contract

`CORE_GUARDRAILS` in `packages/ai-core/src/prompts/` is injected into every system prompt in the platform. The Sentinel orchestrator concatenates it into the synthesis prompt explicitly:

```ts
// services/sentinel/src/orchestrator/sentinel-orchestrator.service.ts:152-153
`...Non-negotiable rules:\n` +
CORE_GUARDRAILS.map((g) => `- ${g}`).join('\n'),
```

### Enforcement layer 4 — the deterministic fallback

The most under-appreciated enforcement. If no LLM provider is configured, the orchestrator composes the same output structure from a template:

```ts
const fallback = `${evidence.join('. ')}. Together these resemble a ${patternName}
pattern on ${symbol}. This is an observation, not advice — consider waiting
for confirmation before acting.`;
```

The compliance posture does not depend on a model behaving. The structure is guaranteed by code; the model only makes the prose nicer.

### Enforcement layer 5 — the composite gate

A single signal never produces a user-facing warning. The orchestrator requires **≥2 triggered signals AND ≥0.7 combined weight**:

```ts
if (compositeWeight >= SURFACE_THRESHOLD && triggered.length >= 2) { ... }
```

This is an epistemics rule expressed as a threshold. One indicator crossing a line is noise; several unrelated observations agreeing is information. It also makes the system quiet, which is the correct default for something that interrupts a person during a trade.

### Falsifier

Any of: an order-placement tool in the registry; a direct arrow from an AI service to the order path; a prompt that omits `CORE_GUARDRAILS`; a code path that surfaces a single un-corroborated signal as a warning.

---

## 2.4 Research Driven

> **Raw evidence and validated knowledge are different things, live in different states, and are separated by a one-way gate.**

This is the platform's most distinctive intellectual commitment and its hardest to hold under delivery pressure.

### The knowledge lifecycle

```
   Observation
       │
       ▼
 ┌─────────────┐   raw evidence, provisional, freely admitted
 │  RESEARCH   │   • Sentinel observations
 │   VAULT     │   • news, research runs, external sources
 └──────┬──────┘   • MemoryRecord with low confidence
        │
        ▼
 ┌─────────────────────────────────┐
 │  VALIDATION ENGINE              │   🔵 Genesis Phase 6
 │  • historical comparison        │   the ONE-WAY gate
 │  • news correlation             │   ≥2 independent signals
 │  • confidence scoring           │   must corroborate
 └──────┬──────────────────────────┘
        │
        ▼
 ┌─────────────┐   validated, versioned, never deleted
 │  KNOWLEDGE  │   • ConceptNode / ConceptEdge (canonical)
 │    GRAPH    │   • GraphNode / GraphEdge (entity)
 └──────┬──────┘   • MemoryRecord with earned confidence
        │
        ├────────► Learning Hub content
        ├────────► Sentinel reasoning context
        └────────► TradeW AI research context
```

### The three things called "knowledge"

An engineer who confuses these will make an expensive mistake. This table is reproduced from `knowledge/Decisions/2026-07-21` because it is the single most useful disambiguation in the repository:

| Name | Location | Contains | Consumed by | Written by |
|---|---|---|---|---|
| **Engineering vault** | `TradeW/knowledge/` | Knowledge about *building TradeW*: decisions, patterns, gotchas, plans | AI coding agents and humans, at development time | Coding agents, per task |
| **Concept knowledge base** | `TradeW/knowledge-base/` | Knowledge about *markets*: 66 concepts, 273 relations, YAML, one file per concept | Sentinel's reasoner, at runtime | Humans; Sentinel proposes, never writes |
| **Runtime Brain** | Postgres + pgvector | Knowledge *learned from operation*: memories, entity graph, concept observations | Sentinel and TradeW AI, at runtime | Services, continuously |

**The engineering vault is never wired into the production runtime.** Two deliberately separate systems. Mixing them would mean a debugging note from a 3 a.m. incident could end up cited in a user-facing market observation.

### Sentinel proposes; only humans promote

The `ConceptPromotion` table is a human review queue. Runtime learning proposes a new concept or relation; a person reviews it; a person edits the YAML; the next reseed makes it canonical. **Sentinel never edits the canonical source files.**

The reseed contract enforces the separation at the column level:

```
ConceptNode / ConceptEdge columns
├── canonical  ── rewritten by the seeder on every reseed
│   (name, definition, explainer, weight, sources, ...)
└── learned    ── NEVER touched by the seeder
    (learnedWeight, supportCount, refuteCount,
     observationCount, lastObservedAt, observations)
```

This is what lets the ontology be regenerated from YAML at any time without destroying what the system learned in production. It is a small schema decision with a large operational consequence: a reseed is a safe, boring operation instead of a data-loss event.

### Falsifier

If a `MemoryRecord` reaches the Knowledge Graph without passing a validation gate, or if a service writes to `knowledge-base/*.yaml`, this principle has been abandoned.

---

## 2.5 Performance Matters

> **Latency is a feature with an owner, a budget, and a regression test — not an optimisation phase.**

### The budget

| Interaction class | Budget | Technique |
|---|---|---|
| Keystroke → visual acknowledgement | **≈20 ms** | Local state, no network on the critical path |
| Micro-interaction (hover, toggle, tab) | ≤150 ms | CSS transition, no re-fetch |
| Panel open / dock change | 200–300 ms | Lazy-loaded chunk + skeleton |
| Route change | ≤350 ms | Prefetch + streaming SSR |
| Quote cell update | ≤16 ms per frame | Cell-granular update, never page re-render |
| API read (cached) | ≤50 ms | Redis / in-memory cache 🔵 |
| API read (uncached) | ≤200 ms p95 | Indexed query, single round trip |
| AI first token | ≤800 ms | Streaming; skeleton above ~150 ms |

### The rule that most shapes the frontend

> Real-time surfaces (watchlist, chart, option chain) update at **row/cell granularity** — never full-page re-renders. (`GENESIS-V2-BLUEPRINT.md` §6.)

An option chain has ~40 strikes × ~14 columns = ~560 numeric cells, several of which change per tick. Re-rendering that tree at 4 Hz is the difference between a terminal and a toy. Chapter 15 §15.9 and Chapter 20 §20.7 specify the subscription-per-cell pattern this requires.

### The rate limit that shapes the backend

Dhan's quote API allows **1 request per second**. That single number forced the entire market-data architecture:

- `services/api` no longer generates quotes
- `services/market-data` became the **sole writer** and a **singleton** — the broker feed connection set is a per-account resource, so a second replica is not a scaling improvement, it is a rate-limit violation
- The two divergent simulators collapsed into `packages/market-data`
- A `TokenBucket` (`packages/market-data/src/rate-limit/token-bucket.ts`) exists specifically to make the budget explicit rather than emergent

Chapter 12 §12.4 walks the arithmetic. It is the clearest example in the platform of an external constraint dictating an internal boundary — which is the normal case, not the exception.

### Falsifier

A pull request that adds a network call to a keystroke handler, or a component that re-renders a table on every tick, should fail review on this principle alone.

---

## 2.6 Security First 🔒

> **The security posture is structural, not procedural: it comes from boundaries that make the bad thing impossible, not from rules that make it forbidden.**

### The five structural controls in place today

| # | Control | Mechanism | File |
|---|---|---|---|
| 1 | **One public ingress** | All client traffic through `services/api`; every other service is unreachable from the internet | `ARCHITECTURE.md` §1 |
| 2 | **Service-token boundary** | `ServiceTokenGuard` rejects any request without `x-service-token`; only `services/api` holds it | `services/sentinel/src/app.controller.ts:26` |
| 3 | **Never an end-user JWT between services** | Internal calls use a service credential; a compromised user token cannot reach an internal API | `ARCHITECTURE.md` §3 |
| 4 | **Append-only audit** | `AuditEvent` and `SentinelObservation` are written, never updated; audit failures log loudly and never break the flow | `compliance.service.ts:41-45` |
| 5 | **Per-service secrets** | No shared "god" `.env`; every service ships its own `.env.example`; config validated at boot, not first use | `ARCHITECTURE.md` §7 |

### The compliance-driven controls ⚖️

Indian regulation shapes several designs that would otherwise look over-engineered:

- **Every Sentinel observation carries a SEBI-relevant category label**, assigned by the Compliance & Audit agent (`behavioral_pattern_observation`, `market_risk_awareness`, `market_structure_observation`, `synthesized_risk_awareness`). This makes the "Why" panel on a Live Safety Feed card *defensible*, not just a UX flourish.
- **Audit logging failing is a compliance incident**, so it is logged at `error` level even though it is non-fatal — a silent audit gap is worse than a noisy one.
- **DPDP Act 2023** drives data-residency and retention design (Chapter 17 §17.8, Chapter 19 §19.8).

### The open item, stated plainly

A Neon Postgres credential was found committed in cleartext in the **superseded** `tradew-prototype/backend/prisma/schema.prisma`. That prototype is not the current monorepo, which uses `.env`-based `DATABASE_URL` — but the credential itself must be confirmed rotated regardless of whether that folder is ever touched again. Tracked in Chapter 19 §19.5.

### Falsifier

Any secret in git history that has not been rotated; any service reachable from the public internet other than `services/api` and the web app; any internal call carrying an end-user JWT.

---

## 2.7 Scalability First

> **Design at the boundary you will eventually need. Deploy the simplest thing that serves today's load. Write down the trigger that moves you from one to the other.**

This principle is frequently misread as "build for scale," which is the opposite of what it says.

### The pattern

```
   TODAY                          TRIGGER                    LATER
   ─────                          ───────                    ─────
   auth as a NestJS module        ~50k concurrent            services/auth
   inside services/api            sessions                   deployable

   synchronous HTTP fan-out       a consumer that must       Redis Streams
   from services/api              not lose events on         event bus
                                  restart

   Redis Streams                  a durability/replay/       Kafka
                                  consumer-group need
                                  Redis genuinely
                                  cannot meet

   Postgres for analytics         aggregate queries          ClickHouse
                                  exceeding ~2s p95

   single market-data ingestor    never (this one is         no change —
                                  singleton BY DESIGN)       it's a per-account
                                                             resource
```

Every trigger is a **measured condition**, never a date and never a feeling. "It feels like time to split this out" is not a trigger.

### Why `services/auth` is a folder with no deployable

The audited backend already has a working auth module — JWT, refresh-token rotation, audit logging — inside the NestJS app. Splitting it out today means running, deploying, and securing a second network hop for zero current benefit: nothing needs auth to scale independently of the rest of the API.

`services/auth/` exists **now** as the contract boundary. When load requires it, the extraction is a lift of an already-isolated module, not a rewrite. That is the whole technique: **pay the design cost early (it is cheap), pay the operational cost late (it is expensive).**

### Where load genuinely diverges

One deployment per service, path-triggered CI. A `trading-engine` traffic spike must not force scaling `analytics`. A change to `services/trading-engine` must not rebuild `apps/admin`.

### Falsifier

Extracting a service without a documented trigger having fired. Or, conversely, refusing to extract one after its trigger has demonstrably fired.

---

## 2.8 Reliability

> **A degraded feature is a success. A cascading failure is the only real outage.**

### The non-fatal wrapping discipline

Grep for `non-fatal` in `services/sentinel/` and you will find every enrichment individually wrapped. This is not defensive-programming reflex; it is a deliberate architecture where the *core* of every operation is small and everything else is optional.

The `/observe` handler is the canonical example:

```
POST /observe
│
├─ CORE (must succeed) ────────────────────────────────────
│   market snapshot → signals → composite gate → synthesis
│
├─ FIRE-AND-FORGET (never awaited, never blocks) ──────────
│   • researchTrigger.researchIfUnfamiliar(symbol)
│   • outcomeLearning.evaluatePending(5)
│
├─ TRY/CATCH, WARN, CONTINUE ──────────────────────────────
│   • patternRecognition.recordOccurrence()   → warn
│   • historicalSimilarity.similarPast()      → warn
│   • marketContext.contextFor()              → .catch(undefined)
│
└─ ERROR-LOGGED, NEVER THROWN ─────────────────────────────
    • compliance.record()  → logger.error, flow continues
```

A user gets an observation even if the Brain is unreachable, the LLM provider is down, the concept graph is mid-reseed, and the audit write failed. Each of those produces a log line; none produces a 500.

### The same discipline in the matching engine

```ts
// services/api/src/sim/matching-engine.service.ts:56-61
// One order's evaluation failing (e.g. its instrument's live price is
// momentarily unreachable) must never stop the rest of the book from
// being evaluated this tick.
```

### The reliability property that Principle 1.3.2 buys us

Because **Sentinel is never a gate**, Sentinel being completely down means: the user sees no observation cards. That is the entire blast radius. Orders place, fills happen, P&L computes, charts render. A risk system that could block would instead have taken the platform down with it.

This is the strongest argument for the non-blocking design, and it is an engineering argument rather than a product one.

### Falsifier

Any synchronous, unwrapped dependency on an AI service from a user-facing path. Any `await` on an enrichment.

---

## 2.9 Maintainability

> **Optimise for the engineer who arrives in eighteen months with no context and a production incident.**

### The four disciplines

**1. Archive, never delete.** (`CLAUDE.md` Rule 1.) Superseded code goes to `archive/`. Not even in bypass-permissions mode. If deletion seems genuinely required, stop and ask.

**2. Targeted edits, not rewrites.** Locate the exact lines, quote them, rewrite only those. Do not "clean up" code you were not asked about. A whole-file rewrite destroys the blame history that explains *why* the file is the way it is — which is usually the information the next engineer actually needs.

**3. Document-driven.** Architecture is decided in documents before code. New work matches documented boundaries.

**4. One design system.** `packages/ui` implements `DESIGN-SYSTEM.md` exactly. Shared motion and token modules. No per-component ad-hoc styling. (Chapter 24.)

### The comment standard

Comments explain **why**, never **what**. The repository is unusually well-commented and the reason is visible in the *content* of the comments — nearly every one prevents a future engineer from "fixing" something deliberate:

```prisma
/// Soft-delete flag. Delisted instruments are deactivated, never removed —
/// CLAUDE.md Rule 1, and Order/Trade/Position rows reference them forever.
active Boolean @default(true)
```

```prisma
/// Plain slug references, not FKs — a concept may name its successor before
/// that successor has been authored, and a FK would make seed order matter.
supersededBy String?
```

Both of these look like mistakes to a careful reviewer. Both are correct. The comment is the difference between a five-minute review and a two-day regression.

### The engineering vault as institutional memory

`knowledge/` (Obsidian, git-tracked) holds the things that cost time once and should not cost time twice. The workflow is mandatory for substantive tasks:

```
search the vault (_INDEX.md, then grep)
        ↓
retrieve and reuse existing notes instead of re-deriving
        ↓
reason only on what is genuinely new
        ↓
if the result has long-term value, create/update a note
        ↓
link related notes, update _INDEX.md
```

Sample of what it has already saved:

- `prisma migrate dev` refuses to run in a non-TTY shell even with `--create-only` → hand-author SQL from `prisma migrate diff --script`, apply with `migrate deploy`
- Always diff a proposed migration against the **live DB**, not just `schema.prisma` — the schema file can drift ahead of any migration during a design conversation
- Zustand `persist` stores need `skipHydration: true` + manual `rehydrate()` in `useEffect` to avoid SSR hydration mismatches
- A mount-only `useEffect` in `AppFrame` does not re-run on client-side navigation — "the action succeeded but the shell didn't update" is almost always this

Each of those is a day someone will not lose again.

### Falsifier

A whole-file rewrite in a diff. A deleted file that is not in `archive/`. A substantive task that produced no vault note.

---

## 2.10 Developer Happiness

> **Every hour of developer friction is an hour not spent on the product, and friction compounds.**

### The zero-dependency local rule

**The entire platform runs locally with no API keys and no cloud services.**

```bash
docker compose -f infra/docker/docker-compose.yml up
```

That is the whole setup. What makes it work:

| Dependency | Local substitute | Mechanism |
|---|---|---|
| LLM provider | none needed | `createProviderManager` returns no LLM; `ProviderNotAvailableError` is caught and the deterministic template composes the output |
| Embedding provider | none needed | Concept and memory search fall back to text match |
| Dhan market feed | Ornstein–Uhlenbeck simulator | `packages/market-data/src/providers/simulated/ou-engine.ts` |
| Real broker | paper OMS | The paper engine *is* the product, not a mock of it |
| Postgres + pgvector | container | `infra/docker/docker-compose.yml` |
| pgAdmin | container | added 2026-07-21 for exactly this reason |

An OU process rather than a random walk is a small piece of care that matters: a mean-reverting simulator produces price series with realistic support/resistance behaviour, which means the trap detectors actually trigger during local development. A random walk would make Sentinel untestable without market hours.

### The fifteen-minute rule

A new engineer should have the product running locally within fifteen minutes of `git clone`. If Appendix C takes longer than that, Appendix C is a bug and should be filed as one.

### The tooling debts we currently owe our own engineers

Honesty over comfort:

- **No ESLint config exists anywhere in the repository.** Standards are enforced by human review, which is slower and less consistent than a linter. Chapter 23 §23.11 has the remediation plan.
- ~~**No test suite**~~ — **a unit-test suite + CI gate now exists** (updated 2026-08-15; ~70 TS/JS specs + 9 pytest files, `ci.yml`). The remaining gap is integration/E2E, not "run it and look." Chapter 21.
- **No pre-commit hooks**, so formatting churn shows up in diffs.
- **`seed.ts` is broken** (`bcrypt.hash is not a function`, a `ts-node` ESM/CJS interop issue), so demo-account seeding requires a workaround.

These are listed under Developer Happiness rather than under Testing or Tooling because that is what they actually cost: not correctness, but morale and velocity.

### Falsifier

A new engineer's first week spent on environment setup. A required paid API key to boot the platform. A code review that spends its budget on formatting.

---

## 2.11 Using these principles in practice

### In code review

Cite by number. These are complete, sufficient review comments:

> *"Violates Principle 3 (AI-Assisted Decisions) — this adds a synchronous Sentinel call to the order path, which also breaks ARCH-3."*

> *"Principle 8 (Reliability): `historicalSimilarity` is awaited without a catch. Wrap it — a Brain hiccup must not fail `/observe`."*

> *"Principle 9 (Maintainability): this is a whole-file rewrite of a 400-line service to change 12 lines. Please make it a targeted edit."*

### When principles conflict

They will. The resolution order is fixed:

```
1. TRADEW-OS.md constitution      (ARCH-1..4 live here)
2. Compliance / security          (⚖️ and 🔒 sections)
3. Customer First
4. Reliability
5. everything else, argued on merits
```

**Customer First outranks Performance.** A slower correct number beats a fast wrong one.
**Reliability outranks Scalability.** A system that works at today's load beats one that theoretically works at 100×.
**Security outranks Developer Happiness.** Always, and without discussion.

### When a principle is genuinely wrong

Write it down. Open an RFC (Chapter 25 §25.3). Amend this chapter with a struck-through original and a dated note — never a silent edit. A principle that changes without a record is a principle nobody can rely on, which makes it worse than no principle at all.

---

*Next: [Chapter 3 — Product Requirements Document](03-product-requirements.md)*
