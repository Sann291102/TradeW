# Chapter 10 — Safety Nets

> Safety Nets are the behavioural half of Sentinel: the protections that observe what a trader is *doing* rather than what the market is doing.

**Status: 🟡.** Five behavioural detectors are 🟢 in `EmotionIntelligenceService`; two more live in `TrapIntelligenceService`. The limits, coaching, and personalisation layers are 🔵.

---

## 10.1 The premise

Every protection in this chapter rests on one claim:

> **A retail trader's largest, most repeatable losses come from a small set of recognisable behavioural patterns, and those patterns are visible in their own order history in real time.**

Not from bad analysis. Not from missing information. From doing a thing they already know is wrong, at a moment when knowing is not enough.

The five patterns, ranked by observed cost:

```
   1. REVENGE TRADING     re-entering immediately after a loss
   2. OVERTRADING         frequency far above the trader's own norm
   3. SIZE ESCALATION     position size doubling after a win or a loss
   4. FOMO ENTRY          entering after most of a move has happened
   5. AVERAGING DOWN      adding into a loss without a pre-set plan
```

Each is observable from `(timestamp, side, quantity, fillPrice, realizedPnl)`. No psychology, no self-report, no survey — just arithmetic on trades the user already made.

---

## 10.2 The intervention philosophy ⚖️

### 10.2.1 What we refuse to do

| Refused | Why |
|---|---|
| **Block the trade** | Makes Sentinel a trading decision-maker. ⚖️ Regulatory category change. ARCH-3. |
| **Delay the trade** | Puts Sentinel in the order path as a latency dependency and a failure mode. ARCH-3. |
| **Add a confirmation step** | Still Sentinel deciding whether an order is easy or hard to place. ARCH-3. |
| **Judge** | *"You're being emotional"* is unfalsifiable, insulting, and unverifiable. |
| **Score or grade** | A discipline score gamifies discipline, and gamified discipline is not discipline. |
| **Compare to other users** | Comparison produces competition; competition produces trading. |
| **Nag** | The same observation twice in a session is noise. Noise gets muted. |

### 10.2.2 What we do instead

```
   ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
   │  OBSERVE     │ → │   REFLECT    │ → │      TEACH       │
   └──────────────┘   └──────────────┘   └──────────────────┘

   "3 entries within   "What pattern do    the Learning Hub
    15 minutes of a     you notice about    lesson on trading
    losing exit this    your entries        after losses
    session."           after a loss?"
    ▲                   ▲                   ▲
    a checkable fact    a question, not     one lesson, tied to
                        a verdict           today's dominant
                                            observation
```

The middle box is where the work happens. A user who answers the question — even silently, even defensively — has noticed the pattern. Noticing is the entire mechanism. A system that told them the answer would deny them the noticing.

### 10.2.3 The three-part contract, applied to behaviour

```
   EVIDENCE           →  PATTERN NAME       →  SOFT SUGGESTION
   "18 trades today,     "This resembles       "Consider whether
    median gap 1.8        a high-frequency      each of these had
    minutes."             session well above    a setup you'd have
                          your own average."    taken yesterday."
```

Never *"stop trading"*. Never *"take a break"* as an instruction. Never *"you have overtraded"* as a verdict.

---

## 10.3 Overtrading 🟢

### Detection

```ts
const today = new Date().toISOString().slice(0, 10);
const todayTrades = sorted.filter(t => t.createdAt.slice(0, 10) === today);
sig('overtrading', todayTrades.length >= 15, 0.25, [`${todayTrades.length} trades today`]);
```

**Weight 0.25 — deliberately low.** Trade count alone means little: a scalper doing 15 trades is a normal Tuesday, a positional trader doing 15 is an emergency. Overtrading is a *contributory* signal that becomes meaningful only alongside `impatient_pacing`, `loss_streak`, or `revenge_trading`.

This is the composite design earning its keep. A naive system fires an "OVERTRADING!" alert at trade 15 and is wrong most of the time.

