# Chapter 8 — Sentinel: Analytical Engines

Where Chapter 7 described *departments* (organisational units producing signals), this chapter describes *engines* — the analytical primitives departments compute with. An engine is a piece of market mathematics with a defined input, a defined output, and a defined failure mode.

Each engine is documented as: **what it measures · how it is computed · what Sentinel does with it · what Sentinel never does with it · status.**

The last of those columns is the important one. Every engine in this chapter has a "never" clause, because most of these primitives are, in the wider industry, used to generate trade recommendations. Sentinel uses them to describe structure. The distinction is enforced per-engine, not just globally.

---

## 8.0 Engine index

| # | Engine | Status | Primary consumer |
|---|---|---|---|
| 8.1 | Volatility Engine | 🟢 | Risk, Market Intelligence |
| 8.2 | Trap Detection Engine | 🟢 | Trap & Safety |
| 8.3 | Market Structure Engine | 🟡 | Trap & Safety, Market |
| 8.4 | Liquidity Detection Engine | 🟡 | Trap & Safety |
| 8.5 | Fair Value Gap Engine | 🔵 | Market Structure |
| 8.6 | Order Block Engine | 🔵 | Market Structure |
| 8.7 | Volume Profile Engine | 🔵 | Market Structure, Liquidity |
| 8.8 | Institutional Flow Engine | 🔵 | Macro, Options |
| 8.9 | Open Interest Analytics | 🟡 | Options, Trap |
| 8.10 | Put-Call Ratio Engine | 🔵 | Options, Sentiment |
| 8.11 | Implied Volatility Engine | 🔵 | Options |
| 8.12 | Greeks Engine | 🟡 | Options, Portfolio |
| 8.13 | Sector Rotation Engine | 🔵 | Macro |
| 8.14 | Correlation Engine | 🔵 | Portfolio, Macro |

---

## 8.1 Volatility Engine 🟢

### What it measures
Three distinct things that are routinely confused:

| Measure | Question | Source |
|---|---|---|
| **Realised volatility** | How much has it *actually* moved? | historical returns |
| **Implied volatility** | How much does the option market *expect* it to move? | option premiums |
| **India VIX** | How much does the option market expect the *index* to move? | NSE-published |

Confusing realised and implied is the single most common analytical error in retail options trading, and separating them in the data model is why Sentinel can observe the gap between them.

### How it is computed 🟢

```ts
// services/sentinel/src/intelligence/indicators.ts
realizedVolatilityPct(closes: number[]): number | null
// standard deviation of log returns over the last 20 bars,
// expressed as % per bar
```

Per-bar rather than annualised, deliberately. A trader looking at a 15-minute chart cares "how far does this typically move in fifteen minutes," and annualising it introduces a `√252 × √26` scaling factor that obscures the number they can actually use.

### What Sentinel does with it

| Signal | Condition | Weight |
|---|---|---|
| `elevated_realized_vol` | > 1.2% per bar | 0.20 |
| `elevated_vix` | India VIX > 18 | 0.30 |
| `high_risk_market_conditions` | India VIX > 20 | 0.30 |

Two VIX thresholds are deliberate: 18 is "notice the environment," 20 is "the environment is the story." A single threshold would make the transition binary; two produce a gradient.

### What it never does
⚖️ Never converts volatility into a position-size recommendation. *"Realised volatility is 1.44% per bar"* is a fact. *"Reduce your size by half"* is advice.

### Failure handling
Fewer than 20 bars ⇒ `null` ⇒ no signal. Never computed from a short window and presented as though it were the same measure.

### Future 🔵
Volatility regime classification with hysteresis; realised-vs-implied spread as a first-class signal (`iv_premium` — the option market is charging more than the stock has been delivering); volatility term structure.

---

## 8.2 Trap Detection Engine 🟢

**Code:** `services/sentinel/src/intelligence/trap-intelligence.service.ts` (105 lines)

The engine the product is named after.

### The composite design

> Each of these is a **signal**, not a standalone verdict. The agent computes all applicable signals for the user's current context, and the orchestrator surfaces a warning only when enough signals corroborate.

