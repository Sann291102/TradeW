# Plan: Real-Time Correctness, and a Guided Strategy Builder

**Status:** proposed, not started · **Written:** 2026-08-15
Companion to `PLAN.md` (overall ledger), `ARCHITECTURE.md`, `PRODUCT.md`.

Two tracks. Track A makes what the user sees match what is actually
happening. Track B makes writing your own strategy as expressive as adopting
one, with help — without letting the helper become the thing that decides.

---

## Track A — Real-time correctness

### A0. The timeline complaint, diagnosed

"The timeline panel is not matching real time" is not one bug. There are
**two different timelines on the Sentinel screen**, fed by two different
services, and the one that looks most like a timeline is the one that knows
nothing about the user's strategy.

| Panel | Source | Refresh | Shows |
|---|---|---|---|
| **Session Timeline** (dashboard band) | `services/sentinel` (TS, 4010) `/observe` → `dashboardModel.timeline()` | **45 s** (`useSentinel.ts` `POLL_MS`) | The TS service's own market narrative |
| **Lifecycle** (in "Your strategies") | `services/sentinel-py` contract `lifecycle` | 10 s | The user's own watch |

So a user watching their strategy and reading "Session Timeline" is reading
**a different service's market commentary, refreshed every 45 seconds**. It
will never match their strategy's state, because it is not about their
strategy.

That is the first thing to fix, and it is a product decision, not a latency
tweak.

### A1. Latency, measured rather than assumed

Current worst case from "the market did it" to "the user sees it":

```
candle closes
  → up to 15 s   sweep interval (SENTINEL_PY_SWEEP_SECONDS)
  → up to 10 s   contract poll (SelectedStrategyPanel)
  ≈ 25 s         in-page lifecycle
  → up to 30 s   notification poll (NotificationSync)
  ≈ 45 s         notification
```

Plus a subtler one: events are stamped with **`createdAt` (when the sweep
ran)**, not `candleTime` (what the event is about). An event about the 09:30
candle can be displayed as 09:31:12. On a 15-minute strategy that reads as
"the panel is behind".

### A2. Fixes, in order