### Known limitation 🔵

The threshold is **absolute (15)**, not relative to the user's own baseline. It should be:

```
   overtrading = todayCount > max(15, 2 × user's 30-day daily median)
```

This requires cross-session history, which the current `signals(trades)` signature — a pure function over the session — does not receive. Fixing it means passing a baseline object into the agent, not querying from inside it (§5.6.1 must hold).

### Specified extensions 🔵

| Signal | Condition | Weight |
|---|---|---|
| `overtrading_vs_baseline` | today > 2× the user's 30-day daily median | 0.30 |
| `overtrading_after_loss` | trade count accelerating *after* the session turned negative | 0.35 |

The second is the more valuable: 20 trades in a green session is a style; 20 trades where 14 came after the P&L went red is a spiral.

---

## 10.4 FOMO 🟢

**Code:** `TrapIntelligenceService` — it needs market context, so it lives with the trap signals.

### Detection

```ts
const window   = candles.slice(-12);
const moveStart= window[0].close;
const movePct  = ((last.close - moveStart) / moveStart) * 100;
const lateness = (lastBuy.fillPrice - moveStart) / (last.close - moveStart);

sig('fomo_entry', movePct > 0.8 && lateness > 0.75, 0.30, [
  `Entry at ${lastBuy.fillPrice.toFixed(1)} captured only the last
   ${(100 - lateness*100).toFixed(0)}% of a ${movePct.toFixed(1)}%
   move already in progress`
]);
```

### Reading `lateness`

```
   move start                                          current
   24,700 ─────────────────────────────────────────── 24,900
      │                                                   │
      │←──────────────── 0.81% move ────────────────────→│
      │                                                   │
      0.0        0.25         0.50        0.75           1.0
      early                                          late

                                              ▲ entry at 24,860
                                                lateness = 0.80
                                                captured last 20%
```

Both conditions matter. `lateness > 0.75` alone would fire on a 0.1% drift, where "late" is meaningless. `movePct > 0.8` gates it to moves large enough for entry timing to matter.

### Why the evidence phrasing is what it is

> *"captured only the last 18% of a 2.4% move already in progress"*

Not *"you chased"*. Not *"you entered late"*. A percentage the user can verify against their own chart. If they disagree, they can check — and checking is the point.

### Specified extension 🔵

**Chasing green candles** — repeated entries immediately after consecutive up candles:

```
   3+ consecutive green candles  AND  entry on the 4th or later
   AND  the pattern repeats 2+ times in a session
   → weight 0.30
```

The repetition requirement is what turns a single decision into a pattern worth naming.

---

## 10.5 Revenge trading 🟢

The highest-weighted behavioural signal (0.35) and the clearest instance of the thesis.

### Detection

```ts
let revengeCount = 0;
for (let i = 1; i < sorted.length; i++) {
  const prevLoss = (sorted[i-1].realizedPnl ?? 0) < 0;
  const gapMin   = (t(sorted[i]) - t(sorted[i-1])) / 60_000;
  if (prevLoss && gapMin >= 0 && gapMin <= 15) revengeCount++;
}
sig('revenge_trading', revengeCount >= 2, 0.35,
    [`${revengeCount} entries within 15 minutes of a losing exit in this session`]);
```

### The three parameters

| Parameter | Value | Reasoning |
|---|---|---|
| Window | **15 minutes** | Long enough to exclude a genuine next setup; short enough that the loss is still emotionally present |
| Threshold | **2 occurrences** | One is a coincidence. Two is a pattern. |
| Guard | **`gapMin >= 0`** | Trade timestamps can arrive out of order. Without this, a negative gap passes `<= 15`. |

That third one is not defensive paranoia — it is a bug that would only appear in production, only under clock skew or out-of-order arrival, and would produce false accusations of revenge trading. Exactly the class of bug that damages trust irrecoverably.

### The reference statistic