The canonical example, stated in the product blueprint and implemented literally: *low volume* **and** *declining OI* **and** *a breakout*, together — not any one alone.

### The full catalogue

Fourteen signals specified; seven implemented.

| # | Signal | Needs | Detects | Weight | Status |
|---|---|---|---|---|---|
| 1 | Low-volume breakout | OHLC, volume | breakout with below-average participation | 0.40 | 🟢 |
| 2 | Bull trap | OHLC, volume, OI | breakout above resistance reverses within 3 candles | 0.45 | 🟢 |
| 3 | Bear trap | OHLC, volume, OI | breakdown below support reclaimed within 2 candles | 0.45 | 🟢 |
| 4 | Liquidity sweep | OHLC wicks, OI | wick pierces a level, closes back inside | 0.35 | 🟢 |
| 5 | Stop-hunt | OHLC, book/OI proxy | sharp wick through an obvious stop level, no follow-through | — | 🟡 merged into #4 |
| 6 | FOMO entry | user entry timing vs. move | entry after most of a move has happened | 0.30 | 🟢 |
| 7 | Expiry-day trap | expiry calendar, OI | pin/whipsaw risk near expiry | 0.25 | 🟢 |
| 8 | High-risk conditions | VIX, breadth | index-level volatility regardless of symbol | 0.30 | 🟢 |
| 9 | Fake breakout | OHLC, volume | price crosses a level, volume doesn't confirm | — | 🟡 = #1 |
| 10 | Chasing green candles | entry sequence | repeated entries after consecutive up candles | 0.30 | 🔵 |
| 11 | Averaging down emotionally | position-add history vs. price | adding size into a loss with no pre-set plan | 0.35 | 🔵 |
| 12 | News-driven volatility | news feed + realised vol | breakout coinciding with unscheduled news | 0.30 | 🟡 |
| 13 | Gamma squeeze / IV crush | OI, IV term structure | short-dated OI concentration; IV collapsing into/after an event | 0.35 | 🔵 |
| 14 | Revenge trading | trade timestamps | new entry within a short window of a losing exit | 0.35 | 🟢 (in Emotion) |

### Implementation detail — the four that repay reading

**Low-volume breakout** — the reference implementation for how a composite signal should be written:

```ts
sig(
  'low_volume_breakout',
  brokeResistance && last.volume < avgVol,
  0.4,
  [
    ...(s.resistance !== null
        ? [`Price ${last.close.toFixed(1)} crossed resistance ${s.resistance.toFixed(1)}`]
        : []),
    `Breakout volume is ${((last.volume / avgVol) * 100).toFixed(0)}% of the 20-bar average`,
    ...(s.oiTrend === 'falling' ? ['Open interest is declining'] : []),
  ],
  { brokeResistance, volumeVsAvg: …, oiTrend: s.oiTrend },
);
```

Three things to copy from it: evidence lines are **conditionally included** (no "resistance: null" text ever reaches a user); the structured `data` object mirrors the evidence for the audit trail; and the OI line appears *only when OI is actually falling*, so the evidence never overstates.

**Bull trap** — a completed pattern, not a prediction:

```ts
const recent = candles.slice(-4);
const crossed = recent.slice(0, 3).some(c => c.close > s.resistance);
bullTrap = crossed && last.close < s.resistance;
```

It fires only *after* the reversal. It never says "this looks like it will become a bull trap." Weight 0.45 — the highest in the catalogue — because a completed structural reversal is strong evidence.

**Liquidity sweep** — the geometry is the signal:

```ts
const range     = last.high - last.low;
const lowerWick = Math.min(last.open, last.close) - last.low;
if (range > 0 && last.low < support && last.close > support
    && lowerWick / range > 0.6) { sweep = true }
```

Three conditions: price went **below** the level, closed back **above** it, and **>60% of the bar's range is lower wick.** That last condition is what distinguishes a sweep from an ordinary bounce, and the evidence line quotes the ratio so the user can check it on their own chart.

**FOMO entry** — the only trap signal requiring both market and behavioural data, which is why it lives here rather than in Emotion:

