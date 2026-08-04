# SentinelIntelligence — second reasoning engine, citation-grounded

**Read before touching `services/sentinel/src/sentinel-intelligence/`, and before
assuming Sentinel has one orchestrator.** It now has two engines. Related:
[[2026-07-26 - Sentinel Master Plan integration (12 modules into the existing service)]]
(the orchestrator this sits beside), [[2026-07-26 - TradeW AI assistant control layer (Comet-style app control)]]
(where the parsing rules came from), [[Decisions/2026-07-21 - Sentinel Concept Knowledge Graph (living ontology)]]
(the ontology this grounds), [[2026-08-03 - Test infrastructure pass (runners made discoverable, money math covered)]].

Branch `ai-reasoning`. ~9 500 lines across `services/sentinel`, `services/api`
and `apps/web`.

## The decision that shaped everything: additive, not a rewrite

`SentinelOrchestratorService` is untouched. `/observe` keeps its contract, its
state machine, its timeline and its LLM polish, because `apps/web`'s Sentinel
workspace and `services/api` both depend on that exact shape.

SentinelIntelligence is a **second engine over the same deterministic
substrate**. Both call `MarketIntelligenceService`, `StrategyEngineService`,
`TrapIntelligenceService` and friends read-only; neither reimplements the
indicator maths. What differs is downstream: the orchestrator produces one
continuous session narrative, this one answers one request at a time with an
auditable evidence chain.

**The registration pattern matters.** Providers are declared in
`sentinel-intelligence.module.ts` as an exported array and spread flat into
`AppModule` — the convention `LearningModule` established. The standalone
`@Module` exists for isolated tests and **must not** be imported by `AppModule`:
it declares its own `PrismaService` and market-data binding, so importing it
would open a second Postgres pool and a second broker feed connection, and the
feed is explicitly a per-account singleton
([[2026-07-21 - Market data Phase 1 (ingestion runtime, pure reads)]]).

## Three things called "knowledge" became four

The vault already warned that three separate things are called knowledge here.
This module adds a fourth, and the distinction is load-bearing:

| Store | Holds | Read by |
|---|---|---|
| `knowledge/` (this vault) | how to build TradeW | coding agents |
| `knowledge-base/` YAML | what market concepts *mean* | Sentinel ontology |
| Postgres Brain | accumulated trading-domain memory | orchestrator |
| **SI corpus (new)** | **citable passages from every source in the repo** | **SentinelIntelligence agents** |

The SI corpus is a **projection**, not a source of truth: 194 documents → 2085
chunks, rebuilt from disk, gitignored, disposable. It indexes the books, the
concept YAML, this vault and the product docs — and joins them to the ontology
by grounding each of the 66 concepts against the book corpus, so a concept an
agent leans on arrives with real citations rather than only its own definition.

## Lexical BM25 over vectors, deliberately

The Brain already has a pgvector path. It needs Postgres **and** an embedding
provider, and an engine that can only cite when both are up would produce
uncited verdicts on every developer machine and in CI.

A self-contained BM25 index makes the citation guarantee **unconditional**.
Per-document diversification caps how many chunks any one source contributes —
eight passages from one book is one author repeated, not eight sources, and
presenting it as corroboration overstates the evidence.

## The citation guarantee is structural, not conventional

Two mechanisms, because a convention would decay:

1. `VerdictBuilder.knowledge()` takes citations as a **required argument** and
   throws on an empty array. The uncited state is not constructible.
2. `CrossCheckService` **drops** any verdict carrying an uncited knowledge claim
   rather than merely flagging it. A malformed verdict that still counted toward
   corroboration could push an observation over the gate — the exact failure the
   gate exists to prevent.

## Two gates, and why neither substitutes for the other

Surfaces only at **≥70% confidence AND ≥2 corroborating agents**.

One agent at 95% stays silent. That is not conservatism — a single agent is a
single point of failure (overfit threshold, stale feed, bug) and no confidence
number makes it corroborated. Two agents at 71% agreeing from different evidence
is the stronger claim.

Two further gates behind those: a corroborated **`neutral`** is not surfaced
either (agents agreeing nothing is happening is not news, and publishing it
trains the reader to ignore the surface), and a composition that still contains
directive vocabulary after enforcement is **refused outright** rather than
published with a warning — a gap in the rewrite table must fail closed.

`risk-elevated` is kept **off the directional axis**. An agent reporting danger
is not contradicting an agent reporting bullish structure; collapsing both onto
one axis would manufacture a conflict on nearly every run and let a risk warning
cancel a structural read it was never in tension with.

## The vocabulary enforcer mangled its own disclaimer

Found by the first test run. Running the whole composed observation through
`enforceVocabulary` rewrote the noun **"advice" → "observation"**, turning the
closing "This is an observation… not advice" into "…not observation".

The orchestrator never hit this because its fallback draft bypasses the enforcer
(only LLM output is enforced there). A deterministic engine that enforces on its
*own* output does hit it.

**Fix and the general rule:** enforce on everything *derived from agent output*;
append reviewed constants **after** enforcement. A fixed, already-compliant
string has nothing to gain from being rewritten and everything to lose.