The product mockup's own figure, which this detector exists to make personal:

> *"Win rate after a losing trade drops by 22%."*

🔵 **Not yet computed per-user.** The specified extension — showing a user *their own* win-rate delta rather than an aggregate — is the highest-value unbuilt feature in this chapter, because a general statistic is interesting and a personal one is uncomfortable, and uncomfortable is what changes behaviour.

```
   🔵 revenge_trading_costly
      user's win rate after a loss < their overall win rate − 15pp
      AND ≥ 20 post-loss trades in the sample
      weight 0.40
      evidence: "Your win rate on trades placed within 15 minutes of a
                 loss is 28%, against 51% otherwise, over 34 such trades."
```

Note the `≥ 20` sample requirement — DP7 (withhold rather than mislead) applies to behavioural statistics exactly as it does to market ones.

---

## 10.6 Fear 🔵

Fear is harder to observe than greed, because its signature is **absence**: trades not taken, positions cut early, size reduced after a drawdown.

### Observable proxies 🔵

| Signal | Condition | Weight |
|---|---|---|
| `premature_exit` | closing winners at a materially smaller multiple of ATR than losers | 0.25 |
| `size_reduction_after_loss` | average size drops > 40% following a losing streak | 0.20 |
| `hesitation_pattern` | repeatedly opening the order ticket without submitting | 0.20 |
| `paralysis` | zero trades on a day matching the user's usual activity profile | 0.15 |

### Why fear is deliberately lower-weighted

Two reasons, and both are important:

1. **Fear is often correct.** Reducing size after a drawdown is textbook risk management. Flagging it as a problem would be actively harmful advice — which is exactly why Sentinel does not give advice.
2. **The observation is much weaker evidence.** "You did not trade today" has a hundred explanations.

The output register must therefore be even softer than usual:

> ✅ *"Your average position size is 45% smaller than last week. Was that a deliberate adjustment?"*
> ❌ *"You're trading scared."*

The question form is doing real work: the honest answer might be *"yes, deliberately"*, and the system must be comfortable being told it noticed nothing.

### `hesitation_pattern` requires UI telemetry 🔵

Order-ticket opens without submission are a frontend event, not a trade record. This needs a deliberate, disclosed telemetry channel — and ⚖️ it is behavioural data about a person, so it falls under DPDP consent (Chapter 19 §19.8) and must be opt-in with a plain-language explanation.

---

## 10.7 Greed 🟡

Greed's signature is escalation, and escalation *is* observable.

### Implemented — position sizing drift 🟢

```ts
const avgQty    = sorted.reduce((s, t) => s + t.quantity, 0) / sorted.length;
const sizeRatio = avgQty > 0 ? lastTrade.quantity / avgQty : 1;
sig('position_sizing_drift', sizeRatio >= 2, 0.30,
    [`Position sizing on the last trade was ${sizeRatio.toFixed(1)}x your session average`]);
```

**Relative to the user's own average**, always. A trader whose normal size is 10 lots going to 20 is the same behavioural event as one going 1 → 2. An absolute threshold catches only one of them, and which one depends on account size — meaning it would systematically flag small accounts and ignore large ones.

### Specified extensions 🔵

| Signal | Condition | Weight |
|---|---|---|
| `escalation_after_win` | size increases ≥ 50% following 2+ consecutive wins | 0.30 |
| `target_extension` | moving a take-profit further away while in profit | 0.25 |
| `no_stop_defined` | position held with no protective order ≥ 30 minutes | 0.30 |

`escalation_after_win` is the more dangerous of the first two, and the less intuitive. Traders expect to be warned about escalating after a *loss*. Escalating after a *win* feels earned — which is why it is rarely noticed and frequently expensive.

`no_stop_defined` is factual and unusually clean: either a protective order exists or it does not. The evidence writes itself: *"This position has been open for 47 minutes with no stop-loss order attached."*

---

## 10.8 Loss streak 🟢

### Detection