| # | Fix | Why it matters | Cost |
|---|---|---|---|
| **A2.1** | **Decide what "Session Timeline" is for.** Either scope it to the selected strategy, label it unmistakably as market commentary from the other service, or remove it from this screen. | Two timelines that disagree is worse than one. This is the actual complaint. | S — product decision + small UI change |
| **A2.2** | **Display `candleTime`, not sweep time.** Show the bar the event is about; keep sweep time as a secondary "checked at". | Removes the apparent lag that is really a labelling error. | S |
| **A2.3** | **Show a live "last checked" indicator.** `dataStatus.checkedAt` already exists in the contract and is not rendered. | The user can see the engine is alive, rather than inferring it from silence. | S |
| **A2.4** | **Align the poll to the candle boundary.** Sweeping at :00/:15/:30/:45 + a few seconds instead of every 15 s regardless. | A 15-minute strategy currently gets evaluated 60 times per bar, 59 of them pointless, and the one that matters can be up to 15 s late. | M |
| **A2.5** | **Drop the in-page poll to ~5 s while a watch is not IDLE.** | Cheap; the contract call is one query. | S |
| **A2.6** | **WebSocket push** (issue #7) — replaces polling for both lifecycle and notifications. | Takes worst case from ~45 s to ~1 s. | L |

**Recommended order: A2.1 → A2.2 → A2.3 → A2.4, then re-measure.** A2.6 is
the real fix but it is also the largest, and A2.1–A2.4 may well resolve the
perceived problem — much of which is labelling, not latency.

### A3. What must not change

- Only **closed** candles are evaluated. Faster polling must not become
  "evaluate the forming bar", which would turn every wick into a breakout.
- Repeated state still collapses to one feed entry. Faster polling must not
  produce more cards.
- No event may be shown that did not come from a recorded `WatchObservation`.

---

## Track B — Guided strategy builder

### B0. The gap

The evaluator implements ~25 primitives. **The parser understands five**, all
from the opening-range family. Measured:

```
'EMA 7 reclaim with volume'                → volume_confirm only
'9/21 EMA pullback then continuation'      → retest   ← a WRONG rule
'VWAP bounce on the second test'           → nothing
'sweep of the lows then a fair value gap'  → nothing
```

So a user who writes their own strategy can only express ORB variants, while
the catalogue offers ten. The second line is worse than a gap: "pullback"
matches the retest pattern, so the user is handed a rule they did not
describe. It is reported in the leftover warning, so it is not silent — but
it is still wrong.

### B1. What to build

**B1.1 — Extend the deterministic parser to the primitives that already
exist.** EMA (period, slope, reclaim, pullback), VWAP (bounce, test ordinal,
deviation), levels (support/resistance, flip), zones, liquidity. Plus
disambiguation, so "pullback" near "EMA" is not a retest.

This has a self-checking specification: **parse `"9/21 EMA pullback"` and
assert it produces the same rules as adopting `ema_9_21_pullback`.** Each of
the ten catalogue templates becomes a target the parser must be able to reach
from natural language.

**B1.2 — An assisted path, on top of the parser and never instead of it.**

```
user types their strategy
        ↓
deterministic parser  →  rules + warnings + "not understood" list
        ↓
   anything unclear?
        ↓ yes
assistant proposes a completion:
   "You said 'pullback' near 'EMA' — did you mean price returning to
    the 9 EMA, or a retest of a broken level?"
   [ EMA pullback ]  [ Level retest ]  [ Neither — leave it out ]
        ↓
user chooses / edits / ignores
        ↓
UNDERSTOOD  →  save  →  same UserStrategy, same watch pipeline
```

### B2. Rules the assistant must obey

These are not optional. The deterministic parser is a compliance and
auditability guarantee (`PRODUCT.md` principles 1 and 6), and an LLM in the
wrong place dissolves it.

| Rule | Reason |
|---|---|
| **The assistant proposes; it never saves.** Every suggestion is rendered as a choice the user accepts, edits or rejects. | "Sentinel watches what you told it" must stay literally true. |
| **What is saved is always deterministic rules.** The assistant's output is a *suggested edit to the text*, or a *choice among known primitives* — never a rule set the parser cannot re-derive. | Re-parsing an edited strategy must not drift. An LLM-authored rule set is not reproducible. |
| **It may only propose primitives the evaluator implements.** | Otherwise it invents a strategy that can never fire. |
| **It never proposes a direction, stop, target or instrument.** It may ask; it may not fill in. | Principle: never invent. |
| **Its output passes the same compliance guard.** | A suggestion is a user-facing surface. |
| **"Continue with my own wording" is always available and never discouraged.** | The user's strategy is the product. |
| **Availability is graceful.** No LLM configured → the deterministic path works exactly as now, minus the suggestions. | The service must not depend on a model to function. |

### B3. Why not simply parse with an LLM

It would be less code and more coverage, and it would break three things:

1. **Determinism.** The same text must always produce the same rules. The
   user confirms a parse, and a later re-parse of an edited strategy must not
   silently produce something different.
2. **Auditability.** "Why did Sentinel alert me?" must be answerable by
   reading rules the user confirmed — not by re-running a model.
3. **The compliance posture.** A generative model that reads "buy above the
   high" and writes rules is a much harder thing to certify than a regex
   table that can be read in one sitting.

The assistant belongs at the point of **ambiguity**, not at the point of
**extraction**.

---

## Sequencing

```
A2.1  what is Session Timeline for      ← product decision, unblocks the complaint
A2.2  candleTime labelling
A2.3  last-checked indicator
        ↓
B1.1  parser breadth to 10 templates    ← largest correctness win, fully unblocked
        ↓
A2.4  candle-boundary sweep
        ↓
B1.2  assisted disambiguation
        ↓
A2.6  WebSocket push (issue #7)
        ↓
real Dhan candles                        ← still blocked on credentials
        ↓
News Research / Market Impact
```

**A2.1–A2.3 and B1.1 are all unblocked and can start immediately.** The real
Dhan validation (`PLAN.md` §4) remains blocked on credentials and still gates
News Research.

## Open questions for the product owner

1. **Session Timeline** — scope it to the selected strategy, relabel it as
   the other service's market commentary, or remove it from this screen?
2. **Assistant model** — which provider, and is a per-parse LLM call
   acceptable in the product's cost and latency budget?
3. **A2.4** — is 15 s sweeping worth replacing with candle-boundary
   scheduling now, or after WebSocket makes the question moot?
