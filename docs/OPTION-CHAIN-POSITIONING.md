# Reading the option chain as a battlefield map

**Implemented by** `services/sentinel/src/execution/option-positioning.ts`.
**Consumed by** gate 5 of the agent evaluation, all ten reasoning agents (via the shared context), and the deliberation round.

---

## 0. The one idea

> **PCR is not a BUY/SELL indicator. The option chain is a map of where participants have money at risk. Price action tells you whether those levels are being accepted or rejected.**

Everything below follows from that. A level on its own is a number that is true on every day of the week and useful on none of them. A level plus *what its defenders did today* is a statement about what is happening now.

---

## 1. What the chain could say before, and what it says now

`readOptionChain` — the pre-existing read — answers **where the open interest is**: PCR, max pain, the heaviest call strike above spot, the heaviest put strike below it.

That is a snapshot, and a snapshot is the weakest thing a chain has to say:

```
   66.04L call OI at 24,100, being ADDED to      ─┐
                                                  ├─ identical in a snapshot
   66.04L call OI at 24,100, being UNWOUND       ─┘   opposite in meaning
```

`readOptionPositioning` reads the same chain with the **previous close's open interest beside it**. The bridge's `/optionchain` body already carried `previous_oi` and `previous_close_price` per leg; the engine was dropping both, so this costs one extra read of a call that was already being made.

---

## 2. The four-quadrant read

Per leg, from the signs of ΔOI and Δpremium:

| ΔOI | Δpremium | Action | On a CALL strike | On a PUT strike |
|---|---|---|---|---|
| ↑ | ↑ | `long-buildup` | buyers arriving | buyers arriving |
| ↑ | ↓ | `fresh-writing` | **resistance defended harder** | **support defended harder** |
| ↓ | ↑ | `covering` | **resistance being removed** | **support being removed** |
| ↓ | ↓ | `long-unwinding` | buyers leaving | buyers leaving |

Two floors keep this from being noise: ΔOI must clear **3%** of the leg's own open interest, and Δpremium **2%** of the previous close. An index chain prints small adjustments on every strike all day, and without the floors a 0.3% drift on a 70-lakh wall gets the same vocabulary as a genuine unwind.

When the premium is missing but ΔOI is not, the read falls back to the half that survives — OI up is money arriving on the defensive side, OI down is money leaving — because on an index chain the marginal open interest overwhelmingly is writing.

---

## 3. The ladder

Levels are ranked **by open interest** to decide which strikes matter, then re-ordered **by distance from spot** so the consumer walks them in the order price would meet them. Both orderings are needed and they are not the same: the heaviest resistance in the chain is frequently not the first one price has to get through.

Each rung carries `reinforcing`, `eroding` or `steady`, from what its defenders did today, and `unknown` when the feed published no previous OI.

Worked from a real NIFTY chain at spot ≈ 23,986:

```
   24,250   CE 22.02L / PE 5.63L      ← resistance
   24,200   CE 74.69L                 ← the heaviest strike in the chain
   24,100   CE 66.04L                 ← resistance
   24,050
   24,000   CE 57.62L / PE 57.51L     ← PIVOT — the two sides are level
   ─────────── spot 23,986 ───────────
   23,950   PE 69.00L                 ← support
   23,900   PE 63.00L                 ← support
```

The **pivot** is the most evenly-matched strike within two steps of spot: the level that is neither support nor resistance yet, and therefore the one whose acceptance or rejection is actually informative. Searching further out would return a strike that is balanced only because nobody has positioned there.

---

## 4. Migration — where the whole book moved

Measured as the shift in each side's **OI-weighted centroid** between the previous close and now, in strike steps. Centroids rather than wall positions because a wall is one strike and jumps discontinuously; a centroid moves continuously and therefore says something on a day when the heaviest strike has not changed hands yet.

| call centroid | put centroid | Read |
|---|---|---|
| ↑ | ↑ | `up` — the whole book re-laid higher |
| ↓ | ↓ | `down` — the whole book re-laid lower |
| ↓ | ↑ | `compressing` — both sides moved in; the defended range is narrowing |
| ↑ | ↓ | `expanding` — both sides moved out; the range is widening |