```ts
let streak = 0, maxStreak = 0;
for (const t of sorted) {
  if ((t.realizedPnl ?? 0) < 0) { streak++; maxStreak = Math.max(maxStreak, streak); }
  else if (t.realizedPnl !== undefined) { streak = 0; }
}
sig('loss_streak', maxStreak >= 3, 0.30, [`Longest losing streak this session: ${maxStreak} trades`]);
```

### The subtlety in the `else if`

A trade with `realizedPnl === undefined` — a position-*opening* trade, which locks in nothing — **neither extends nor breaks the streak.** Only trades that actually realised a result count.

Without that guard, a sequence of `loss, loss, open, loss` would reset at the open and never reach 3. With it, the streak is 3, which is correct: opening a position is not a win.

Three lines of code, one boolean condition, and the difference between a detector that works and one that quietly under-reports.

### Why loss streaks matter beyond the arithmetic

A loss streak is the **precondition** for most of the other patterns in this chapter. Revenge trading, size escalation, and overtrading are overwhelmingly things that happen *during* a streak. That is why `loss_streak` at weight 0.30 combines so readily:

```
   loss_streak (0.30) + revenge_trading (0.35) = 0.65   → below gate, silent
   loss_streak (0.30) + revenge_trading (0.35)
                      + position_sizing_drift (0.30) = 0.95  → SURFACED
```

The first case is a bad afternoon. The second is a spiral, and the arithmetic distinguishes them without anyone hard-coding "spiral."

---

## 10.9 Position size validation 🔵

### The distinction from §10.7

Position **sizing drift** observes change relative to the user's own history. Position size **validation** observes size relative to the *account*.

### Specified

| Signal | Condition | Weight |
|---|---|---|
| `oversized_position` | single position > 25% of account value | 0.30 |
| `excessive_risk_per_trade` | distance to stop × size > 5% of capital | 0.35 |
| `margin_utilisation_high` | margin used > 70% of available | 0.30 |
| `concentration` | one instrument > 40% of total exposure | 0.30 |

### ⚖️ The phrasing constraint

These are the observations most likely to slide into advice, because the "correct" answer feels obvious. It is not our answer to give.

```
   ✅ "This position is 34% of your account value. Your average
       over the last 30 days is 11%."

   ❌ "This position is too large."
   ❌ "Reduce your position size to 2% risk."
   ❌ "Recommended maximum: ₹50,000."
```

The 2%-risk rule is a widely-taught convention, not a fact, and it is not universal. Stating it as a recommendation would be advice; stating the user's own numbers is observation. Every card in this section states numbers.

---

## 10.10 Daily and weekly limits 🔵

### The design that respects ARCH-3

Limits are **user-defined and self-imposed**. The platform does not set them, and — critically — the platform does not enforce them by blocking.

```
   ┌───────────────────────────────────────────────────────┐
   │  Settings → Trading Discipline          (user-defined) │
   │                                                       │
   │  Daily loss limit          ₹ [  10,000 ]              │
   │  Daily trade limit           [      12 ]              │
   │  Weekly loss limit         ₹ [  30,000 ]              │
   │  Max position size         % [      15 ]              │
   │  Cooling-off after a loss  min [     5 ]              │
   │                                                       │
   │  ⓘ TradeW never blocks an order. These are your own   │
   │    limits — we observe when you cross one and tell    │
   │    you, calmly, that you did.                         │
   └───────────────────────────────────────────────────────┘
```

Stored as `UserPreference` with key `trading_limits` (typed JSON, no migration required).

### The observation, when a limit is crossed

```
   ⚠️  Daily loss limit reached

   You set a ₹10,000 daily loss limit. Today's realised P&L is
   −₹11,400 across 9 trades.

   You have crossed this limit on 3 of the last 20 sessions. On
   those 3 days, trades placed after crossing it added a further
   −₹18,200.

   This is an observation, not a restriction.
```