```ts
const window   = candles.slice(-12);
const moveStart= window[0].close;
const movePct  = ((last.close - moveStart) / moveStart) * 100;
const lateness = (lastBuy.fillPrice - moveStart) / (last.close - moveStart);
sig('fomo_entry', movePct > 0.8 && lateness > 0.75, 0.3, [
  `Entry at ${lastBuy.fillPrice.toFixed(1)} captured only the last
   ${(100 - lateness*100).toFixed(0)}% of a ${movePct.toFixed(1)}%
   move already in progress`
]);
```

`lateness` is where in the move the entry occurred: 0 = at the start, 1 = at the current price. Both conditions matter — a 0.2% move has no "FOMO" to speak of regardless of entry point, so `movePct > 0.8` gates it.

### What it never does
⚖️ Never says "this is a trap, don't buy." It says *"these observations together resemble a low-conviction breakout"* and stops. The pattern is named; the conclusion is the user's.

---

## 8.3 Market Structure Engine 🟡

### What it measures
How price organises itself: trends, ranges, swing points, and the levels that matter.

### How it is computed 🟢

```ts
swingLevels(candles): { support: number, resistance: number } | null
```

Swing highs and lows over the candle window. Deliberately simple, and honestly labelled as a first implementation.

### Specified upgrade 🔵

```
   TIMEFRAME HIERARCHY
   1D   ├── primary trend        HH/HL or LH/LL sequence
   1H   ├── intermediate         swing structure within the daily
   15m  └── execution            where the user is actually looking

   STRUCTURE STATE MACHINE
        ┌──────────┐  break of structure   ┌──────────┐
        │ UPTREND  │ ────────────────────► │  RANGE   │
        │ (HH, HL) │ ◄──────────────────── │          │
        └──────────┘   confirmed reclaim   └────┬─────┘
              ▲                                 │
              │        change of character      ▼
              └──────────────────────────┌──────────┐
                                         │ DOWNTREND│
                                         │ (LH, LL) │
                                         └──────────┘
```

**Break of Structure (BOS)** — price closes beyond the last swing point in the direction of the trend: continuation.
**Change of Character (CHoCH)** — price closes beyond the last swing point *against* the trend: the first evidence of a regime change.

### Signals 🔵

| Signal | Condition | Weight |
|---|---|---|
| `structure_break` | close beyond the last swing in trend direction | 0.30 |
| `change_of_character` | first counter-trend structural break | 0.35 |
| `timeframe_conflict` | 15m trend opposes the 1D trend | 0.25 |

`timeframe_conflict` is the highest-value of the three for a retail user: taking an intraday long inside a daily downtrend is a specific, nameable, and extremely common mistake.

### What it never does
⚖️ Never says "the trend is up, so buy." It says "the daily structure is making higher highs while the 15-minute structure is making lower highs."

---

## 8.4 Liquidity Detection Engine 🟡

### What it measures
Where resting orders — mostly stop-losses — are likely clustered, and whether price has just been there.

### The premise
Stops cluster at obvious levels: below swing lows, above swing highs, at round numbers, at prior-day high/low. Price frequently trades through those clusters and reverses. Whether that is deliberate targeting or simply where liquidity is does not matter for the observation; the geometry is observable either way, and Sentinel describes geometry rather than motive.

### Implemented 🟢
The `liquidity_sweep` signal (§8.2).

### Specified 🔵

```
   LIQUIDITY POOL MAP
   ┌────────────────────────────────────────────────┐
   │  24,900 ── round number         ▓▓▓            │
   │  24,875 ── prior-day high       ▓▓▓▓▓          │
   │  24,850 ── swing high (1H)      ▓▓▓▓▓▓▓        │  ← buy-side liquidity
   │ ══════════ 24,812 CURRENT ═══════════════════  │
   │  24,780 ── swing low (15m)      ▓▓▓▓           │  ← sell-side liquidity
   │  24,750 ── prior-day low        ▓▓▓▓▓▓         │
   │  24,700 ── round number         ▓▓▓            │
   └────────────────────────────────────────────────┘
              pool strength = confluence count ×
                              recency × touch count
```