`compressing` and `expanding` are **explicitly not directional** and score zero in the judgement. Treating a tightening range as bearish for a call was the single easiest available way to make this gate wrong.

---

## 5. The judgement — agreement, never a direction

`judgePositioning(read, side)` takes the side **as an argument**. It has no way to invent one, and that is what keeps it a confirmation gate rather than a second, quieter signal generator sitting beside the first.

Four weighted signals, each in −1…+1 signed toward the side asked about:

| Signal | Weight | For a CE side |
|---|---|---|
| `defence-ahead` | 0.30 | resistance ahead eroding **+** / reinforcing **−** |
| `defence-behind` | 0.25 | support behind reinforcing **+** / eroding **−** |
| `migration` | 0.25 | book migrating up **+** / down **−** |
| `headroom` | 0.20 | ≥1.5 steps of clearance **+** / <0.5 steps **−** |

For a PE side every one mirrors. Score ≤ **−0.30** → `conflicts`; ≥ **+0.20** → `confirms`; between → `neutral`.

### The load-bearing property

**A chain that publishes no previous-day OI cannot produce a refusal.** Three of the four signals become unknowable and contribute zero; only `headroom` survives, at weight 0.20, against a −0.30 threshold. A missing feed field degrades the read; it never halts an agent. That relationship is pinned by a test — if `headroom`'s weight is ever raised above the conflict threshold, the property breaks silently.

---

## 6. The conditional ladder

`buildLadder(read, direction, projectedLevel?)` turns the map into an ordered path: the level that has to hold, the pivot that has to be reclaimed, each defended level that has to be accepted, and — only if the caller supplies one — a projected level at the top.

Every rung carries **what would confirm it** and **what would invalidate it**, in the chain's own terms. For a bullish path through 24,100:

> **Confirms** — price trades through 24,100 while call open interest there *falls* (writers covering rather than reinforcing) and put open interest at the same strike rises.
>
> **Invalidates** — price reaches 24,100 and call open interest there *increases* while put open interest does not build. The level absorbed the move.

The function **never invents a projected level**. A projected level is a forecast, and nothing in an option chain produces a forecast. Pass one in or get a ladder without a top rung.

This is what replaces "my objective is 24,500, so I'll hold until 24,500" with a sequence that can be invalidated at each step — which is the difference between a plan and a prediction.

---

## 7. Where it is wired

**Gate 5 of the agent evaluation.** After the chain check (it needs the chain) and before strike selection (no point pricing a contract for a direction the book disagrees with). It refuses only on a positive `conflicts` — never on the absence of agreement — with verdict `positioning-conflict`, and the map is attached to the refusal, because "why did nothing trade?" is a question about the levels.

**The shared agent context.** Computed once per run in `composeSharedState` and handed to all ten reasoning agents, for the same reason the market snapshot is: ten agents each deriving positioning from the same chain would be ten copies of one arithmetic, and a strategy read quoting different levels from the options read *inside one run* would be a fake conflict the cross-checker could not tell from a real one.

**The deliberation round.** Once the desk has settled on a direction, the options agent judges the book against *that* direction and reports `risk-elevated` — never the opposite direction — when it does not corroborate. A book disagreeing with a bullish structure is not a bearish read of the book; it is a statement that the structure is heading into defended ground. The risk agent independently raises the environment on the same finding, which is a fact no single agent's inputs contain: it is the join of the desk's lean and the chain's defended levels.

**The intent and the journal.** Both persist the book at decision time, because `previous_oi` is overwritten every morning and the post-mortem that matters most is otherwise the one you cannot run.

---

## 8. Compliance

Every string this module can emit reaches a trader through the options-chain agent's verdict, so all of them are written to survive `vocabulary.ts` **unchanged** rather than be rewritten downstream. A level is *defended*; a move through it is *accepted* or *rejected*; the top of a ladder is a *projected level*. No directive verbs, no "target", no bare "short" — `option-positioning.spec.ts` asserts this over every summary, note, signal detail and ladder rung the module can produce.