Read the last line again. **It is the whole product in one sentence.** The user set the limit, the user crossed it, the platform noticed, told them, showed them what happened the last three times — and did not stop them.

### Why self-imposed and non-blocking

| | Platform-enforced limits | Self-imposed, observed limits |
|---|---|---|
| Regulatory | ⚖️ platform making trading decisions | user's own choice, observed |
| Behavioural | user learns to route around, or raises the limit | user confronts their own decision |
| Engineering | limits become a dependency of the order path | fully decoupled |
| Failure mode | limit service down ⇒ can't trade / no protection | limit observation absent, trading unaffected |

Every column favours the same design, which is usually a sign the design is right.

---

## 10.11 Psychology monitoring 🟡

### The journal as instrument

`JournalEntry.mood` (`focused` / `anxious` / `confident` / `frustrated`) is one nullable string column that converts subjective state into a joinable dataset:

```
   MOOD × OUTCOME  (the analysis this column exists to enable)

   mood         trades   win rate   avg P&L    avg hold
   ─────────    ──────   ────────   ────────   ────────
   focused         42      58%      +₹1,240      34m
   confident       31      51%        +₹610      28m
   anxious         18      33%        −₹890      11m   ←
   frustrated      12      25%      −₹1,510       6m   ←

   Note the holding period. It falls with the mood.
```

That table is the behavioural thesis, measurable, for one specific person. It is not available anywhere else, it costs one column, and it is currently unbuilt (🔵 — the analytics service does not exist).

### `flaggedByAi` and `aiAnnotation` 🔵

Fields on `JournalEntry` for AI-surfaced entries. ⚖️ The annotation must be an **observation about correlation**, never an interpretation of the person's state:

```
   ✅ "You tagged this session 'frustrated'. Your 4 trades in
       sessions tagged this way averaged an 11-minute hold,
       against 34 minutes when tagged 'focused'."

   ❌ "You seem to be struggling with frustration."
```

The first is arithmetic on data the user provided. The second is a diagnosis, and we are not licensed to make one — clinically or financially.

### 🔵 Specified: pattern surfacing over time

```
   Weekly reflection (opt-in)

   • Sessions tagged 'anxious': 3 of 5 this week (1 of 5 last week)
   • Your median holding period fell from 31 to 14 minutes
   • Trade count rose 40% while average size fell 22%

   These are observations from your own journal and trade history.
```

Note there is no conclusion. The user draws it.

---

## 10.12 Trade validation 🔵

Chapter 7 §7.13 has the architectural constraints. The behavioural content:

### Observations at order-ticket time

| Category | Example |
|---|---|
| Size | *"3.1× your average position size over the last 30 days."* |
| Sequence | *"This would be your fourth entry within 15 minutes of a losing exit today."* |
| Timing | *"Your last 8 trades in the final 20 minutes of a session were net −₹6,400."* |
| Familiarity | *"First trade in this instrument. Your first trades in a new instrument average −₹340."* |
| Regime | *"India VIX is at 22. Realised moves have been ~1.8× their monthly average."* |
| Limit | *"This order would take today's trade count to 13. Your self-set limit is 12."* |

Every one is a **number from the user's own history or from the market**. None is a judgement about the order.

### ⚖️ The five hard rules, repeated because this is where they get broken

```
   V1  Called IN PARALLEL with the ticket, never as a placement step
   V2  Never gates the submit button
   V3  Absence or failure changes NOTHING about placement
   V4  Never says "don't place this"
   V5  No timeout that anything waits on
```

---

## 10.13 Habit detection 🔵

Single observations describe a moment. Habits describe a person, and they are what the platform is actually trying to change.

### The detection model

```
   session observations  ──► pattern occurrence log
                                    │
                          ┌─────────┴─────────┐
                          │ 30-day aggregation│
                          └─────────┬─────────┘
                                    ▼
                    pattern frequency + associated outcome
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
            HABIT (recurring, costly)      NOISE (isolated)
            ≥ 8 occurrences in 30d          < 8 occurrences
            AND measurable cost             OR no cost signal
```