| Signal | Condition | Weight |
|---|---|---|
| `approaching_liquidity` | price within 0.3% of a high-strength pool | 0.20 |
| `liquidity_swept` | pool level pierced and reclaimed within 2 bars | 0.35 |
| `equal_highs` \| `equal_lows` | 2+ swings within 0.1% — a strong pool marker | 0.25 |

### What it never does
⚖️ Never says "stops are here, so price will go here." It says "there is a cluster of prior swing lows at 24,780, and price has just traded below and closed back above it."

---

## 8.5 Fair Value Gap Engine 🔵

### What it measures
A three-candle imbalance where price moved so fast that a range was never traded through — candle 1's high below candle 3's low (bullish FVG), or candle 1's low above candle 3's high (bearish FVG).

```
   BULLISH FVG                      BEARISH FVG

        │                                █
        █  candle 3                      █  candle 1
        █  low: 24,850                   █  low: 24,850
      ──┴───────────                   ──┴────────────
         ▒▒▒ GAP ▒▒▒  ← never          ▒▒▒ GAP ▒▒▒
      ──┬───────────     traded       ──┬────────────
        █  candle 1                      █  candle 3
        █  high: 24,800                  █  high: 24,800
        │                                █
```

### How it would be computed 🔵

```ts
for (let i = 2; i < candles.length; i++) {
  const [a, , c] = [candles[i-2], candles[i-1], candles[i]];
  if (a.high < c.low)  gaps.push({ type: 'bullish', from: a.high, to: c.low, index: i });
  if (a.low  > c.high) gaps.push({ type: 'bearish', from: c.high, to: a.low, index: i });
}
```

**Gap state:** `open` → `partially_filled` (price entered) → `filled` (price fully traversed). Filled gaps are retained as history, never deleted (Principle 9).

| Signal | Condition | Weight |
|---|---|---|
| `unfilled_gap_above` \| `_below` | an open FVG within 1% of spot | 0.20 |
| `gap_rejection` | price entered an FVG and reversed out | 0.30 |

### What it never does
⚖️ Never says "price will return to fill this gap." Gap fill is a tendency, not a law, and stating it as a law is a prediction. Sentinel says the gap exists, where it is, and whether it has been touched.

---

## 8.6 Order Block Engine 🔵

### What it measures
The last opposing candle before a strong displacement move — a proxy for where significant orders were absorbed.

```
   BULLISH ORDER BLOCK
                                   ██
                              ██   ██   ← displacement
                         ██   ██   ██
                    ██   ██   ██
   ▓▓▓ ← last down  ██
   ▓▓▓   candle
   ▓▓▓   before the displacement = the order block zone
```

### Validation criteria 🔵
An order block is only marked when **all** hold:
1. The candle is opposite in direction to what follows
2. The subsequent move exceeds 1.5× ATR (genuine displacement, not noise)
3. The move breaks a structural level
4. The zone has not been fully traded back through

Without criterion 2 in particular, every candle qualifies and the concept becomes meaningless.

| Signal | Condition | Weight |
|---|---|---|
| `approaching_order_block` | price within 0.3% of an untested block | 0.20 |
| `order_block_reaction` | price entered a block and reversed | 0.30 |
| `order_block_broken` | price closed through a block — the level failed | 0.25 |

### What it never does
⚖️ Never says "institutions are buying here." Sentinel cannot observe who is buying. It observes that a zone preceded a strong move and that price has returned to it.

**This engine carries the highest narrative risk in the chapter.** Order-block language in retail trading education is saturated with confident claims about institutional intent that the data does not support. The copy for this engine will need unusually careful review.

---

## 8.7 Volume Profile Engine 🔵

### What it measures
Volume distributed by **price** rather than by time.

```
        PRICE     VOLUME AT PRICE
        24,900  ▓▓
        24,875  ▓▓▓▓
        24,850  ▓▓▓▓▓▓▓                    ┐
        24,825  ▓▓▓▓▓▓▓▓▓▓▓▓               │ VALUE
   ►    24,812  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ◄ POC   │ AREA
        24,800  ▓▓▓▓▓▓▓▓▓▓▓▓               │ (70%)
        24,775  ▓▓▓▓▓▓▓                    ┘
        24,750  ▓▓▓
        24,725  ▓            ← LVN (low-volume node)
```

