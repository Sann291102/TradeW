# Chapter 18 — AI Architecture

**Status: 🟢 for `packages/ai-core` (~2,300 lines — providers, memory, RAG, research, brain, context, prompts, tools, agent SDK). 🔵 for streaming, the Research workspace, the validation pipeline, and evaluation.**

> **Where the code actually is.** TradeW AI's real agent/RAG/memory/provider logic lives in **`packages/ai-core`**, not in `services/tradew-ai` or `agents/tradew-ai` — both of which are README-only stubs. This surprises everyone. It is the extraction-trigger model working as designed (Chapter 5 §5.7).

---

## 18.1 The layer map

```
packages/ai-core/src/
│
│  domain/      shared knowledge types (MemoryRecord, EntityRef, provenance)
│      ▲
│  providers/   LLM · Embedding · Research contracts + ProviderManager
│      ▲                    no provider NAME appears in any type
│  memory/      Memory Engine (semantic store) + VectorStore
│      ▲
│  graph/       Knowledge Graph (SQL-backed nodes/edges)
│      ▲
│  rag/         Retrieval (semantic + graph expansion) + chunking
│      ▲
│  research/    Research Engine — validate → summarize → embed → connect → store
│      ▲
│  brain/       Neural Brain pipeline + Learning Engine
│      ▲
│  context/     Context Manager (token-budgeted assembly)
│      ▲
│  prompts/     Prompt Library + CORE_GUARDRAILS
│      ▲
│  tools/       Tool Registry  (NO order-placement tools, BY DESIGN)
│      ▲
│  agents/      Agent SDK (declarative definitions + runtime contract)
│
│  news/        13-category financial event classifier
```

**Zero runtime dependencies.** Only `typescript` and `@types/node` as devDependencies; provider implementations use `fetch`. A shared foundation that pulls in a vendor SDK forces that SDK on every consumer, and the whole point of this package is that nothing downstream knows which vendor is in use.

---

## 18.2 Provider abstraction 🟢

### 18.2.1 The locked rule

> *"No provider names appear anywhere in these types — providers are selected by configuration through the ProviderManager, never hardcoded (locked decision Q5)."*

```ts
export interface CompletionRequest {
  messages: ChatMessage[];
  /** logical model tier, mapped per-provider by configuration */
  tier?: 'fast' | 'balanced' | 'deep';
  /** explicit provider-specific model id override (config-driven only) */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolSpec[];
  jsonMode?: boolean;
  stopSequences?: string[];
}
```

### 18.2.2 Logical tiers, not model names

This is the most consequential decision in the package.

```
   CODE SAYS                CONFIG MAPS                  COST
   ─────────                ───────────                  ────
   tier: 'fast'      →      a small fast model           ₹
   tier: 'balanced'  →      a mid-tier model             ₹₹
   tier: 'deep'      →      a frontier model             ₹₹₹
```

Consequences:

- **Model upgrades are a config change**, never a code change. A new model generation ships by editing an environment variable.
- **Cost is tunable per deployment.** Staging can run everything on `fast`.
- **Provider migration is a config change.** Swapping vendors touches zero call sites.
- **The right tier is chosen at the call site by intent, not by budget.** `SentinelOrchestratorService.compose()` asks for `tier: 'fast'` because rewriting evidence into a paragraph is a small task — not because someone was economising.

### 18.2.3 `ProviderManager`

```ts
export interface ProviderSelection {
  llm:       string[];   // ordered preference, e.g. ['anthropic','nvidia-nim','openai','ollama']
  embedding: string[];   // e.g. ['voyage','nvidia-nim','openai']
  research:  string[];   // e.g. ['tavily','brave','anthropic-web-search','firecrawl']
}
```

> *"Consumers (Brain, Research Engine, Sentinel, TradeW AI) NEVER import a concrete provider. They ask the manager for the active capability. Primary/fallback order comes from configuration, never code. Adding a provider = implement the interface + register it; zero changes anywhere else."*

