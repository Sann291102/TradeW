# Agent layers — what actually runs, and what is only specified

**Status: binding. Read this before `AGENT-ARCHITECTURE.md` or `ARCHITECTURE.md` §4.**

Three different things in this repo are called "an agent". They are not
variants of one design; they are separate layers with different lifecycles, and
the one the architecture docs describe most prominently is the one that barely
runs. A reader who takes `ARCHITECTURE.md` §4 as a description of the running
system concludes that TradeW runs five LLM-backed Sentinel agents with tools
and versioned prompts, invoked over a shared `POST /agents/:name/invoke`
contract. None of that is true: Sentinel uses no LLM, no tool is registered
anywhere, no prompt template is registered anywhere, and that route does not
exist.

This page is the map. When it disagrees with any other document about what
runs today, this page is right and the other document is describing an
intention.

---

## 1. The three layers

| Layer | Where | Runs today? | What it actually is |
|---|---|---|---|
| **A. SentinelIntelligence agents** | `services/sentinel/src/sentinel-intelligence/agents/*.agent.ts` | **Yes** | Ten deterministic TypeScript classes. No LLM, no tools, no prompts. Each reasons over shared market state plus a BM25 corpus retrieval and returns a cited `AgentVerdict`. |
| **B. Orchestrator engines** | `services/sentinel/src/intelligence/*.service.ts`, composed by `orchestrator/sentinel-orchestrator.service.ts` | **Yes** | Six deterministic signal engines behind the `/observe` path, reported to the admin portal under the telemetry names `market-technical`, `emotion`, `trap-safety`, `news`, `compliance-audit`, `orchestrator`. |
| **C. Declarative Agent SDK** | `packages/ai-core/src/{agents,tools,prompts}/`, `agents/*/definitions.json` | **One agent, one route** | `DefaultAgentRuntime` runs exactly one agent — `assistant-planner`, from `agents/tradew-ai/definitions.json`, on `POST /assistant/interpret` in `services/tradew-ai`. Nothing else in the layer executes. |

### What is true about layer C, precisely

The architecture docs describe layer C as the way every agent in TradeW is
invoked. In reality it has one caller, and two of its three primitives are
instantiated empty. The exact state, verified against the source:

| Claim in the docs | Reality |
|---|---|
| `POST /agents/:name/invoke` is the shared contract (`ARCHITECTURE.md` §4, `AGENT-ARCHITECTURE.md` §5) | **No such route exists in any runtime.** The one live surface is `POST /assistant/interpret` in `services/tradew-ai`. |
| `services/sentinel` loads its own definitions | **`agents/sentinel/definitions.json` is read by no code.** All five definitions in it are inert. Sentinel runs no LLM-backed agent at all. |
| `services/tradew-ai` loads its own definitions | **True.** `assistant.service.ts` reads `agents/tradew-ai/definitions.json` and runs `assistant-planner` against a real provider. `description` and `guardrails` take effect. |
| Agents call tools from a `ToolRegistry` | **No tool is registered anywhere.** The sole `DefaultToolRegistry` is constructed empty, so `specsFor()` returns `[]` and every `allowedTools` array is inert. |
| Prompts are versioned in a Prompt Library | **No template is registered anywhere.** The sole `InMemoryPromptLibrary` is constructed empty, so every `systemPromptId` misses and the runtime falls back to a prompt synthesized from `name` + `description`. There are no prompts to version. |

So the honest one-line summary is: **layer C is a working single-agent
planner for the web assistant, wearing the documentation of a
platform-wide agent bus.** The gap is the bus, not the runtime.

### What to do about it

Keep it. It is correct code with a real user. Three rules while the rest of
the layer is unbuilt:

1. Do not add a definition to `agents/sentinel/definitions.json` and assume it
   takes effect. It does not — nothing reads that file. Adding a Sentinel agent
   means writing a class in layer A.
2. Do not set `allowedTools` or `systemPromptId` on any definition and expect
   behaviour to change. Populate the registry and the library first.
3. When a second real caller appears, the header notices in
   `packages/ai-core/src/{agents,tools,prompts}/impl.ts` and the `$comment` in
   each `definitions.json` are updated in that same change — they are the
   contract that stops this drifting again.

---

## 2. The two Sentinel orchestrators (MG-1)

`SentinelOrchestratorService` (layer B) and `SentinelIntelligenceService`
(layer A) both compose the same six deterministic engines, both write pattern
occurrences through `PatternRecognitionService`, and both have a surfacing
gate. They are **both production**. The split is deliberate and documented at
`sentinel-intelligence.service.ts:36-49`, but "deliberate" is not "permanent",
and the cost is real: two gates, two silence policies, two confidence scales,
and any gate change has to be made twice.