| Term | Meaning |
|---|---|
| **POC** (Point of Control) | The price with the most traded volume |
| **Value Area** | The range containing 70% of volume |
| **HVN** (high-volume node) | A price that attracted heavy trade — acts as a magnet |
| **LVN** (low-volume node) | A price that was traded through quickly — price tends to move fast through it again |

### Profile types 🔵
Session profile (today), composite (N days), visible-range (whatever the chart shows), and developing (updating live).

| Signal | Condition | Weight |
|---|---|---|
| `value_area_rejection` | price tested a VA edge and reversed | 0.25 |
| `poc_magnet` | price within 0.2% of POC in a low-volatility regime | 0.15 |
| `lvn_traverse` | price moving rapidly through a low-volume node | 0.20 |
| `profile_shift` | today's value area is entirely outside yesterday's | 0.30 |

`profile_shift` is the most informative: a value area that has moved wholesale is a genuine regime change, not a drift.

### Why this is 🔵 and not 🟢
Volume profile requires **tick or fine-grained intraday volume-at-price data**. `Quote` holds a latest snapshot; `Candle` (Migration 2) will hold OHLCV per bar. Neither gives volume-at-price. This engine is blocked on a data model that does not yet exist, and building it against bar volume would produce a plausible-looking chart that is quietly wrong.

---

## 8.8 Institutional Flow Engine 🔵

### What it measures
Footprints of large participants — because they must operate in ways that leave traces.

### ⚖️ The honesty constraint on this engine

> **We cannot observe institutional activity directly.** We observe *published aggregates* and *inferable footprints*. Every output of this engine must be phrased as what was actually measured, never as what an institution did.

This is the constraint that `SENTINEL.md` §5 codifies as: any dimension without a real backing signal — *"e.g. institutional participation"* — is reported honestly as not yet available, **never fabricated.** Institutional participation is named in the product document as the example of a dimension we must not invent, and that is not an accident: it is the most tempting number to fake, because users want it and nobody can check it.

### Available inputs

| Input | Availability | Honest reading |
|---|---|---|
| FII/DII net flows | 🔵 published daily by NSE | Aggregate, end-of-day, market-wide. Not per-symbol, not intraday. |
| Bulk/block deals | 🔵 published | Genuine large-trade disclosure. Delayed. |
| Delivery percentage | 🔵 published daily | High delivery % implies positional intent, not intraday churn. |
| Option OI concentration | 🟡 | Where size sits. Says nothing about who. |
| Volume vs. average | 🟢 | Unusual participation. Says nothing about who. |

| Signal | Condition | Weight | Honest phrasing |
|---|---|---|---|
| `unusual_volume` | > 2.5× 20-day average | 0.30 | "Volume is 3.1× the 20-day average" |
| `high_delivery` | delivery % > 1.5× its own 20-day average | 0.25 | "Delivery volume was 62% today vs a 41% average" |
| `fii_flow_divergence` | FII net direction opposes index direction | 0.25 | "FII net flows were negative on a day the index closed up" |
| `block_deal_reported` | a bulk/block deal was published | 0.20 | "A block deal of 2.1L shares was reported today" |

Read the right-hand column. Every phrasing states the **measurement**. None asserts intent.

### What it never does
⚖️ Never: "smart money is accumulating." Never: "institutions are distributing." Never a claim about a participant class we cannot observe.

---

## 8.9 Open Interest Analytics 🟡

### What it measures
The number of contracts outstanding — a direct measure of positioning that has no equity-market equivalent.

### Implemented 🟢

```ts
oiTrend(candles): 'rising' | 'falling' | 'flat' | 'unknown'
```

Note `'unknown'` as a first-class value. Equity candles carry no OI, so the function returns `'unknown'` rather than defaulting to `'flat'`. Downstream, `'unknown'` never contributes an evidence line — which is why the low-volume-breakout evidence conditionally includes the OI sentence.

