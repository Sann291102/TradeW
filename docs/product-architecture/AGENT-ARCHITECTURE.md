# Agent Architecture — Product Blueprint

Status: design, pre-implementation. Introduced by the Genesis v2 direction update (§14). Governed by [`TRADEW-OS.md`](TRADEW-OS.md) §3 (AI orchestration model).

## 1. Principle: modular agents, orchestrated — not monolithic prompts

TradeW's intelligence is a roster of **single-responsibility agents**, each independently testable and replaceable. Two hard rules from `TRADEW-OS.md` §3:

1. **n8n orchestrates agents; it never contains business logic.** Workflows sequence, fan out, and wait on agents. Reasoning lives in the agents (`services/tradew-ai`, `services/sentinel`), never baked into an n8n node. If you find yourself writing an `if PCR > 1.2 then...` in an n8n function node, that logic belongs in an agent.
2. **Agents live in a runtime by pillar; `services/api` composes across them.** No direct arrow between `services/tradew-ai` and `services/sentinel` (`TRADEW-OS.md` §2.4).

## 2. The agent roster

The direction update's list maps onto TradeW's two runtimes plus the existing agent definitions in `TRADEW-AI.md` and `SENTINEL.md`. This is a **naming/responsibility consolidation, not a new set of services** — most of these already exist under different names in the pillar docs.

| Agent (direction update) | Runtime | Maps to / status |
|---|---|---|
| **Market Agent** | `services/tradew-ai` | Technical Analysis agent (`TRADEW-AI.md` §3) + the pipeline's Market Data Agent (`CONTINUOUS-LEARNING-PIPELINE.md`) |
| **Research Agent** | `services/tradew-ai` | Company Analysis agent + pipeline Research Agent |
| **News Agent** | `services/tradew-ai` | News Analysis agent (`TRADEW-AI.md` §3), shared with the pipeline's News Research stage |
| **Learning Agent** | `services/tradew-ai` | Learning Assistant agent + Learning Hub lesson generation (`LEARNING-HUB.md` §3) |
| **Memory Agent** | Sentinel Brain | `ConceptLearningEngine` + `PrismaMemoryStore`/`PrismaKnowledgeGraph` (audited real) — reads/writes Research Vault + Knowledge Graph |
| **Chart Agent** | `services/tradew-ai` | Technical Analysis agent's chart-context specialization; "Analyze this chart" (`TRADEW-ASSISTANT.md` §4) |
| **Portfolio Agent** | `services/tradew-ai` | Portfolio Insights agent (`TRADEW-AI.md` §3) |
| **Risk Agent** | `services/sentinel` | Market & Technical + Trap & Safety Intelligence (`SENTINEL.md` §2) |
| **Behavior Agent** | `services/sentinel` | Emotion Intelligence agent (`SENTINEL.md` §2) |
| **Sentinel Agent** | `services/sentinel` | Sentinel Orchestrator (`SENTINEL.md` §2) — the only Sentinel agent that produces user-facing output |

Router: the **AI Researcher** (`TRADEW-AI.md` §3) remains the front-of-house router for the ambient copilot, plus the intent classifier for navigation (`TRADEW-ASSISTANT.md` §2). It routes a user request to the right agent(s) above.

## 3. Orchestration boundaries — who coordinates what

Three distinct coordination layers, each with a clear owner. This is the part most likely to be got wrong, so it's explicit:

| Coordination need | Owner | Example |
|---|---|---|
| **A single user request needing multiple agents, synchronously, with a response** | `services/api` | "Analyze this chart" with Sentinel entitlement → api fans out to Chart Agent (tradew-ai) + Risk/Behavior (sentinel), merges into one explainable answer (`TRADEW-AI.md`, `EXPLAINABILITY.md`) |
| **Cross-agent synthesis *within* a pillar** | that pillar's orchestrator | Sentinel Orchestrator synthesizing Risk + Behavior + Trap + Compliance (`SENTINEL.md` §2) |
| **Background, multi-step, non-user-triggered agent sequences** | n8n | the Continuous Learning Pipeline: Market → Research → Historical → News → Validation, coordinated as an n8n workflow that *calls* each agent (`N8N-WORKFLOWS.md`, `CONTINUOUS-LEARNING-PIPELINE.md`) |

n8n's role is the third row: it's the durable, observable, retry-capable coordinator for background agent sequences. The agents it calls hold all the reasoning; n8n holds the sequencing, error-recovery, and scheduling (`N8N-WORKFLOWS.md`).

## 4. Why this doesn't create new infrastructure

Per `TRADEW-OS.md` §2.1, this roster is a **conceptual/naming layer over agents that already exist** in the pillar docs and the Sentinel Brain — not ten new services. The value of naming them uniformly is: n8n workflows and `services/api` orchestration can reference a stable agent contract (`POST /agents/:name/invoke`, already the pattern in `ARCHITECTURE.md` §4) regardless of which runtime hosts the agent, and each agent can be tested/swapped independently.

## 5. Agent contract (shared shape)

Every agent, in either runtime, exposes the same invocation contract (`ARCHITECTURE.md` §4): `POST /agents/:name/invoke`, internal-only, called by `services/api` (or n8n via service credential). Premium agents additionally return the explainability block (`EXPLAINABILITY.md` §4). This uniform contract is what lets n8n orchestrate agents without embedding logic — it just calls contracts and passes results along.

## 6. Open items

- Whether "Market Agent" and "Chart Agent" stay distinct or merge (they overlap heavily on Technical Analysis) — a refactor decision at build time, not now.
- Exact `POST /agents/:name/invoke` request/response schema per agent — implementation-time, following the explainability field requirements for premium agents.