**Ordered arrays, not a single choice.** Fallback is a first-class concept: if the primary LLM is unavailable, the manager tries the next. `updateSelection()` allows a runtime reorder — a config reload or an admin override during an incident, without a deploy.

### 18.2.4 `ProviderNotAvailableError`

```ts
export class ProviderNotAvailableError extends Error {
  constructor(capability: string, tried: string[]) {
    super(`No ${capability} provider available. Tried (in configured order): ${tried.join(', ') || '<none registered>'}`);
  }
}
```

**This is not an error condition. It is a supported operating state.**

Every consumer catches it and degrades:

```ts
catch (err) {
  if (!(err instanceof ProviderNotAvailableError)) {
    this.logger.warn(`LLM synthesis failed, using deterministic composition: ${err}`);
  }
  return fallback;
}
```

Note that `ProviderNotAvailableError` is **not logged at all** — it is the expected state in local development, and a warning that fires on every request is a warning nobody reads.

### 18.2.5 Implemented providers 🟢

| File | Covers |
|---|---|
| `impl/anthropic.ts` | Anthropic Messages API |
| `impl/openai-compatible.ts` | **any** OpenAI-compatible endpoint: OpenAI, NVIDIA NIM, Ollama, vLLM, Together, Groq |
| `impl/voyage.ts` | Voyage embeddings |
| `impl/research.ts` | web research providers |

The OpenAI-compatible adapter is doing a lot of work: one implementation covers self-hosted models, NVIDIA NIM, and half a dozen hosted vendors, because they converged on one wire format.

---

## 18.3 The Neural Brain 🟢

### 18.3.1 The locked pipeline

```
   search memory ──► found?  ──► use it
                 │
                 └► missing? ──► research ──► learn ──► store
                                                  ──► connect ──► answer
```

```ts
export interface BrainAskResponse {
  answer: string;
  /** how the answer was produced, for audit + UI transparency */
  path: 'memory' | 'memory+research' | 'research' | 'model_only';
  retrieval: RetrievalResult | null;
  /** new knowledge created while answering */
  learned: MemoryRecord[];
  confidence: number;
}
```

### 18.3.2 Why `path` matters more than it looks

⚖️ It is an **audit field**. Six months after an answer was given, `path` tells you whether it came from stored institutional knowledge, from a live research run, or from the model's own weights with no grounding at all.

`'model_only'` is the one to watch. It means nothing in memory matched and no research ran — the answer is ungrounded. That is a legitimate outcome, and it must be *visible*, both to the UI (which should present it with lower confidence) and to whoever reviews the system later.

### 18.3.3 The Learning Engine

```ts
export type LearnEventKind =
  | 'task_completed'      | 'document_imported'  | 'research_result'
  | 'conversation_turn'   | 'observation_recorded'
  | 'journal_entry'       | 'report_generated';
```

> *"Event-driven ingestion; every completed task makes the Brain smarter."*

Sentinel's `PatternRecognitionService` uses `kind: 'observation_recorded'` for exactly this: every triggered signal becomes durable, queryable knowledge rather than a line in a response that is discarded.

### 18.3.4 ⚖️ The Brain's own guardrail

```
 * The Brain never executes trades and never produces Buy/Sell/Entry/Exit/Target
 * language — guardrails are enforced by consumers (agents) AND by prompt
 * contracts in the Prompt Library.
```

**Two layers, deliberately.** Belt and braces: the consumer enforces it, and the prompt contract enforces it. Either alone would be one mistake away from a compliance incident.

---

## 18.4 Memory 🟢

Chapter 9 §9.2 covers the three memory systems. The `ai-core` contracts:

```prisma
model MemoryRecord {
  summary         String
  content         String
  sourceKind      String    // research|document|chart|indicator|conversation|
                            // market_report|trading_journal|task_output|
                            // observation|system
  sourceReference String?
  sourceProvider  String?
  confidence      Float   @default(0.5)
  tags            String[]
  entities        Json
  userId          String?   // null = global/shared knowledge
  namespace       String  @default("global")
  staleAfter      DateTime?
  embedding       Unsupported("vector")?
  embeddingModel  String?
  embeddingDim    Int?
}
```