### Specified 🔵

**Price/OI four-quadrant:**

| Price | OI | Reading | Conviction |
|---|---|---|---|
| ↑ | ↑ | Long build-up | High |
| ↑ | ↓ | Short covering | **Low** |
| ↓ | ↑ | Short build-up | High |
| ↓ | ↓ | Long unwinding | **Low** |

The low-conviction quadrants are the useful ones. A rally on falling OI is existing shorts closing, not new buyers arriving — a distinction invisible on a price chart and directly relevant to whether a breakout holds.

**Strike-level OI profile:**

```
   STRIKE      CE OI      PE OI      ΔCE OI    ΔPE OI
   25,000   ▓▓▓▓▓▓▓▓▓▓   ▓▓         +12%      -3%    ← CE wall (resistance-ish)
   24,900   ▓▓▓▓▓▓       ▓▓▓        +4%       +2%
   24,800   ▓▓▓          ▓▓▓▓▓▓▓    -2%       +18%   ← PE wall (support-ish)
   24,700   ▓▓           ▓▓▓▓▓▓▓▓▓  -5%       +9%
                                              ▲ max pain ≈ 24,850
```

| Signal | Condition | Weight |
|---|---|---|
| `oi_wall_above` \| `_below` | strike OI > 2× the chain mean within 2 strikes of spot | 0.25 |
| `max_pain_proximity` | spot within 0.5% of max pain on expiry day | 0.30 |
| `oi_unwinding` | ΔOI negative on a directional move | 0.30 |

### What it never does
⚖️ Never says "OI resistance at 25,000, so sell there." An OI concentration is where positions sit, not a level price must respect. The evidence line states the concentration; the inference is the user's.

---

## 8.10 Put-Call Ratio Engine 🔵

### What it measures
Positioning skew. Two distinct ratios that measure different things and are routinely conflated:

| Ratio | Formula | Measures |
|---|---|---|
| **OI PCR** | total PE OI ÷ total CE OI | Standing positioning |
| **Volume PCR** | PE volume ÷ CE volume | Today's flow |

### Interpretation — and its trap

Conventionally read as a contrarian sentiment gauge: high PCR (heavy puts) = excessive bearishness = potential bottom.

**Absolute thresholds do not transfer.** NIFTY's typical OI PCR range differs structurally from BANKNIFTY's, and both drift over months as the market's composition changes. A hard-coded "PCR > 1.3 = bullish" is wrong on at least one index at any given time.

So the specified implementation uses a **percentile against the symbol's own 90-day history**:

```ts
pcrPercentile(symbol, currentPcr): number   // 0..1
```

| Signal | Condition | Weight |
|---|---|---|
| `pcr_extreme_high` | > 90th percentile of its own 90-day range | 0.25 |
| `pcr_extreme_low` | < 10th percentile | 0.25 |
| `pcr_divergence` | OI PCR and volume PCR moving oppositely | 0.20 |

`pcr_divergence` is the subtle one: standing positioning and today's flow disagreeing means positions are being closed rather than opened.

### What it never does
⚖️ Never says "PCR is extreme, so the market will bounce." It says "the OI put-call ratio is at the 94th percentile of its 90-day range."

---

## 8.11 Implied Volatility Engine 🔵

### What it measures
What the option market is charging for uncertainty.

### Derived measures

| Measure | Definition | Why it matters |
|---|---|---|
| **IV Rank** | (IV − 52wk low) ÷ (52wk high − 52wk low) | Where IV sits in its own range |
| **IV Percentile** | % of the last 252 days IV was below today's | More robust to single outliers than IV Rank |
| **IV vs RV spread** | ATM IV − realised vol (annualised) | Is the option market over- or under-charging? |
| **Skew** | OTM put IV − OTM call IV | Directional fear pricing |
| **Term structure** | near-expiry IV vs far-expiry IV | Event risk concentration |

**IV Rank and IV Percentile are different numbers and should not be used interchangeably.** One 52-week IV spike distorts IV Rank permanently for a year; IV Percentile is unaffected. Both are specified because both are conventional, and the UI must label which it shows.

