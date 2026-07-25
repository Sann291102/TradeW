---
type: api
date: 2026-07-23
tags: [api, nvidia, nim, providers, sentinel, ai-core, skills]
status: verified
---

# NVIDIA free tools — what TradeW can use, and what is already wired

## For future Claude
**Do not re-implement NVIDIA NIM support.** It was already built into `packages/ai-core`
before this note existed. Getting Sentinel onto NVIDIA's free tier is a **configuration**
task (three env vars), not a code task. This note records what is free, what is already
wired, and how to verify it.

Two unrelated NVIDIA things share the word "free" — keep them apart:

| | What it is | Where it applies |
|---|---|---|
| **NIM API** (`build.nvidia.com`) | Hosted, OpenAI-compatible inference for 100+ models, free for NVIDIA Developer Program members | **Runtime** — Sentinel / TradeW AI at request time |
| **NVIDIA Agent Skills** (`github.com/nvidia/skills`) | Agent Skills (SKILL.md dirs) for NVIDIA products, installable into Claude Code | **Development** — the coding agent, never the product runtime |

They do not interact. A Skill teaches Claude Code how to drive an NVIDIA SDK; it has no
bearing on which provider serves a Sentinel observation.

## 1. NIM API (runtime) — already integrated

- `packages/ai-core/src/providers/impl/openai-compatible.ts` — one adapter serving
  OpenAI, NVIDIA NIM **and** Ollama. NIM-specific detail already handled: retrieval
  embedding models require `input_type` (`'query' | 'passage'`), injected only when
  `name === 'nvidia-nim'`.
- `packages/ai-core/src/providers/factory.ts` — registers `nvidia-nim` from
  `NVIDIA_NIM_API_KEY` / `NVIDIA_NIM_BASE_URL` / `NVIDIA_NIM_EMBEDDING_MODEL`. Default
  base URL `https://integrate.api.nvidia.com/v1`; default tier map is
  `fast → meta/llama-3.2-3b-instruct`, `balanced → meta/llama-3.1-8b-instruct`,
  `deep → nvidia/llama-3.3-nemotron-super-49b-v1`.
- `packages/ai-core/src/news/news-event-classifier.ts` — NVIDIA's financial-news
  distillation blueprint (13 event categories), provider-agnostic. See
  [../../docs/ai/DISTILLATION.md](../../docs/ai/DISTILLATION.md).

Consumer code never names a provider (locked decision Q5) — `ProviderManager` resolves
from `AI_LLM_ORDER` / `AI_EMBEDDING_ORDER`. So switching Sentinel onto the free tier is:

```env
# services/sentinel/.env
AI_LLM_ORDER=nvidia-nim,anthropic,openai,ollama
AI_EMBEDDING_ORDER=nvidia-nim,voyage,openai
NVIDIA_NIM_API_KEY=nvapi-...
NVIDIA_NIM_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_NIM_EMBEDDING_MODEL=nvidia/nv-embedqa-e5-v5
```

Which *model* serves each tier is also config, added 2026-07-23 (`tierModels()` in the
factory). Any tier left unset keeps its built-in default, so pinning one model is one line:

```env
NVIDIA_NIM_MODEL_FAST=meta/llama-3.2-3b-instruct
NVIDIA_NIM_MODEL_BALANCED=meta/llama-3.1-8b-instruct
NVIDIA_NIM_MODEL_DEEP=google/diffusiongemma-26b-a4b-it
NVIDIA_NIM_ENABLE_THINKING=true   # → chat_template_kwargs.enable_thinking
NVIDIA_NIM_TOP_P=0.95
NVIDIA_NIM_TIMEOUT_MS=300000      # must exceed the slowest pinned model
```

Free key: sign in at `build.nvidia.com`, open any model, "Get API Key" → `nvapi-...`.
NVIDIA Developer Program membership is free; no card.

**Verify with `npm run nim:smoke`** (`services/sentinel/scripts/smoke-nvidia-nim.ts`) —
prints resolved config, calls all three tiers, embeds a query+passage pair, and runs the
news classifier against four headlines with known labels. Fails fast with instructions
when the hosted base URL is set but the key is empty. No DB or Nest boot required.

## 1b. Choosing a NIM model — measure, never assume (measured 2026-07-23)

Same key, same endpoint, same prompts. **Latency is not predicted by parameter count**
and the catalog shows none of this. Tool calling matters as much as speed: the agent
runtime (`agents/impl.ts`) loops on `stopReason === 'tool_use'`, so a model that cannot
emit `tool_calls` cannot drive a TradeW AI agent at all.

