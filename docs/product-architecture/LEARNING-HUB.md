# Learning Hub — Product Blueprint

Status: design, pre-implementation. New 4th product pillar, added by the Genesis v2 brief. Extends the three-pillar model in [`README.md`](README.md) — does not replace it.

## 1. Why this is a separate pillar, not a Sentinel feature

Sentinel is behavioral/structural risk on the user's *own* trading. Learning Hub is general trading education — concepts, price action, indicators, psychology, backtesting, case studies — independent of any one user's live behavior. Different question ("teach me X" vs "am I about to make a mistake"), different content lifecycle (authored/generated once, consumed by everyone, vs per-user real-time observation), different monetization (one lifetime SKU vs a subscription tier). It gets its own nav-level workspace, same as Research and Sentinel — not a tab inside either.

## 2. Content taxonomy

Trading Basics · Advanced Concepts · Price Action · Indicators · Market Structure · Risk Management · Psychology · Backtesting · Historical Case Studies · News Analysis · Interactive Lessons · Concept Maps · Learning Paths (ordered lesson sequences) — plus cross-cutting Progress Tracking, Bookmarks, and Search over all of the above.

## 3. Where content comes from

Learning Hub does not author content ad hoc. It is the **subscriber-facing surface** of the [Continuous Learning Pipeline](CONTINUOUS-LEARNING-PIPELINE.md): every lesson traces back to a validated node in the [Knowledge Graph](KNOWLEDGE-GRAPH.md) (a Concept, Historical Example, or Backtest outcome). This is what makes "continuously updates itself" (per the brief) safe — nothing gets published as a lesson until the pipeline's Validation Engine has scored it, exactly like nothing enters permanent Knowledge Graph memory unvalidated.

```
Knowledge Graph (validated Concept/Lesson node)
        │
        ▼
Lesson Generation (services/tradew-ai, existing agent roster — no new LLM runtime)
        │
        ▼
Learning Hub content store (new tables, services/api)
        │
        ▼
Learning workspace UI (apps/web)
```

## 4. Data model (owned by `services/api`, new tables)

| Table | Purpose |
|---|---|
| `lessons` | title, body (structured, not raw markdown blob — needs to render concept maps/interactive elements), source Knowledge Graph node id, published_at, version |
| `learning_paths` | ordered lesson sequences, difficulty tier |
| `learning_progress` | per-user completion state, resumes across sessions |
| `learning_bookmarks` | per-user saved lessons |

Superseded lesson versions are archived, never deleted — same "archive, version, improve, reconnect" rule as the Knowledge Graph (§4 there), because a lesson's provenance must stay traceable.

## 5. Entitlement

Lifetime Access, ₹299, one-time — see [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md) §2. Entitlement check happens at `services/api` (same chokepoint pattern as Sentinel's trial/upgrade gate) before serving lesson bodies; lesson *listing*/previews can stay free to browse, matching the existing "always see Sentinel nav, gated content behind it" pattern from the brief.

## 6. Non-goals

No trade recommendations, no "this pattern means buy now" framing — a Historical Case Study explains what happened and why, in the same observation-only voice as TradeW AI (`TRADEW-AI.md` §4). Learning Hub is education, not a signal service.

## 7. Data dependencies

- `services/tradew-ai` — lesson generation/synthesis (reuses existing agent runtime, no new AI service)
- Knowledge Graph (validated nodes) — see `KNOWLEDGE-GRAPH.md`
- `services/api` — new `lessons`/`learning_paths`/`learning_progress`/`learning_bookmarks` tables, entitlement gate