| Signal | Condition | Weight |
|---|---|---|
| `iv_elevated` | IV percentile > 80 | 0.25 |
| `iv_crush_risk` | IV percentile > 80 **and** a known event within 2 sessions | 0.35 |
| `iv_rv_divergence` | IV > 1.5× realised (annualised) | 0.25 |
| `term_structure_inversion` | near-expiry IV > far-expiry IV | 0.30 |

`iv_crush_risk` is the highest-value observation in this engine for a retail options buyer, and it is the mechanism behind the most common expensive surprise in Indian retail options: buying a call before earnings, being right about the direction, and still losing money because IV collapsed.

### What it never does
⚖️ Never says "IV is high, sell premium." Selling premium is a strategy recommendation with unbounded risk. Sentinel observes that IV is at the 88th percentile and that an event is scheduled.

---

## 8.12 Greeks Engine 🟡

### Current state 🟡
`apps/web/src/lib/black-scholes.ts` — client-side Black-Scholes for the option chain UI.

### Specified 🔵
Server-side computation in `packages/indicators`, shared by the client, so a Greek shown on a chain and a Greek used in a signal are the same number (the same drift risk as §7.3).

| Greek | Measures | Sentinel's use |
|---|---|---|
| **Delta** | ∂price / ∂spot | directional exposure, aggregate portfolio delta |
| **Gamma** | ∂delta / ∂spot | how fast exposure changes — the source of pin risk |
| **Theta** | ∂price / ∂time | decay; the dominant cost for a retail buyer |
| **Vega** | ∂price / ∂IV | exposure to the IV crush described in §8.11 |
| **Rho** | ∂price / ∂rate | negligible for weekly options; computed for completeness |

### Portfolio-level aggregation 🔵

```
   net delta = Σ (position delta × quantity × lot size)
   net gamma = Σ (position gamma × quantity × lot size)
   net vega  = Σ (position vega  × quantity × lot size)
   net theta = Σ (position theta × quantity × lot size)   ← ₹/day
```

| Signal | Condition | Weight |
|---|---|---|
| `theta_burn` | net theta < −2% of portfolio value per day | 0.30 |
| `gamma_exposure` | net gamma above threshold near expiry | 0.30 |
| `vega_concentration` | net vega concentrated in one expiry | 0.25 |

**`theta_burn` is the most under-appreciated number a retail options buyer never sees.** *"Your open positions decay by ₹4,200 per day, which is 2.3% of your capital"* is a fact most users have never had presented to them, and it explains more retail losses than direction ever does.

### What it never does
⚖️ Never says "your delta is too high, hedge it." It reports the exposure.

---

## 8.13 Sector Rotation Engine 🔵

### What it measures
Relative strength across sectors and how it is changing.

```
   RELATIVE ROTATION  (RS ratio vs RS momentum)

        strong │  IMPROVING  │  LEADING
      momentum │      ▲      │     ●IT
               │      │      │   ●BANK
               ├─────────────┼─────────────
               │             │
        weak   │  LAGGING    │  WEAKENING
      momentum │   ●METAL    │  ●PHARMA ▼
               └─────────────┴─────────────
                 weak RS         strong RS

   Quadrant order over time is typically:
   Improving → Leading → Weakening → Lagging → Improving
```

| Signal | Condition | Weight |
|---|---|---|
| `sector_leadership_change` | a sector changes quadrant | 0.25 |
| `symbol_vs_sector_divergence` | symbol underperforms its sector by > 1.5σ | 0.30 |
| `defensive_rotation` | FMCG/Pharma leading while the index falls | 0.30 |

`symbol_vs_sector_divergence` is the most useful for an individual trader: their stock is falling while its sector rises, which is a company-specific story their chart does not show.

### What it never does
⚖️ Never says "rotate into IT." It observes which sectors are leading and where the symbol sits relative to its own.

---

## 8.14 Correlation Engine 🔵

### What it measures
How positions move together — the difference between diversification and its illusion.

### Computation 🔵