### 18.4.1 ⭐ `embeddingModel` / `embeddingDim`

> *"The embedding column is dimension-flexible; embeddingModel/Dim record what produced it so mixed-provider embeddings are never compared to each other."*

**The bug this prevents never throws.** Cosine similarity between a Voyage vector and an OpenAI vector returns a number between −1 and 1 that varies plausibly with the input and is completely meaningless. Without these two columns, a provider migration silently corrupts every retrieval result and nothing anywhere reports an error.

Two columns. One class of undetectable bug, eliminated.

### 18.4.2 Provenance is not optional

`sourceKind`, `sourceReference`, `sourceProvider`, `confidence` — every memory records where it came from and how much to trust it. This is what makes the explainability contract (§18.10) satisfiable: an answer can cite the memories that produced it, and each memory can cite its own source.

---

## 18.5 RAG 🟢

```ts
export interface RetrievalRequest {
  query: string;
  userId?: string | null;
  namespace?: string;
  limit?: number;
  /** expand results one hop through the knowledge graph (default true) */
  graphExpansion?: boolean;
}

export interface RetrievalResult {
  hits: MemorySearchHit[];
  /** records pulled in via graph relationships rather than direct similarity */
  graphHits: MemorySearchHit[];
  /** ready-to-inject context block, already ranked and token-budgeted */
  contextText: string;
}
```

### 18.5.1 Graph expansion — retrieval beyond similarity

```
   query: "why did the NIFTY breakout fail?"
        │
        ├─► SEMANTIC (pgvector)   → memories about breakouts on NIFTY
        │
        └─► GRAPH EXPANSION (1 hop)
              breakout ──confirms──► volume-confirmation
              breakout ──contradicts──► low-volume-breakout
              → memories about volume confirmation, which the
                embedding of the QUERY would never have surfaced
```

**This is the payoff of maintaining a graph alongside embeddings.** Semantic similarity finds documents that *sound like* the query. Graph expansion finds documents that are *related to* the query's concepts by a stated relation. They fail in different ways, so together they cover more.

`graphHits` is returned separately from `hits` so a caller can tell "this was similar" from "this was one hop away" — which matters for explaining why a piece of context was included.

### 18.5.2 `contextText` is pre-budgeted

The retriever returns a ranked, token-budgeted block ready to inject. Callers do not assemble it themselves, which means the token budget is enforced in one place rather than in every agent.

---

## 18.6 Context management 🟢

**Code:** `packages/ai-core/src/context/impl.ts`

### 18.6.1 The trimming priority

```
 * Deterministic, dependency-free context assembly.
 * Priority when trimming: system+guardrails and the user message are never
 * dropped; history is trimmed oldest-first, then retrieval, then inline data.
```

```
   ┌─────────────────────────────────────────────────────┐
   │  NEVER TRIMMED                                      │
   │  · system prompt + CORE_GUARDRAILS  ⚖️              │
   │  · the user's actual message                        │
   ├─────────────────────────────────────────────────────┤
   │  TRIMMED, in this order                             │
   │  1. conversation history   (oldest first)           │
   │  2. retrieval context      (capped at 50% of what   │
   │                             remains)                │
   │  3. inline data            (capped at 60% of what   │
   │                             remains after retrieval)│
   └─────────────────────────────────────────────────────┘
```

### 18.6.2 ⚖️ Why guardrails are never trimmed

A naive context manager trims from the top when it runs out of budget — and the system prompt is at the top. A long conversation would silently drop `CORE_GUARDRAILS`, and the model would stop being told it must not give advice **precisely in the sessions where it has been talking about trading for longest.**

The failure mode is: works in testing, works for short conversations, and produces a compliance incident on a power user's twentieth message.

Making the guardrails structurally un-trimmable removes the possibility.

### 18.6.3 The proportional caps