### The habit card 🔵

```
   ┌──────────────────────────────────────────────────────────┐
   │  A pattern worth noticing                                │
   │                                                          │
   │  Over the last 30 days you entered a position within 15  │
   │  minutes of a losing exit on 14 occasions.               │
   │                                                          │
   │  Those 14 trades: 3 winners, 11 losers, net −₹22,400.    │
   │  Your other 89 trades: 46 winners, net +₹31,100.         │
   │                                                          │
   │  What do you notice?                                     │
   │                                                          │
   │  [ Related lesson: Trading after a loss ]                │
   └──────────────────────────────────────────────────────────┘
```

Numbers, a comparison, a question, a lesson. **No conclusion, no instruction, no score.** The user does the arithmetic in their head and reaches the conclusion themselves, which is the only way it sticks.

### Frequency governance

| Rule | |
|---|---|
| At most **one** habit card per week | A second is nagging |
| Never repeat the same habit within 30 days | Unless the frequency materially worsened |
| Only surface habits with a **measurable cost** | A quirk that costs nothing is not the platform's business |
| Dismissible, and dismissal is respected | A muted habit stays muted for 90 days |

---

## 10.14 Personalised coaching 🔵

### The three tiers

```
   TIER 1  IN-SESSION           immediate, contextual
           Live Safety Feed cards, evidence → pattern → soft suggestion

   TIER 2  POST-SESSION         reflective, end of day
           session summary, dominant observation, one linked lesson

   TIER 3  LONGITUDINAL         habit-level, weekly/monthly
           habit cards, mood×outcome analysis, progress on a
           previously-surfaced pattern
```

Tier 1 is 🟡. Tiers 2 and 3 are 🔵 and both need a real scheduler (§9.8.4).

### Contextual Training

The one implemented coaching mechanism: the Learning Hub lesson tied to the session's **dominant** observation.

```
   dominant signal → concept mapping → lesson

   revenge_trading       → trading-psychology/revenge-trading
                         → "Why the trade after a loss is different"

   low_volume_breakout   → volume/breakout-confirmation
                         → "What volume tells you about a breakout"

   position_sizing_drift → risk-management/position-sizing
                         → "Sizing relative to your own baseline"
```

**One lesson. Not a menu.** A user shown a curriculum browses; a user shown one relevant lesson reads it.

### Coaching memory 🔵

The coach must remember what it has already said:

| Rule | Reason |
|---|---|
| Never the same lesson twice in 7 days | Repetition reads as nagging |
| Never the same habit card within 30 days | As above |
| If a pattern's frequency falls, **acknowledge it once** | Progress unremarked is progress unnoticed |
| If a user dismisses a pattern 3×, stop surfacing it for 90 days | Consent |

That third row is the only place in the platform where Sentinel says something positive, and it is deliberately rationed:

> *"Entries within 15 minutes of a losing exit: 3 this month, against 14 last month."*

Still a number. Still no praise. The user decides whether that is good.

---

## 10.15 AI feedback and its boundaries ⚖️

### Where the LLM is allowed

| Allowed | Not allowed |
|---|---|
| Rewriting deterministic evidence into calm prose | Deciding *whether* a pattern occurred |
| Selecting which of 3 pre-approved question phrasings fits | Inventing a question |
| Summarising a session from structured observations | Inferring emotional state from trades |
| Explaining a *concept* on request | Explaining the *user* to themselves |

### The two failure modes to guard against

**1. Diagnosis.** An LLM given trade data will readily produce *"you appear to be experiencing loss aversion."* That is a clinical-sounding claim, unfalsifiable, about a person, from six data points. It is prohibited, and the prohibition is in `CORE_GUARDRAILS`.