```
   ρ(A,B) = Pearson correlation of daily log returns, 90-day rolling window

   Portfolio correlation matrix:
              RELIANCE  HDFCBANK  ICICIBANK  INFY
   RELIANCE      1.00      0.42      0.38     0.31
   HDFCBANK      0.42      1.00      0.87 ←── 0.29
   ICICIBANK     0.38      0.87      1.00     0.27
   INFY          0.31      0.29      0.27     1.00
                            ▲
                   effectively one position
```

| Signal | Condition | Weight |
|---|---|---|
| `hidden_correlation` | 2+ positions with ρ > 0.8 | 0.35 |
| `false_diversification` | portfolio average pairwise ρ > 0.6 | 0.30 |
| `correlation_regime_shift` | average market correlation rising sharply | 0.30 |

### Why `correlation_regime_shift` matters more than it looks

Correlations converge toward 1 during stress. Everything falls together, and the diversification that worked in calm markets stops working precisely when it is needed. A rising average correlation is one of the few genuinely leading indicators of a risk-off regime, and it is invisible on any individual chart.

### What it never does
⚖️ Never says "reduce your bank exposure." It says *"HDFC Bank and ICICI Bank have a 90-day correlation of 0.87. These two positions have behaved as one."*

---

## 8.15 Cross-engine synthesis

The engines exist to feed the composite gate. A worked example of how they combine:

```
   SCENARIO — NIFTY 24,812, user just bought a 25,000 CE

   Volatility Engine      → elevated_vix           (VIX 19.4)      0.30
   Trap Engine            → low_volume_breakout    (vol 62%)       0.40
   OI Analytics           → oi_unwinding           (ΔOI −8%)       0.30
   Behavioural            → fomo_entry             (lateness 0.82) 0.30
   IV Engine              → iv_elevated            (pct 84)        0.25
                                                        ─────────────
                                            composite weight  =  1.55
                                            triggered count   =  5

   GATE:  1.55 ≥ 0.7  ✓    5 ≥ 2  ✓    → SURFACE
   dominant = low_volume_breakout (0.40)
   confidence = min(0.95, 1.55/2 + 0.3) = 0.95   ← capped

   OUTPUT
   "Price crossed resistance 24,790 on volume that is 62% of the 20-bar
    average, with open interest declining 8% and India VIX at 19.4. The
    entry captured the last 18% of a move already in progress, and implied
    volatility is at the 84th percentile. Together these resemble a
    low-conviction breakout entered late into an expensive options market.
    Consider waiting for confirmation before adding.

    This is an observation, not advice."

   AUDIT  ⚖️  5 SentinelObservation rows (one per triggered signal)
              + 1 orchestrator row, surfaced=true, evidence[] = all
              5 evidence arrays concatenated
```

That is the product. Five independent measurements, none of them a recommendation, assembled into one paragraph a person can check line by line.

---

## 8.16 Engine implementation checklist

```
□ MEASUREMENT
  What exactly does this measure? One sentence, no hedging.
  Is that measurement observable from data we actually have?
  If not → it is 🔵, and it must report unavailable, not estimate.

□ COMPUTATION
  Deterministic and reproducible?
  Pure function over its inputs?
  What is the minimum data length? What happens below it? (→ null)

□ CALIBRATION
  Are thresholds absolute or percentile-of-own-history?
  Absolute thresholds must be justified — most should be relative.

□ SIGNALS
  snake_case names. Weight calibrated against §6.5 DP2.
  Evidence lines quotable to a user verbatim, with the number in them.
  Conditional evidence — never emit a line about a null value.

□ COMPLIANCE ⚖️
  Write the "never does" clause BEFORE writing the code.
  Does any phrasing assert intent we cannot observe? (→ §8.8)
  Does any phrasing imply a level price "must" respect? (→ §8.9)

□ SHARING
  Does the client need this number too? → packages/indicators,
  not a second implementation. (See TD-4.)

□ FAILURE
  Missing data → null → no signal. Never a default that looks like data.
```

---

*Next: [Chapter 9 — Sentinel: Runtime](09-sentinel-runtime.md)*