```ts
if (retrievalTokens > remaining * 0.5) { /* trim retrieval to 50% */ }
remaining -= this.estimateTokens(retrievalText);
if (inlineTokens > remaining * 0.6) { /* trim inline to 60% of what's left */ }
```

Neither retrieval nor inline data may monopolise the budget. A huge retrieval result cannot crowd out the inline market snapshot, and vice versa. Both are useful; neither is more useful than the other by enough to justify starvation.

### 18.6.4 Token estimation

```ts
estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
```

Four characters per token — the standard rough heuristic. Deliberately dependency-free: a real tokeniser is provider-specific, which would put a provider name into a layer that must not have one (§18.2.1).

The estimate is conservative for English and less accurate for code and numbers. Acceptable, because `reservedOutputTokens` provides headroom and the consequence of a bad estimate is a trim, not a failure.

### 18.6.5 `trimmed[]` is returned

```ts
trimmed: { section: string; droppedTokens: number }[]
```

The result reports what was dropped and how much. **Silent truncation is a debugging nightmare** — "the model didn't know about X" is unanswerable without knowing whether X was ever in the prompt.

---

## 18.7 Prompt engineering 🟢

### 18.7.1 The Prompt Library

```ts
/** In-process prompt library; templates are registered from
 *  version-controlled files at boot. */
export class InMemoryPromptLibrary implements PromptLibrary {
  private templates = new Map<string, Map<number, PromptTemplate>>();  // id → version → template
```

**Prompts are versioned artefacts**, registered from version-controlled files. Not string literals scattered through services.

```ts
async render(id: string, vars: Record<string, string>, version?: number): Promise<string> {
  const template = await this.get(id, version);
  if (!template) throw new Error(`prompt template not found: ${id}…`);
  const missing = template.variables.filter(v => vars[v] === undefined);
  if (missing.length) throw new Error(`prompt ${id}: missing variables ${missing.join(', ')}`);
  return template.template.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? '');
}
```

**Missing variables throw.** A prompt rendered with `{{symbol}}` unsubstituted would send a literal `{{symbol}}` to the model, which produces a confidently wrong answer rather than an error. Failing loudly at render time is the only safe behaviour.

### 18.7.2 Versioning enables evaluation

`get(id, version?)` defaults to the latest but can pin a version. That is what makes prompt A/B testing and regression evaluation possible: run the eval suite against v3 and v4 and compare, rather than editing a string and hoping.

### 18.7.3 ⚖️ `CORE_GUARDRAILS`

The non-negotiable rule set injected into **every** system prompt on the platform. Sentinel concatenates it explicitly:

```ts
content:
  `You are the Sentinel Orchestrator, an observation-only trading intelligence desk. ` +
  `Rewrite the evidence into one short, calm paragraph following exactly: ` +
  `evidence -> pattern name -> soft suggestion. Educational tone.\n\n` +
  `Non-negotiable rules:\n` +
  CORE_GUARDRAILS.map(g => `- ${g}`).join('\n'),
```

The guardrails cover: no Buy/Sell/Entry/Target/Stop language; no imperatives; no price predictions; no certainty claims; observation and reflection only; disclaimer required.

### 18.7.4 The prompt patterns that work here

| Pattern | Applied |
|---|---|
| **Structure the output, not the analysis** | The model rewrites evidence into a fixed shape; it never decides what the evidence means |
| **Constrain output length** | `maxTokens: 220` — an observation card is a paragraph, not an essay |
| **Give the format explicitly** | *"following exactly: evidence → pattern name → soft suggestion"* |
| **Put non-negotiables last** | recency helps adherence |
| **Name the role narrowly** | *"an observation-only trading intelligence desk"* |
| **Always have a deterministic fallback** | the prompt is an enhancement, never a dependency |

---

## 18.8 Tools 🟢⚖️

```
tools/      Tool Registry (no order-placement tools, by design)
```

### 18.8.1 ARCH-2 enforced by absence