**Current division of responsibility — this is the answer to "which one do I
change":**

| | `SentinelOrchestratorService` | `SentinelIntelligenceService` |
|---|---|---|
| Entry point | `POST /observe` — the route `apps/web` calls | `POST /intelligence/reason`, plus the autonomous watch sweep |
| Unit of work | one continuous session narrative | one question at a time |
| Output | LLM-polished prose, state machine, timeline | an evidence chain where every claim carries a citation |
| Gate | two surfacing gates | five gates (veto, corroboration, confidence, non-read, live performance) |
| Telemetry | `runAgentRun` + `trackAgent`, visible in the admin orbit | same, as of this change |

**Intended convergence path**, in order, so this does not stay ambiguous:

1. *(done)* Both paths emit the same telemetry shape, so the portal shows one
   picture of both.
2. Both paths write pattern occurrences through the same cooldown rule, so the
   base rates the live-performance gate reads cannot be inflated by whichever
   path happened to fire.
3. `/observe` delegates its *gate decision* to `SynthesisService`, keeping its
   own narrative composition. This is the step that removes the duplicated
   safety logic; the prose layer can stay split indefinitely without harm.
4. Only then does one of them become legacy.

Until step 3 lands, a change to a surfacing rule must be applied to both, and a
PR that changes one and not the other should be treated as incomplete.

---

## 3. Name collisions (MG-2)

Six of the ten layer-A agents share a class-name stem with an unrelated layer-B
service. They do genuinely different things and injecting the wrong one
compiles cleanly in several cases. A rename is out of scope; this table is the
disambiguation.

| Name stem | `…Service` (layer B — engine) | `…Agent` (layer A — reasoner) |
|---|---|---|
| **StrategyIntelligence** | `brain/strategy-intelligence.service.ts` — the **Brain**. Owns outcome-tagged base rates (`baseRateFor`). Reads Postgres. **The worst collision: these two are unrelated.** | `strategy-intelligence.agent.ts` — reads `context.detections` from the Strategy Engine and reports whether a named setup is confirming. Pure, no I/O. |
| MarketIntelligence | `intelligence/market-intelligence.service.ts` — computes the snapshot and technical signals. | `market-intelligence.agent.ts` — reads those signals and reports a stance. |
| EmotionIntelligence | `intelligence/emotion-intelligence.service.ts` — computes behavioural signals from trades. | `emotion-intelligence.agent.ts` — reads them and reports on the trader's state. |
| TrapIntelligence | `intelligence/trap-intelligence.service.ts` — composite trap signal computation. | `trap-intelligence.agent.ts` — reads the trap signals and reports a hazard. |
| NewsIntelligence | `intelligence/news-intelligence.service.ts` — reaches the newswire provider. | `news-intelligence.agent.ts` — reads `news_driven_volatility` and reports a volatility modifier, never a direction. |
| RiskIntelligence | `intelligence/risk-intelligence.service.ts` — computes the `RiskAssessment`. | `risk-intelligence.agent.ts` — reads it and reports exposure. |

Rule of thumb that resolves every row: **a `…Service` computes, a `…Agent`
reads what was computed and forms a verdict.** An agent that needs to compute
something is a bug in the agent, not a missing dependency — `AgentContext` is
the only thing an agent may read, and it is populated once per run.

---

## 4. Placeholders, named as such

These exist as directories and are empty. They are listed here so nobody
concludes from a README that something runs.

- **`services/tradew-ai/`** — real, and small: one module, one live route
  (`POST /assistant/interpret`), one agent (`assistant-planner`). It emits no
  agent telemetry, so it renders as permanently idle in the admin orbit. The
  `research` and `orchestrator` nodes the portal used to draw for this system
  never existed; the roster is now just the agent that does.
- **`workflows/`** — empty. No n8n workflow orchestrates anything in TradeW
  today, despite `AGENT-ARCHITECTURE.md` §3 assigning n8n the
  background-sequencing role. Background sequencing is currently done by
  `MarketWatchService`, `AdaptiveCalibrationService`, `IngestionQueueService`
  and `OutcomeLearningService`, each on a raw `setInterval` under Nest
  lifecycle hooks.
- **`apps/admin` agent-management page** — thresholds are environment variables
  (`SI_CONFIDENCE_THRESHOLD`, `SI_REQUIRED_CORROBORATION`,
  `SI_REQUIRE_LIVE_PERFORMANCE`), not portal controls, and there are no prompts
  to version because no agent uses one.
