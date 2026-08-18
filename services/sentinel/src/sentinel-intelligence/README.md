# SentinelIntelligence

The master AI reasoning and orchestration engine. **Strictly additive** — it does
not modify, wrap or replace `SentinelOrchestratorService`, and the existing
`/observe` contract is untouched.

Both engines compose the same deterministic intelligence services. They differ
in what they do with the results:

| | Sentinel Orchestrator (`orchestrator/`) | SentinelIntelligence (this module) |
|---|---|---|
| Shape | One continuous session narrative | One request at a time |
| State | Market state machine + timeline | Stateless per run |
| Output | LLM-polished prose, two surfacing gates | Deterministic composition, one gate |
| Evidence | Signal evidence strings | Citations resolvable to a byte range |
| Route | `POST /observe` | `POST /intelligence/reason`, `/intelligence/workspace` |

Neither supersedes the other. If you are changing how the Sentinel workspace
reads the market, you want `orchestrator/`.

## Pipeline

```
understand → decompose → compute shared market state (once) → run 10 agents
  → validate → cross-check & resolve conflicts → synthesize → gate
```

Market state is computed **once per run** and shared with every agent. Ten
agents each fetching their own candles would multiply the data load by ten and,
worse, could have agents disagree because they read different ticks — a fake
conflict the cross-checker cannot distinguish from a real one.

## The gate

An observation is surfaced only when **both** hold:

1. aggregate confidence ≥ **0.70** (`SI_CONFIDENCE_THRESHOLD`), and
2. at least **2** non-abstaining agents (`SI_REQUIRED_CORROBORATION`) reached the
   leading stance.

Neither substitutes for the other. One agent at 95% is a single point of
failure — an overfit threshold, a stale feed, a bug — and no confidence number
makes it corroborated.

When the gates do not clear, `synthesis.observation` is `null`,
`synthesis.surfaced` is `false`, and `silenceReason` names the binding
constraint. **Silence is the designed behaviour, not a degraded mode.** Callers
must render nothing.

Two further gates sit behind those: a corroborated `neutral` reading is not
surfaced either (the agents agreeing that nothing is happening is not news), and
any composition that still contains directive vocabulary after enforcement is
refused outright rather than published with a warning.

## Knowledge substrate

`knowledge/` scans the whole repository and turns it into a citable corpus.
Measured against the real repo: **194 documents → 2085 chunks**, plus 66
canonical concepts with 273 semantic relations, all grounded.

| Root | Tier | Authority |
|---|---|---|
| learned TradingView rules | `user-rule` | 1.00 |
| `docs/Trading Books/` | `book` | 0.95 |
| `knowledge-base/`, `knowledge/sentinel-learning/` | `knowledge-base` | 0.90 |
| `knowledge/` | `vault` | 0.70 |
| `docs/product-architecture/`, `docs/handbook/`, `agents/` | `doc` | 0.65 |
| anything Sentinel wrote | `generated` | 0.40 |

A trader's own rules outrank a published book *for their charts*. Generated
content ranks last so the system cannot bootstrap confidence out of its own
prior output.

**Retrieval is lexical BM25, not vectors.** The Brain already has a pgvector
path, but it needs Postgres *and* an embedding provider. A self-contained index
makes the citation guarantee unconditional: every claim is checkable in dev, in
CI, and offline. Per-document diversification caps how many chunks one source
contributes, because eight passages from one book is one author repeated, not
eight sources.

Re-indexing is checksum-keyed and genuinely incremental (`0 parsed, 194
unchanged` on a warm run). Content hashing, not mtime — a `git checkout`
rewrites mtimes on files whose content never changed.

## The citation guarantee

Every `knowledge`-kind evidence item carries citations resolvable to
`sourcePath` + `charStart..charEnd`, with a **verbatim** quote. This is enforced
structurally, not by convention:

- `VerdictBuilder.knowledge()` takes citations as a required argument and throws
  on an empty array — the uncited state is not constructible.
- `CrossCheckService` **drops** any verdict with an uncited knowledge claim. A
  malformed verdict that still counted toward corroboration could push an
  observation over the gate, which is the exact failure the gate exists to
  prevent.