## Parsing rules inherited, not re-derived

The request parser is deterministic — no LLM in the understanding path, for the
same three reasons the assistant control layer chose that: instant and free,
testable without an API key, no generative surface to steer. Four production
bugs from that layer are guarded by construction and pinned by tests:

- **Index names contain digits.** "NIFTY **50** 24300" — alias text is scrubbed
  before strike detection, then the *largest* remaining candidate wins.
- **Nearest occurrence, not next.** A bare "21st July" said on 26 Jul resolved to
  **2027** — a contract with no liquidity. Now picks whichever of last/this/next
  year is closest in absolute days, and records "that expiry has already passed"
  as an assumption.
- **Longest alias first.** "bank nifty" must be tested before "nifty".
- **`call`/`put` are contract syntax, not a request for a tip.**

## Bugs the tests and smoke run caught

Worth recording because each looked fine on the page:

- `resolveIntent` used `/\brisk\b/`, so **"how risky is this"** — the most
  natural phrasing of a risk question — classified as a plain market read.
- `tokenize` kept `"61.8%"` as one token, so a query for `61.8` missed a passage
  writing `61.8%`. Percentages now index both ways.
- Incremental ingest re-parsed one document **on every run, forever**: the skip
  check probed for chunk `<sourceId>:0`, but chunk 0 is dropped whenever a
  document opens with front matter below `minChunkChars`. Key on having been
  *processed*, not on having produced chunks.
- **"with VWAP and fibonacci" resolved VWAP as a *strategy***, because the
  concept sits in a strategy-bearing ontology domain. Naming a tool to plot is
  not naming a setup to validate — it made the Strategy agent hunt for a
  detection nobody asked for, then report its absence as a finding.
- Two geometry test fixtures had filler bars sitting *below* the pivots they
  surrounded, so no swing was ever detected and the assertions passed vacuously.
  A swing low needs strictly higher lows on both sides; build fixtures with the
  filler above the pivot.

## Sentinel's first test runner

`services/sentinel` had **no vitest config at all** — the only executable checks
were the `ts-node` harnesses in `scripts/`, which nothing runs automatically
(exactly what [[2026-08-03 - Test infrastructure pass (runners made discoverable, money math covered)]]
recorded). Added: `vitest.config.ts` with an allowlist `include`, `npm test`, and
89 tests over the gate, the parser, retrieval and the geometry.

Note for CI: `prisma generate` must run first. Without it, `tsc` reports ~40
errors in `brain/` and `market-data/` that have nothing to do with the code —
there is still no postinstall hook.

## Learned TradingView rules are data, never code

Same principle as `intelligence/strategy-rules.ts`. A spec composes predicates
from a **closed vocabulary** (operands, comparisons, structure patterns, session
phases, anchors); it cannot introduce logic. That is what makes it safe to accept
a strategy definition over HTTP — the worst a malformed spec does is fail
validation with a field-level issue list.

Learning a spec also **indexes it into the corpus at the `user-rule` tier**,
which outranks published books in `SOURCE_AUTHORITY`. For this trader, their own
stated method is more authoritative than a general text, and the annotation their
rule places cites their rule.

Indexed as **English prose, not JSON**: `{"kind":"compare","op":">"}` tokenizes
into nothing anyone would search for. `describeCondition()` produces the same
text shown on the annotation, so citation and explanation cannot drift apart.

**Partial matches draw nothing.** A drawing is a claim the setup is present;
rendering "4 of 7 rules" with the same lines as a confirmed setup is how a chart
starts lying to its reader.

## Every annotation explains itself, structurally

`ChartAnnotation` requires `explanation`, `triggeredBy` and `confidence`, and the
only constructor is a private `annotate()` that demands all three. There is no
code path producing an unexplained drawing. Rule condition notes carry the **live
numbers** ("EMA20 24 318.4 is above EMA50 24 290.1"), never a restatement of the
rule name — the first is checkable against the chart, the second is not.

## What was deliberately not built

Stated rather than faked:

- **No Pine Script parser.** Specs are structured JSON; free text attaches via
  `rawSpec` and is citable but not executable.
- **No real-time TradingView integration.** The architecture is shaped for it —
  the drawing spec is transport-agnostic and the geometry engine is separable —
  but nothing streams yet.
- **Historical base rates are candle self-similarity**, not the Brain's Postgres
  pattern tables. Weaker, but always available, and sample-size gated (< 8
  episodes is reported as a weak precedent, never as a base rate).
- **The corpus is process-local.** Each replica builds its own index. Fine at
  one replica; a shared store is the change to make before scaling out.

## Verified, and not

Verified: 89 unit tests pass; `npm run si:test` indexes the real 194-document
corpus and resolves real citations with byte ranges; `tsc` clean across sentinel,
api and web; `next build` compiles every route.

**Not verified:** no live browser render of `/strategy-workspace` — port 3000 was
occupied by a running dev server. The build's type step also fails on a
**pre-existing** broken `Spinner` import in `NotificationsClient.tsx`, present on
the base commit and unrelated to this work.