An agent cannot place an order because **there is no function it can call to do so.** Not a disabled tool, not a permission check, not a feature flag — an absent capability.

```
   ❌ tool: place_order    (disabled)      ← one config change from a disaster
   ✅ tool: place_order    (does not exist) ← requires a PR, a review, and
                                              a violation of a documented rule
```

### 18.8.2 The tool allowlist 🔵

| Allowed | Forbidden |
|---|---|
| `search_memory` | `place_order` |
| `get_market_snapshot` | `modify_order` |
| `get_option_chain` | `cancel_order` |
| `get_user_positions` (read-only) | `exit_position` |
| `get_concept` | `transfer_funds` |
| `search_news` | `update_user_settings` |
| `get_historical_similarity` | anything that writes to a trading table |

**The rule: a tool may read anything the user can already see. It may write nothing.**

### 18.8.3 Tool-call safety 🔵

```
   □ Every tool input validated against its JSON Schema before execution
   □ Every tool call logged with arguments and result  ⚖️
   □ Tool calls counted against the user's quota
   □ Per-turn tool-call limit (prevents runaway loops)
   □ Tools carry no ambient authority — the calling user's id is
     injected by the runtime, never taken from the model's arguments
```

That last one is the important one. A model that can supply `userId` as a tool argument can read another user's positions by hallucinating an id.

---

## 18.9 The agent system 🟡

### 18.9.1 Declarative definitions

`agents/sentinel/definitions.json` and `agents/tradew-ai/` hold **configuration** — system prompts, allowed tools, guardrail and disclaimer config — as version-controlled files reviewed like code.

> A prompt change is a reviewed change. That is the entire point of keeping definitions out of the source and in data.

### 18.9.2 The two rosters

**Sentinel (Safety Nets) — 4 + 1** 🟢 (Chapter 7)

**TradeW AI (Research) — 8** 🔵

| Agent | Answers |
|---|---|
| AI Researcher (router) | which specialist should handle this? |
| Company Analysis | what is this business? |
| News Analysis | what happened, and does it matter? |
| Option Chain Analysis | what does the chain structure say? |
| Technical Analysis | what is the price structure? |
| Strategy Builder | what does this strategy's payoff look like? ⚖️ never *"trade this"* |
| Portfolio Insights | what is in this portfolio? |
| Learning Assistant | what does this concept mean? |

### 18.9.3 ⚖️ Strategy Builder — the highest-risk agent

Building a strategy payoff diagram is analysis. Recommending a strategy is advice. The line is:

```
   ✅ "A 25,000/25,200 bull call spread has a max profit of ₹X at
       expiry above 25,200, a max loss of ₹Y below 25,000, and a
       breakeven at 25,0NN. Its net delta is Z."

   ❌ "Given the current setup, a bull call spread is a good trade here."
   ❌ "This strategy has a 68% probability of profit."
```

The second is a recommendation. The third is a probability claim that requires a model of future price distribution we do not have and would not stand behind.

**Rule: describe the instrument the user constructed. Never construct one for them and never rank alternatives.**

### 18.9.4 The orchestration boundary

`services/tradew-ai` and `services/sentinel` **never call each other.** When a request needs both, `services/api` fans out and composes (Chapter 5 §5.5.2).

> *"'TradeW AI invokes Sentinel' is always shorthand for 'the api layer, handling a TradeW AI interaction, also invokes Sentinel and composes'."*

Because that is where the entitlement check lives, and Sentinel reasoning is the premium capability the business model rests on.

---

## 18.10 Explainability ⚖️🟢

**Code:** `services/sentinel/src/explain/explain.service.ts`

```ts
export interface ExplainResult {
  answer: string;
  /** true only when a real configured LLM provider produced the answer */
  live: boolean;
  servedBy?: { provider: string; model: string };
  /** Explainability Engine: exactly what fed this answer — never a black box */
  trace: {
    evidenceUsed: string[];
    memoryHits: { summary: string; confidence: number }[];
  };
}
```