## Agents

Ten, each answering one question, in `agents/`:

`market` · `strategy` · `news` · `options-chain` · `risk` · `emotion` · `trap` ·
`historical-pattern` · `compliance` · `learning`

Design rules that apply across all of them:

- **An abstention is a first-class result.** It carries zero confidence and never
  counts toward corroboration. Emotion with no trade history abstains rather
  than reporting "no behavioural risk", which would read as an all-clear.
- **`risk-elevated` is not a direction.** It sits off the directional axis, so a
  risk warning is never treated as disagreement with a structural read.
- **Learning always returns `neutral`**, so it can never be one of the two
  corroborating agents. An agent that always agrees would silently satisfy the
  corroboration requirement on every run.
- An agent that throws produces an abstention, not a failed run.

## Visual layer

`visual/` produces the annotation layer. Every `ChartAnnotation` requires
`explanation`, `triggeredBy` and `confidence` — there is no code path that
produces an unexplained drawing.

Learned TradingView strategies are **data, never code** (the same principle as
`intelligence/strategy-rules.ts`). A spec composes predicates from a closed
vocabulary; it cannot introduce logic. Malformed specs fail validation with a
field-level issue list. Learning a spec also indexes it into the corpus at the
`user-rule` tier, so the annotation it places cites the rule that placed it.

Partial matches draw nothing. A drawing is a claim that the setup is present,
and rendering "4 of 7 rules" with the same lines as a confirmed setup is how a
chart starts lying to its reader.

## HTTP

All behind `ServiceTokenGuard`; `services/api` proxies them under
`/sentinel-intelligence/*` with the `sentinel` entitlement.

| Route | Purpose |
|---|---|
| `GET  /intelligence/status` | corpus, graph, agent roster, active gates |
| `POST /intelligence/reason` | one reasoning run (always returns the full run) |
| `POST /intelligence/workspace` | the three-panel payload |
| `POST /intelligence/rules` | learn a TradingView strategy |
| `GET  /intelligence/rules` | list learned strategies |
| `DELETE /intelligence/rules/:id` | retire one |
| `POST /intelligence/reindex?force=` | rebuild the corpus |

The corpus is built lazily on the first `reason` call, not at boot — parsing
30 MB of PDFs during startup would delay the health check past most
orchestrators' patience.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `SI_CONFIDENCE_THRESHOLD` | `0.7` | accepts `0.7` or `70` |
| `SI_REQUIRED_CORROBORATION` | `2` | minimum agreeing agents |
| `SI_REPO_ROOT` | auto-detected | corpus scan root |
| `SI_INDEX_FILE` | `services/sentinel/data/si-corpus.json` | persisted as `.gz` |
| `SI_RULES_FILE` | `services/sentinel/data/si-tradingview-rules.json` | learned rules |
| `SI_CHUNK_CHARS` | `2400` | target chunk size |
| `SI_MAX_CHUNKS_PER_DOC` | `0` (uncapped) | per-document cap |

`services/sentinel/data/` is gitignored — the corpus cache is rebuilt from the
repo and disposable by design.

## Tests

```bash
npm test -w @tradew/sentinel      # 89 unit tests, nothing needs to be running
npm run si:test -w @tradew/sentinel   # end-to-end against the real corpus
```

The unit suite is pure: no Nest context, no Postgres, no network, no market
data. The smoke test exercises scan → parse → index → ground → retrieve →
understand → decompose against the actual repository.

## Known limits

- **Options analysis needs a chain from the market-data provider.** With none,
  the agent abstains rather than estimating.
- **Historical base rates are computed from candle self-similarity**, not the
  Brain's Postgres pattern tables — weaker evidence, but always available, and
  sample-size gated so it is never dressed up as more than it is.
- **A TradingView spec must be supplied as structured JSON.** Pine Script is not
  parsed. Free-text rules can be attached via `rawSpec`, which is indexed and
  citable but not executable.
- **The corpus is process-local.** Multiple Sentinel replicas each build their
  own index. Fine at one replica; a shared store is the change to make before
  scaling out.
