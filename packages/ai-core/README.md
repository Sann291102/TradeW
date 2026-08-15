# packages/ai-core 🟢

`@tradew/ai-core` — the shared **AI foundation** for the whole platform. Every TradeW AI product (Sentinel, TradeW AI Research, Portfolio Intelligence, Education AI, future agents) composes these primitives; **no product implements its own provider calls, memory, retrieval, or agent runtime.**

Consumed by `services/api`, `services/sentinel`, and `services/tradew-ai` (see [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §6). Pure TypeScript library — built to `dist/` (`npm run build`) and consumed by its built entrypoint, not its source.

## Layer map (`src/`)

| Layer | Purpose |
|---|---|
| `domain/` | Shared knowledge types — `MemoryRecord`, `EntityRef`, provenance |
| `providers/` | LLM / Embedding / Research provider **contracts** + `ProviderManager` + factory. Implementations under `providers/impl/`: Anthropic, OpenAI-compatible, Voyage embeddings, research |
| `memory/` | Memory Engine (semantic store) + `VectorStore` interface (pgvector-backed in production, in-memory for tests) |
| `graph/` | Knowledge Graph — SQL-backed nodes/edges |
| `rag/` | Retrieval + chunking |
| `research/` | Research Engine pipeline: validate → summarize → embed → connect → store |
| `brain/` | Neural Brain pipeline + Learning Engine |
| `cognition/` | Perceptors + the four-layer network (L1–L4) and its online Hebbian weights (see below) |
| `context/` | Context Manager — token-budgeted prompt assembly |
| `prompts/` | Prompt Library + `CORE_GUARDRAILS` (the never-advise contract) |
| `tools/` | Tool Registry — **no order-placement tools, by design** |
| `agents/` | Agent SDK — declarative definitions + runtime contract |
| `telemetry/` | Call/latency instrumentation |
| `news/` | News-event classifier (13 categories) |

## Cognition network

`src/cognition/` is the four-layer perceptor network (17 perceptors → L1..L4) with an event dispatcher and online Hebbian weight updates. It surfaces in the `apps/admin` `/admin/cognition` neural-layers console, is **off by default**, and its proposals **never self-execute** — a human reviews them. Backed by the `Percept` / `PerceptorState` / `CognitiveEpisode` / `CognitiveProposal` / `NeuralSynapse` Prisma models. Unit-tested (`src/cognition/cognition.spec.ts`).

## Non-negotiable

Everything here obeys the TradeW constitution (`docs/product-architecture/TRADEW-OS.md` §1, root `CLAUDE.md` Rule 2): **analyze / explain / reflect, never execute.** There is no Buy/Sell/Entry/Target tool and no path from a primitive here to an order — that boundary is enforced at the Tool Registry and in `CORE_GUARDRAILS`.

## Build / test

```bash
npm run build -w @tradew/ai-core   # tsc → dist/
npm run test  -w @tradew/ai-core   # vitest
```
