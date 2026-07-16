# News-Event Model Distillation (NVIDIA blueprint) — how TradeW uses it

Reference: NVIDIA's **AI Model Distillation for Financial Data** blueprint
(`ai-model-distillation-for-financial-data`, NVIDIA-AI-Blueprints on GitHub;
runs on NeMo Microservices + the Data Flywheel).

## What the blueprint does

1. **Teacher labelling** — a large teacher model (Llama 3.3 Nemotron Super 49B
   on NIM) classifies financial news headlines into **13 event categories**:
   Analyst Rating, Price Targets, Earnings, Labour Issues, Mergers and
   Acquisitions, Dividends, Regulatory, Stock price movement, Credit Ratings,
   Products-Services, Product Approval, Guidance, OTHER.
2. **Data Flywheel distillation** — the teacher's labels become ground truth;
   NeMo customizes small student models (Llama 3.2 1B/3B, 3.1 8B) with LoRA
   fine-tuning and evaluates them by F1 against the teacher. With ~25K samples
   the 3B student approaches teacher-level F1 at a fraction of the cost.
3. **Student serving** — the winning student deploys as a NIM with an
   OpenAI-compatible endpoint.

## What lives in the TradeW codebase (already implemented)

- `packages/ai-core/src/news/news-event-classifier.ts` — the blueprint's
  teacher prompt (13 categories, priority rules, OTHER-by-default) and
  deterministic label standardization, running through the provider layer.
- `services/sentinel/src/intelligence/news-intelligence.service.ts` — pulls
  headlines from the MarketDataProvider, classifies them, persists `NewsEvent`
  rows, and contributes the `news_driven_volatility` signal to the Sentinel
  orchestrator.

The classifier is provider-agnostic: it uses whatever `AI_LLM_ORDER` resolves
to. No code references a specific model.

## How to plug in a distilled student model

The fine-tuning itself runs on NVIDIA infrastructure (GPU cluster / Brev with
NeMo Microservices) using the blueprint notebook — it is not part of this
monorepo. Once the student NIM is deployed:

```env
# services/sentinel/.env
AI_LLM_ORDER=nvidia-nim,anthropic          # student first for cheap fast-tier calls
NVIDIA_NIM_BASE_URL=https://<your-nim-host>/v1   # self-hosted NIM (or integrate.api.nvidia.com)
NVIDIA_NIM_API_KEY=<key-if-hosted>
```

The classifier calls the `fast` tier, which maps to `meta/llama-3.2-3b-instruct`
by default for the nvidia-nim provider (override via config when your
fine-tuned checkpoint has a custom name). Zero code changes.

## Data flywheel, TradeW-flavoured (future)

Classified `NewsEvent` rows accumulate in Postgres with `classifiedBy`
provenance. When enough volume exists, export request/response pairs in the
blueprint's flywheel format (headline → label) and re-run distillation to
produce the next student — the same continuous-improvement loop the blueprint
demonstrates, but fed by TradeW's own traffic.