**2. Advice smuggled as empathy.** *"It might be worth stepping away for a while"* is an instruction wearing a cardigan. So is *"perhaps consider a smaller size."* ⚖️ Both are rejected in copy review.

### The test

```ts
const BEHAVIOURAL_FORBIDDEN = [
  /you (seem|appear|are) (to be )?(feeling|experiencing)/i,
  /take a break/i,
  /step away/i,
  /you should/i,
  /(reduce|increase) your (size|position|risk)/i,
  /stop trading/i,
  /calm down/i,
];

it('never diagnoses or instructs in behavioural output', () => {
  for (const scenario of BEHAVIOURAL_SCENARIOS) {
    const text = compose(scenario);
    for (const p of BEHAVIOURAL_FORBIDDEN) expect(text).not.toMatch(p);
  }
});
```

⚖️ This test is a **compliance control**, not a style check. It runs in CI against the deterministic composer and nightly against the live model.

---

## 10.16 Measuring whether any of this works

The uncomfortable question, asked deliberately: **does behavioural observation actually change behaviour?**

We do not know. The platform has never run with users. This section defines how we will find out, and commits in advance to what would count as failure.

### The measurement design 🔵

```
   COHORT A  Sentinel entitled, observations surfaced
   COHORT B  Sentinel entitled, observations suppressed (holdout)

   Measured over 60 days, per user:
     • frequency of each behavioural pattern
     • realised P&L attributable to flagged vs unflagged trades
     • median holding period
     • trade count
     • self-reported journal mood distribution
```

⚖️ A suppressed-observation holdout raises a genuine ethical question: we would be withholding a protection someone paid for. Mitigations: the holdout is time-boxed, disclosed in the subscription terms, compensated with an equivalent free period, and abandoned the moment the primary cohort shows a clear benefit.

### Success and failure criteria, committed in advance

| Outcome | Interpretation |
|---|---|
| Flagged-pattern frequency **falls ≥ 25%** in A vs B | The thesis holds |
| Frequency falls but P&L does not improve | Behaviour changed; the patterns were not the cost. **Re-examine which patterns we detect.** |
| No frequency difference | Observation alone is insufficient. **Re-examine the intervention model, not the detection.** |
| A performs *worse* than B | Observation is causing harm — anxiety, second-guessing, over-correction. **Stop. This is a product-halting result.** |

That last row is written down deliberately. A behavioural product that never defines what would falsify it is not a product, it is a belief.

---

## 10.17 Chapter summary

| Protection | Signal | Weight | Status |
|---|---|---|---|
| Revenge trading | `revenge_trading` | 0.35 | 🟢 |
| Overtrading | `overtrading` | 0.25 | 🟢 |
| Size escalation | `position_sizing_drift` | 0.30 | 🟢 |
| Impatient pacing | `impatient_pacing` | 0.20 | 🟢 |
| Loss streak | `loss_streak` | 0.30 | 🟢 |
| FOMO entry | `fomo_entry` | 0.30 | 🟢 |
| Expiry-day risk | `expiry_day_conditions` | 0.25 | 🟢 |
| Chasing green candles | — | 0.30 | 🔵 |
| Averaging down | — | 0.35 | 🔵 |
| Fear (4 proxies) | — | 0.15–0.25 | 🔵 |
| Greed escalation | — | 0.25–0.30 | 🔵 |
| Position size validation | — | 0.30–0.35 | 🔵 |
| Self-set limits | — | — | 🔵 |
| Habit detection | — | — | 🔵 |
| Personalised coaching | — | — | 🔵 |

**Seven of fifteen are real.** The seven that are real are the seven that need only `(timestamp, side, quantity, fillPrice, realizedPnl)` — which is exactly the data `services/api` already passes in. Everything 🔵 needs either cross-session baselines, portfolio context, UI telemetry, or a scheduler.

That is not an accident of sequencing. It is what building the cheapest useful thing first looks like.

---

*Next: [Chapter 11 — Paper Trading Engine](11-paper-trading-engine.md)*