### 18.10.1 The `live` flag

> *"Honesty over polish: with no LLM provider configured, this returns a clearly-labelled deterministic explanation — never a faked AI-authored one."*

`live: false` means a template produced it. The UI must present it differently. Presenting a template as an AI explanation would be a small lie that, once discovered, discredits every genuine explanation.

### 18.10.2 The `trace`

Every explanation reports the evidence lines and the memory records it drew on. **Not a second explanation generated after the fact** — the actual inputs.

⚖️ The explainability contract requires every premium conclusion to show: reasoning, evidence, historical precedent, confidence, sources, and what changed. `trace` covers evidence and sources; `confidence` is on the response; historical precedent comes from `HistoricalSimilarityService`.

---

## 18.11 Hallucination reduction

Ranked by how much each actually contributes here:

| # | Technique | Contribution |
|---|---|---|
| 1 | **Deterministic core, LLM as stylist** | ⭐⭐⭐⭐⭐ The model never decides what is true |
| 2 | **RAG grounding** | ⭐⭐⭐⭐ Answers cite retrieved memories |
| 3 | **Closed vocabularies** | ⭐⭐⭐⭐ 13 relations, 15 domains, 13 event types — an invalid value is rejected at the boundary |
| 4 | **`CORE_GUARDRAILS` un-trimmable** | ⭐⭐⭐⭐ Constraints survive long contexts |
| 5 | **Structured output** | ⭐⭐⭐ `jsonMode` + schema validation |
| 6 | **Low `maxTokens`** | ⭐⭐⭐ 220 tokens leaves little room to invent |
| 7 | **`path` and `live` flags** | ⭐⭐⭐ Ungrounded answers are visible, not hidden |
| 8 | **`sampleTooSmall`** | ⭐⭐⭐ Withholding beats fabricating (`MIN_SAMPLE = 5`) |
| 9 | **Confidence caps** | ⭐⭐ Never claims certainty (0.95 ceiling) |
| 10 | **Deterministic fallback** | ⭐⭐ A provider failure produces plain text, not a wrong answer |

**Technique 1 dominates.** Every other item mitigates hallucination; the first makes most of it structurally impossible, because the model is not being asked a question whose answer could be hallucinated. It is being asked to rewrite a paragraph.

---

## 18.12 The distillation path 🟡

**Code:** `packages/ai-core/src/news/news-event-classifier.ts`

> *"The NVIDIA distillation blueprint in production form. Headlines from the MarketDataProvider are classified into the 13 standardized event categories through the provider layer; with `NVIDIA_NIM_BASE_URL` pointed at a distilled student model (NeMo Data Flywheel output), classification runs on that model with zero code change."*

```
   PHASE 1  frontier model classifies headlines
                    │
                    │  every classification logged: input → label
                    ▼
   PHASE 2  training set accumulates in NewsEvent
            (headline, eventType, classifiedBy, confidence, raw)
                    │
                    ▼
   PHASE 3  distil a small student model (NeMo Data Flywheel)
                    │
                    ▼
   PHASE 4  point NVIDIA_NIM_BASE_URL at the student
            ── ZERO code change ──
            ~10–50× cheaper per classification
```

**News classification is the ideal distillation target**: high volume, low complexity, closed output set, and a naturally-accumulating labelled dataset. `NewsEvent.classifiedBy` records which model produced each label, so the training set can be filtered by teacher and the student's accuracy measured against the teacher's.

The provider abstraction is what makes Phase 4 a configuration change. Without it, this would be a rewrite.

---

## 18.13 Evaluation 🔵

**Status: nothing exists.** The largest gap in the AI layer, and the reason prompt changes currently ship on judgement.

### 18.13.1 The four suites

**1. ⚖️ Compliance (must be 100%, runs in CI)**

