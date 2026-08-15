# The AI Operating System — Product Blueprint

Status: **specification, pre-implementation.** Supersedes nothing; extends
[`TRADEW-ASSISTANT.md`](TRADEW-ASSISTANT.md) from "a floating assistant that can
navigate" to the eight-layer system described below. Binding for all assistant
work from here, per workspace Rule 2.

> **The one-line brief.** TradeW's AI is not a chat window bolted onto a trading
> app. It is an operating layer *over* the product: you speak or type in
> ordinary language, and it drives the application the way a competent human
> colleague sitting at your keyboard would — including the chart itself —
> while explaining as much or as little as you want and stopping to ask before
> anything that matters.

---

## 1. Why this document exists

`TRADEW-ASSISTANT.md` specified an assistant that resolves an utterance to a
route and opens it. That has shipped and works (`apps/web/src/lib/assistant/`).
It is also, structurally, a command line with a nicer font: one utterance in,
one action out, no memory, no plan, no ability to touch the chart, and no
concept of an action being risky.

The target is different in kind, not degree. Eight layers, each with a distinct
job:

```
   ┌──────────────────────────────────────────────────────┐
 8 │ SAFETY          confirm before anything consequential │  ← wraps everything
   ├──────────────────────────────────────────────────────┤
 7 │ NARRATION       teaching mode / silent mode           │
   ├──────────────────────────────────────────────────────┤
 6 │ VOICE           speech in, spoken or silent ack out   │
   ├──────────────────────────────────────────────────────┤
 5 │ MEMORY          your indicators, layout, chart mode   │
   ├──────────────────────────────────────────────────────┤
 4 │ CHART AGENT     indicators, timeframes, drawings,     │
   │                 series type, zoom, capture            │
   ├──────────────────────────────────────────────────────┤
 3 │ EXECUTION       run the plan against the real app     │
   ├──────────────────────────────────────────────────────┤
 2 │ PLANNER         decompose a request into ordered steps│
   ├──────────────────────────────────────────────────────┤
 1 │ CONVERSATION    understand what was actually asked    │
   └──────────────────────────────────────────────────────┘
```

Layer 8 is drawn on top because it is not a step in the pipeline — it is a gate
every layer below passes through before touching anything.

---

## 2. Ground truth — what exists on 2026-08-11

Verified by reading the code, not by reading older docs. This table is the
honest starting line; percentages are deliberately absent because "40% done" is
a feeling, not a fact.