| Model | Latency | Tool calls | Verdict |
|---|---|---|---|
| `meta/llama-3.1-8b-instruct` | 0.3–6.7s | ✅ | **fast tier** — best speed/capability point tested |
| `nvidia/llama-3.3-nemotron-super-49b-v1` | 1.5–15s | ✅ | **balanced + deep** |
| `google/diffusiongemma-26b-a4b-it` | ~200–290s, intermittent 504 | not tested | deep only, opt-in |
| `meta/llama-3.2-3b-instruct` | 15s warm, **2 of 4 calls timed out at 90s** | ❌ never responded (240s, 0 bytes) | **do not use** |

The 3B was the original `fast` default and is the trap here — the smallest model was both
the slowest *and* the only one that failed outright. `fast` is the workhorse tier (every
Sentinel agent, the orchestrator, the explain service, the brain and the news classifier
all run on it), so that default was a latent outage. Changed to the 8B on 2026-07-23.

`diffusiongemma` is a 26B **diffusion** LLM (262K ctx, text+image+video in) whose selling
point is parallel token generation — but the *free* endpoint is queued so heavily that the
architectural advantage is invisible. Never put it on a latency-sensitive path.

Three quirks cost real debugging time, all now handled in `openai-compatible.ts`:

1. **Reasoning arrives in a sibling field.** NIM's vLLM build returns the chain-of-thought
   in `message.reasoning` (other stacks use `reasoning_content`, others inline `<think>`).
   `splitReasoning()` normalizes all three into `CompletionResponse.reasoning`, keeping
   `.text` clean — Sentinel must never render a model's private reasoning.
2. **Thinking is billed out of `max_tokens`.** With `enable_thinking: true` and
   `max_tokens: 200`, the visible answer came back truncated mid-word — the trace ate the
   budget. NVIDIA's own snippet defaults to 4096 for exactly this reason.
3. **`response_format: {type:'json_object'}` returns 400.** vLLM demands a `json_schema`
   or `guided_json`. `jsonModeStrategy: 'omit'` drops the flag for NIM and leans on the
   prompt. Anything relying on `jsonMode` for hard guarantees needs a schema instead.

`chat_template_kwargs` is safe to set provider-wide — all three llama models accept and
silently ignore it (verified 200 OK).

## 2. Facts that shape usage

- **Rate limits, not credits.** The practical shared ceiling reported by NVIDIA staff is
  ~40 req/min, varying by model and overall catalog traffic; the per-model number is not
  published. Design Sentinel batch work around this — `classifyBatch` already takes a
  concurrency argument (the smoke test passes 2).
- **Embedding dimensions are safe to change.** `MemoryRecord.embedding` /
  `ConceptNode.embedding` are `Unsupported("vector")` with **no fixed dimension**, and
  `embeddingModel`/`embeddingDim` are stored per row so mixed-provider vectors are never
  compared. Switching to `nv-embedqa-e5-v5` (1024) needs **no migration** — but rows
  embedded by a different model must be re-embedded before they are comparable.
- **A NIM base URL with no key is a silent 401 at call time**, not a startup error: the
  provider registers on base-URL alone (correct — self-hosted NIM needs no key). This is
  exactly the case the smoke test guards.
- **Self-hosted NIM uses the same code path.** Point `NVIDIA_NIM_BASE_URL` at a deployed
  NIM (including a NeMo Data Flywheel student model) and leave the key empty.

## 3. Agent Skills (development only)

`github.com/nvidia/skills` — 200+ NVIDIA-verified Agent Skills (cuOpt, cuDF, NeMo
AutoModel, Megatron-Core, TAO, Holoscan, DeepStream, Jetson, RAG blueprints). Apache-2.0
code / CC-BY-4.0 docs. Install with `npx skills add nvidia/skills`, optionally
`--skill <name> --yes`.

Relevant to TradeW only where we would actually use the underlying SDK — today that is
**none of them**, because no TradeW service runs CUDA, cuDF, or NeMo locally. Revisit if
the flywheel distillation in `docs/ai/DISTILLATION.md` is ever run in-house, or if
backtesting moves to GPU dataframes. Installing unused Skills only costs context.

## Related
- [[Research/2026-07-17 - Sentinel Brain audit]] — the Brain is real, gaps are operational
- [[Decisions/2026-07-21 - Sentinel Concept Knowledge Graph (living ontology)]] — the other
  embedding-bearing table (`ConceptNode`), same dimension-flexible design
- `docs/ai/DISTILLATION.md` — the NVIDIA blueprint TradeW ported

## Sources
- https://build.nvidia.com
- https://github.com/nvidia/skills
- https://docs.nvidia.com/skills