```ts
const FORBIDDEN = [
  /\b(buy|sell|short|long)\s+(now|here|this|at)\b/i,
  /\btarget\s+(price|of)?\s*[₹\d]/i,
  /\bstop.?loss\s+(at|of)\s*[₹\d]/i,
  /\bdon'?t\s+(buy|sell|trade)\b/i,
  /\b\d{1,3}%\s+(probability|chance)\s+of\s+profit\b/i,
  /you (seem|appear|are)\s+(to be )?(feeling|experiencing)/i,
];

it('never produces forbidden language across the corpus', () => {
  for (const s of SCENARIOS) {            // ≥500 generated
    for (const p of FORBIDDEN) expect(compose(s)).not.toMatch(p);
  }
});
```

Run against the **deterministic composer** in CI (fast, free, exhaustive) and against the **live model** nightly (catches guardrail drift after a prompt or model change).

**2. Retrieval quality**

```
   Golden set: 100 (query, expected-relevant-memory-ids) pairs
   Metrics: recall@5, recall@10, MRR
   Regression gate: recall@5 must not fall more than 5pp
```

**3. Signal precision** — for Sentinel, from `OutcomeLearningService` data: per signal, what fraction of triggered occurrences were followed by the outcome the signal implies? This is what turns weight calibration from judgement into evidence (Chapter 9 §9.11).

**4. Answer quality** — LLM-as-judge on a rubric: grounded in retrieved context? cites evidence? correct register? disclaimer present? Sampled, not exhaustive, because it costs money.

### 18.13.2 The evaluation gate 🔵

```
   Before ANY prompt, model, or guardrail change ships:
     □ compliance suite  100%          (hard gate)
     □ retrieval recall@5  ≥ baseline − 5pp
     □ answer-quality rubric ≥ baseline − 5%
     □ ⚖️ 20 sampled outputs manually reviewed for register
```

---

## 18.14 Cost management 🔵

### 18.14.1 What already controls cost

| Control | Effect |
|---|---|
| **The composite gate** | The LLM runs on <15% of `/observe` calls |
| **`tier: 'fast'`** for styling | The cheapest tier for the most frequent call |
| **`maxTokens: 220`** | Bounded output |
| **Deterministic fallback** | A provider outage costs nothing and breaks nothing |
| **`UsageCounter` quotas** | Per-user research metering, already modelled |

**The composite gate is a cost control as much as a quality control.** A design that sent every observation to a model would be ~7× more expensive for structurally identical output.

### 18.14.2 Not yet built 🔵

```
   □ per-user cost attribution (tokens → ₹ → user)
   □ per-agent cost dashboards
   □ a monthly spend cap with degradation to deterministic mode
   □ prompt caching for the stable system-prompt prefix
   □ semantic response caching for repeated questions
   □ batch classification for news (currently one call per headline)
```

**Prompt caching is the highest-value unbuilt item.** The system prompt plus `CORE_GUARDRAILS` is identical on every call and is the majority of the input tokens for a 220-token completion. Caching that prefix cuts input cost substantially for a one-line change.

---

## 18.15 AI architecture debt

| ID | Debt | Severity | Fix |
|---|---|---|---|
| AI-1 | **No evaluation suite** | **high** | build the compliance suite first — it is the cheapest and the most important |
| AI-2 | No pgvector index (DB-1) | high | HNSW |
| AI-3 | No streaming | medium | SSE from `services/api` |
| AI-4 | Research workspace unbuilt | medium | Phase 5 |
| AI-5 | No cost attribution | medium | token accounting per user/agent |
| AI-6 | No prompt caching | medium | cache the stable prefix |
| AI-7 | Validation pipeline unbuilt | medium | Phase 6 — the one-way gate |
| AI-8 | `services/tradew-ai` is a stub | low | intentional — extraction trigger not fired |
| AI-9 | No tool-call audit log ⚖️ | medium | log every call with arguments and result |
| AI-10 | `staleAfter` unenforced (DB-10) | low | expiry job |

**AI-1 first.** Every prompt change currently ships on judgement, which is the same posture the rest of the codebase abandoned when it started writing decision records.

---

*Next: [Chapter 19 — Security](19-security.md)*