| Layer | Exists today | Gap |
|---|---|---|
| 1 Conversation | Deterministic regex/alias resolver (`assistant/router.ts`, `commands.ts`, `instruments.ts`, `quotes.ts`). Handles capability questions, navigation, panels, layouts, theme, contracts, quote lookups. Refuses advice/orders/out-of-domain. | No natural-language understanding. "Compare my journal today with yesterday" matches nothing. No conversational context — every utterance is resolved from scratch. |
| 2 Planner | **None.** One utterance → one plan → a flat `actions[]` executed in order. | No decomposition, no multi-step, no dependency between steps, no partial failure handling. |
| 3 Execution | `useAssistant.executeAction` — exhaustive switch over `AssistantAction`, deliberately no order-placement variant. Now includes the one async action (`quote`). | Actions are workspace-level only. Nothing can reach into a chart. |
| 4 Chart agent | `components/charts/TradeChart.tsx` wraps `lightweight-charts`. Chart state is component-local. | No programmatic control surface at all. The assistant cannot change a timeframe, add an indicator, draw, or read what is on screen. |
| 5 Memory | `workspaceStore` persists layout/theme/panels via zustand `persist` + `partialize`. | Not assistant-aware. No preference learning, no "my usual setup", no per-symbol recall. |
| 6 Voice | `assistant/useVoiceInput.ts` — Web Speech API, `en-IN`, transcript → same resolver. Shipped 2026-08-11. | Input only. No spoken acknowledgement, no continuous/wake mode, no barge-in. |
| 7 Narration | The Comet-style `steps[]` trace on every plan. | Always on, one verbosity. No teaching mode, no silent mode. |
| 8 Safety | Hard boundaries in `domain-guard.ts` (orders, advice, Sentinel's reasoning, out-of-domain) — these **refuse**. | Nothing **confirms**. There is no notion of an action that is allowed but consequential. |
| LLM runtime | `packages/ai-core` — 31 modules: `agents/`, `brain/`, `context/`, `domain/`, `graph/`, `memory/`, `news/`, `prompts/`, `providers/`, `rag/`, `research/`, `telemetry/`, `tools/`. `ANTHROPIC_API_KEY` configured. | `services/tradew-ai` is an **empty stub** — zero `.ts` files. Nothing exposes `ai-core` to `apps/web`. |

**The headline:** the two hardest pieces already exist in some form — a real
LLM/RAG/memory library (`packages/ai-core`) and a proven deterministic command
layer. What is missing is the spine that connects them, and the chart control
surface.

---

## 3. Layer 1 — Conversation

**Job:** turn what a person said into a structured intent, using conversation
history and the state of the screen.

The current resolver is not replaced. It becomes the **fast path**:

```
utterance
   │
   ├─ deterministic resolver hits?  ──► intent   (0ms, no cost, no network)
   │
   └─ miss ──► conversation brain (LLM, packages/ai-core) ──► intent
```

This ordering is the single most important design decision in the document, and
it is inherited from `TRADEW-ASSISTANT.md` §2's original reasoning: "open the
option chain" must never cost a model round-trip. Roughly the top twenty
utterances by frequency are navigation, and they should stay instantaneous and
free. The brain exists for everything else — and "everything else" is where the
user's actual examples live ("compare my journal today with yesterday").

**Context the brain receives** (read-only, assembled client-side):
active route, selected symbol, visible panels, chart state (§6), recent turns,
and the user's stored preferences (§7). Not: positions, order history, or
anything from Sentinel's premium reasoning.

**Non-goal:** the brain never emits prose that interprets the market. It emits a
*plan*. Interpretation is the analysis agents' job and carries their guardrails.

---

## 4. Layer 2 — Planner

**Job:** decompose one request into an ordered, inspectable list of steps.

"Open the NIFTY chart on 15 minutes with VWAP and my usual layout, then compare
my journal today with yesterday" is one sentence and six actions. The planner's
output is a first-class object the user can see before it runs:

```ts
interface AssistantPlanV2 {
  goal: string;              // restated in the user's own terms
  steps: PlanStep[];
  risk: 'none' | 'confirm';  // §10
}

interface PlanStep {
  id: string;
  describe: string;          // "Switch NIFTY to the 15-minute timeframe"
  action: AssistantAction;
  dependsOn?: string[];      // ids — a step may need an earlier one to land
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
}
```

**Partial failure is normal and must not be silent.** If step 4 of 6 fails, the
remaining independent steps still run and the transcript says exactly which one
failed and why. A plan that half-executed while reporting success is worse than
one that refused to start.

---

## 5. Layer 3 — Execution

Unchanged in principle, extended in surface. `AssistantAction` stays a closed
union with an exhaustive switch, because that is what makes "the assistant
cannot place an order" a compile-time property rather than a promise. New
variants arrive for chart control (§6) and preferences (§7).

**The rule that does not move:** there is no `placeOrder` / `modifyOrder` /
`cancelOrder` variant, and adding one is not a feature request this document
entertains. `ARCHITECTURE.md` §1 and §4 make it structural.

---

## 6. Layer 4 — The chart agent

**Job:** operate the chart as a first-class surface, not as a page you navigate
to.

This is the largest net-new piece. `TradeChart.tsx` currently owns its state
privately; it needs an imperative control surface the execution layer can call:

| Capability | Example utterance |
|---|---|
| Timeframe | "make it 15 minutes", "go to daily" |
| Series type | "show me Heikin Ashi", "switch to line", "back to candles" |
| Indicators | "add VWAP", "put a 20 and 50 EMA on", "drop the RSI" |
| Drawings | "draw a trendline from the morning low", "mark that level", "clear my drawings" |
| Navigation | "zoom in", "go back a week", "fit everything" |
| Comparison | "overlay BANKNIFTY", "compare against SENSEX" |
| Capture | "what's on my screen right now" |

**Reading the chart — two mechanisms, and the choice matters:**

1. **Structured read.** The chart reports its own state as JSON: symbol,
   timeframe, series type, active indicators and their parameters, visible
   range, drawings, and the OHLCV in view. Cheap, exact, no image tokens, and
   the model cannot hallucinate a level that is not in the data.
2. **Visual capture.** A screenshot of the canvas passed to a vision model.
   Handles anything — including drawings, annotations and layout — but costs
   image tokens per call and can misread axes.

> **Decided 2026-08-11: both, on every read.** Structured state *and* a capture
> travel together. The structured half is authoritative for anything numeric —
> a price, a level, an indicator value must be read from the JSON, never from
> the image — and the capture carries what the JSON cannot: drawings, layout,
> annotations, and how the thing actually looks. Where they disagree about a
> number, the JSON wins and the discrepancy is a bug to log, not to average.
>
> The cost is real (image tokens on every chart read) and accepted deliberately
> for capability. If it becomes a problem the mitigation is to make the capture
> conditional, not to make the structured half optional.

**Sentinel over the visible chart.** Once the chart can describe itself,
Sentinel's existing engines can be pointed at exactly what the user is looking
at. This does **not** loosen Sentinel's contract: still observation-only, still
never a gate on the order flow, still entitlement-gated, still evidence →
pattern-name → soft suggestion (`SENTINEL.md` §3).

---

## 7. Layer 5 — Memory

**Job:** stop making the user say the same thing twice.

Three distinct kinds, deliberately separated — conflating them is how memory
systems become unpredictable:

| Kind | Example | Store | Lifetime |
|---|---|---|---|
| **Preferences** | "I always want VWAP and a 20 EMA", "dark mode", "my usual layout" | `workspaceStore` persist (extended) | Until changed |
| **Session context** | "it" / "that level" / "the same on BANKNIFTY" | In-memory, per dock session | Until the dock resets |
| **Durable recall** | "the setup I looked at last Tuesday" | Postgres, via `services/api` | Account lifetime |

**Preferences are learned by asking, never by inference.** If someone adds VWAP
three times, the assistant may *offer* to remember it — it does not silently
start applying it. An assistant that changes your workspace based on a pattern
you never confirmed is indistinguishable from a bug.

**This is not Sentinel's Brain.** Sentinel's Postgres + pgvector Persistent
Knowledge Brain holds trading-domain memory and stays separate, exactly as
`knowledge/Decisions/2026-07-17 - Obsidian Knowledge Layer adopted.md` requires.

---

## 8. Layer 6 — Voice

Input shipped 2026-08-11 (`useVoiceInput.ts`, Web Speech API, `en-IN`, on-device).
Remaining:

- **Spoken acknowledgement**, governed by the narration mode (§9) — teaching
  mode speaks, silent mode does not.
- **Continuous mode** for hands-on-chart work, where "zoom in", "go back",
  "add VWAP" arrive in a stream without re-tapping the mic.
- **Barge-in**: speaking must interrupt a spoken reply, not queue behind it.

Voice is an input *modality*, never a separate capability set. Anything sayable
is typeable and vice versa — one grammar, one resolver, one set of boundaries.

---

## 9. Layer 7 — Narration modes

Three settings, remembered per user (§7):

| Mode | Behaviour |
|---|---|
| **Teaching** | Explains each step before and after: *"Adding VWAP — it's a volume-weighted average price, so it shows where the average participant is positioned today."* Optionally spoken. |
| **Normal** *(default)* | Today's Comet-style trace: what it did, one line per step, no tutoring. |
| **Silent** | Does the work, no commentary. The trace is still recorded and inspectable on demand — silent means "don't narrate", never "don't log". |

Silent mode must not silence the safety layer. A confirmation prompt is not
narration.

---

## 10. Layer 8 — Safety

Today's `domain-guard.ts` handles **refusal** — things the assistant will never
do. This layer adds the missing middle: things it *will* do, but not without
asking.

| Tier | Rule | Examples |
|---|---|---|
| **Free** | Execute immediately | navigate, quote lookup, add an indicator, change timeframe, zoom |
| **Confirm** | Show the plan, require an explicit yes | clearing drawings, replacing a saved layout, overwriting a stored preference, closing panels with unsaved state, anything with ≥5 steps, anything that navigates away from a filled order ticket |
| **Refuse** | Never, at any tier | place/modify/cancel an order, trade advice, price targets, relaying Sentinel's premium reasoning, out-of-domain |

**The confirm tier is computed from the plan, not from the utterance.** Intent
is easy to phrase innocently; a plan is a list of concrete actions and can be
inspected. The gate reads the plan.

**Destructive-by-omission is still destructive.** "Set up my scalping view"
that quietly discards existing drawings is a confirm-tier action even though
nobody said "delete". This mirrors workspace Rule 1's posture toward the
codebase: superseded state is replaced only deliberately, never as a side
effect.

---

## 11. Boundaries this document does not move

Restated because a system this capable is exactly where they erode:

1. **No AI-initiated orders.** No layer here can place, modify or cancel one.
   Not with confirmation, not with a setting, not as a "power user" mode.
2. **Observation, never advice.** The chart agent reports and Sentinel observes.
   Neither issues entries, exits or targets.
3. **Sentinel is never a gate.** It comments in parallel with the order flow and
   cannot block or delay it (`SENTINEL.md` §5).
4. **Entitlement-scoped.** The assistant can only reach what this user can reach;
   a gated feature resolves to the normal upgrade surface, never a dead command
   and never a bypass (`TRADEW-ASSISTANT.md` §5).
5. **No fabricated data.** Every number carries its provenance. See
   `knowledge/Patterns/2026-08-11 - Landing page as decision brief + mascot as
   shared agent identity.md` §6 for the two-market-data-clients trap that makes
   this concrete.

---

## 12. Build order

Sequenced so each phase is independently useful and independently revertible
(workspace Rule 3 — no big-bang commits). Every phase ships with tests.

| Phase | Delivers | Depends on |
|---|---|---|
| **1** | Safety tiers + confirmation UI · narration modes · preference memory · multi-step planner over the **existing** deterministic grammar | nothing — all client-side |
| **2** | Chart control surface: imperative API on `TradeChart`, structured self-report, new `AssistantAction` variants | Phase 1 |
| **3** | Conversation brain: `services/tradew-ai` stood up over `packages/ai-core`, reached through `services/api` per `ARCHITECTURE.md` §1; LLM fallback behind the deterministic fast path — **decided 2026-08-11: the real service, not a Next route handler.** The app already carries one ingress deviation (the Dhan feed bridge); a second, for the component that reaches an LLM with the user's context, is the wrong place to save a day's work | Phase 1 |
| **4** | Sentinel over the visible chart; durable recall in Postgres | Phases 2 + 3 |
| **5** | Voice output, continuous mode, barge-in | Phase 1 (modes) |

Phase 1 is deliberately first and deliberately LLM-free: it is the spine every
later phase plugs into, it needs no key, no service and no network, and it makes
the system safer before it makes it more capable — which is the correct order
for anything that touches a trading workspace.
