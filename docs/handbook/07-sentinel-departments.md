# Chapter 7 — Sentinel: Departments

Sentinel's intelligence is organised into **departments**. Four are implemented as agents in `services/sentinel/src/`; the rest are specified capabilities that will be built either as additional signals inside an existing agent or as new agents.

Every department is documented against the same eleven-part template so they can be compared, and so that building a new one is a fill-in-the-blanks exercise rather than a design exercise.

**Department template:**
`Purpose · Inputs · Processing · AI logic · Outputs · Alerts · APIs · UI · Failure handling · Latency & caching · Future improvements`

---

## 7.0 Department index

| # | Department | Implemented as | Status |
|---|---|---|---|
| 1 | Market Intelligence | `MarketIntelligenceService` | 🟢 |
| 2 | Options Intelligence | signals in `TrapIntelligenceService`; own agent planned | 🟡 |
| 3 | Technical Analysis | `intelligence/indicators.ts` + market agent | 🟢 |
| 4 | Macro Intelligence | VIX + breadth in market agent; own agent planned | 🟡 |
| 5 | News Intelligence | `NewsIntelligenceService` | 🟢 |
| 6 | Economic Events | — | 🔵 |
| 7 | Risk Intelligence | `TrapIntelligenceService` regime signals | 🟡 |
| 8 | Behavioural Intelligence | `EmotionIntelligenceService` | 🟢 |
| 9 | Portfolio Intelligence | — | 🔵 |
| 10 | Learning Intelligence | Brain: `OutcomeLearningService`, `ConceptReinforcement` | 🟡 |
| 11 | Research Intelligence | `ResearchTriggerService` + `packages/ai-core/research` | 🟢 |
| 12 | AI Coach | Contextual Training + soft suggestions | 🟡 |
| 13 | Safety Nets | Chapter 10 | 🟡 |
| 14 | Trade Validator | — | 🔵 |
| 15 | Market Context Engine | `MarketContextService` | 🟢 |

---

## 7.1 Market Intelligence 🟢

**Code:** `services/sentinel/src/intelligence/market-intelligence.service.ts` (113 lines)

### Purpose
Continuously observe technical structure — trend, momentum, participation, volatility, breadth — for whatever the user is watching or holding. It answers *"what is the market doing?"*, never *"what should you do?"*

### Inputs

| Input | Source | Window |
|---|---|---|
| 15-minute candles | `MarketDataProvider.getCandles(symbol, '15m', …)` | 5 days |
| Daily candles | `getCandles(symbol, '1d', …)` | 10 days (for prior-day CPR) |
| Market breadth | `getMarketBreadth()` | current: advances, declines, VIX |

The two-timeframe read is deliberate: intraday structure comes from 15m bars; the Central Pivot Range is a *prior-day* derivation and needs daily bars. Fetching both is one extra call and removes an entire class of "why is CPR wrong on the first bar of the day" bug.

### Processing — the snapshot

`snapshot(symbol)` produces a `MarketSnapshot`, the single input every downstream agent shares:

```ts
{
  symbol, lastPrice,
  rsi14,             // 14-period RSI
  ema20, ema50,      // last values of the EMA series
  vwap,              // over the last 26 bars
  macdHistogram,     // MACD histogram value
  cpr,               // { pivot, bc, tc } from the PRIOR day
  volumeVsAvg,       // last volume ÷ 20-bar average
  oiTrend,           // 'rising' | 'falling' | 'flat' | 'unknown'
  realizedVolPct,    // % per bar over the last 20 bars
  vix,               // India VIX
  breadthRatio,      // advances ÷ declines
  support,           // from swingLevels()
  resistance,
  candles,           // the raw array, passed through
}
```

Every field is `| null`-able. A symbol with 12 bars of history has no EMA50, and the correct response is `null`, not a value computed from insufficient data. Every downstream consumer null-checks before emitting a signal — which is why a thinly-traded instrument produces fewer signals rather than wrong ones.

### AI logic
**None.** This department is fully deterministic. Every value is arithmetic over a candle array. That is the point: the analytical core must be reproducible.

### Outputs — eight signals

| Signal | Condition | Weight | Evidence template |
|---|---|---|---|
| `overbought_rsi` | RSI(14) > 70 | 0.20 | `RSI(14) is 74.2, above 70` |
| `oversold_rsi` | RSI(14) < 30 | 0.20 | `RSI(14) is 27.1, below 30` |
| `weakening_momentum` | MACD histogram < 0 | 0.20 | `MACD histogram is -12.40 (below signal line)` |
| `below_key_emas` | price < EMA20 < EMA50 | 0.15 | `Price 24812.3 vs EMA20 24880.1 / EMA50 24950.7` |
| `elevated_vix` | India VIX > 18 | 0.30 | `India VIX at 19.4 — elevated` |
| `elevated_realized_vol` | realised vol > 1.2%/bar | 0.20 | `Realized volatility 1.44% per bar over the last 20 bars` |
| `below_average_participation` | volume < 70% of 20-bar avg | 0.20 | `Current volume is 62% of the 20-bar average` |
| `weak_breadth` | advances/declines < 0.8 | 0.15 | `Advance/decline ratio is 0.71` |
| `consolidating_in_cpr` | BC ≤ price ≤ TC | 0.10 | `Price is trading inside the Central Pivot Range (24780.0–24845.0)` |

Note the phrasing: *"Momentum is weakening"*, never *"sell"*. The evidence string is written to be read aloud to the user without editing.

Note also that a signal is emitted **even when it does not trigger** — `sig('overbought_rsi', s.rsi14 > 70, …)` always pushes; `triggered` is the boolean. This is why `ObserveResponse.signals` can honestly power a "trap probability: low" reading.

### Alerts
None directly. Signals feed the orchestrator's composite gate.

### APIs
Internal only. Reached via `POST /observe`.

### UI
Market Context panel; contributes to the Day Classification card.

### Failure handling
A missing candle series produces `null` fields and fewer signals. A `getMarketBreadth()` failure yields `vix: null` and `breadthRatio: null` — the VIX-dependent signals silently do not emit. No exception propagates.

### Latency & caching
Target ≤80 ms for the snapshot. Dominated by two `getCandles` calls. 🔵 Snapshot cache keyed `(symbol, 15m-bucket)` with TTL to the next bar close would collapse concurrent observers on the same symbol to one computation.

### Future improvements
Multi-timeframe confluence (15m + 1H + 1D agreement as a signal in itself); volume-profile-derived levels replacing swing-based support/resistance; regime classification (trending / ranging / volatile) as a first-class snapshot field.

---

## 7.2 Options Intelligence 🟡

**Code:** partially in `TrapIntelligenceService`; a dedicated agent is specified.

### Purpose
Observe option-chain structure: implied volatility behaviour, open-interest build-up, put-call ratio, Greeks exposure, and expiry mechanics.

### Inputs

| Input | Source | Status |
|---|---|---|
| Option chain (strike × CE/PE: LTP, IV, OI, ΔOI, volume) | `OptionMetrics` table | 🔵 Migration 3 |
| Underlying spot | `MarketSnapshot.lastPrice` | 🟢 |
| Expiry calendar | `Instrument.expiryDate`, `expiryFlag` (M/W) | 🟢 |
| Risk-free rate | config | 🟢 |
| Greeks | `apps/web/src/lib/black-scholes.ts` (client) → server port | 🟡 |

### Processing 🔵

```
   chain snapshot
        │
        ├─► IV surface        → per-strike IV, skew, term structure
        ├─► OI profile        → concentration by strike, max-pain
        ├─► ΔOI               → build-up vs unwinding, long/short inference
        ├─► PCR               → OI-based and volume-based
        └─► Greeks aggregate  → net gamma / vega exposure by strike band
```

**Long/short build-up inference** is the classic four-quadrant read and is worth stating because it is easy to get backwards:

| Price | OI | Interpretation |
|---|---|---|
| ↑ | ↑ | Long build-up |
| ↑ | ↓ | Short covering |
| ↓ | ↑ | Short build-up |
| ↓ | ↓ | Long unwinding |

⚖️ Sentinel names the structure. It never converts the structure into a directional call.

### AI logic
None for the computation. The LLM may narrate the *result* in the orchestrator's synthesis, never derive it.

### Outputs 🔵

| Signal | Condition | Weight |
|---|---|---|
| `iv_crush_risk` | short-dated IV elevated vs 20-day mean into a known event | 0.30 |
| `gamma_concentration` | short-dated OI concentrated within ±1 strike of spot | 0.35 |
| `pcr_extreme` | OI PCR outside its 90-day 10th/90th percentile | 0.25 |
| `oi_unwinding` | ΔOI negative while price rises (short covering, not conviction) | 0.30 |
| `expiry_pin_risk` | spot within 0.5% of max-pain on expiry day | 0.30 |

### Failure handling
No chain data ⇒ no signals. The department is silent, not degraded, and never estimates a chain it does not have (DP7).

### Latency & caching
Chain snapshots are large. Target ≤150 ms with a 30-second cache — an option chain does not need tick-level freshness for structural analysis, and pretending otherwise would blow the Dhan rate budget.

### Future improvements
Volatility-surface modelling; strategy-aware analysis (recognising the user holds a spread rather than a naked leg, and observing *its* risk); IV rank and IV percentile as first-class fields.

---

## 7.3 Technical Analysis 🟢

**Code:** `services/sentinel/src/intelligence/indicators.ts` (server) · `apps/web/src/lib/technicals.ts` (client)

### Purpose
The shared indicator library every other department computes from.

### Implemented indicators

| Function | Returns | Used by |
|---|---|---|
| `ema(values, period)` | series | trend signals |
| `rsi(values, period=14)` | last value | overbought/oversold |
| `macd(values)` | `{ macd, signal, histogram }` | momentum |
| `vwap(candles)` | value | intraday fair-value reference |
| `cpr(dayCandle)` | `{ pivot, bc, tc }` | consolidation detection |
| `averageVolume(candles)` | 20-bar average | participation, breakout confirmation |
| `oiTrend(candles)` | `'rising' \| 'falling' \| 'flat' \| 'unknown'` | conviction |
| `realizedVolatilityPct(closes)` | % per bar | regime |
| `swingLevels(candles)` | `{ support, resistance }` | trap detection |

### The client/server split — why the same maths exists twice

Deliberate, with a rule:

| Compute where | When | Why |
|---|---|---|
| **Client** (`lib/technicals.ts`) | Chart overlays the user is looking at | Candles are already in the browser. Recomputing an EMA over 500 bars costs microseconds; a round trip costs 50–200 ms. |
| **Server** (`indicators.ts`) | Signal evaluation | Needs data the client does not have (breadth, VIX, OI) and must be reproducible for the audit trail. |

The risk is drift — two implementations of RSI disagreeing by a rounding convention, so the chart shows 70.1 and the signal says 69.9. 🔵 **Planned:** extract to `packages/indicators`, consumed by both. This is a real, unaddressed debt and is listed in Chapter 26 as TD-4.

> ⚠️ If you change an indicator, change both. Grep for the function name in `apps/web/src/lib/technicals.ts` before you commit.

### Future improvements
`packages/indicators` extraction; ATR, Bollinger, Supertrend, ADX; user-configurable periods (currently constants).

---

## 7.4 Macro Intelligence 🟡

**Currently:** India VIX and advance/decline breadth inside the market agent. **Specified:** a dedicated department.

### Purpose
Observe the environment a symbol trades in — index-level volatility, breadth, sector rotation, cross-asset signals (USDINR, crude, US futures, FII/DII flows).

### Inputs 🔵

| Input | Source | Status |
|---|---|---|
| India VIX | `getMarketBreadth().vix` | 🟢 |
| Advance/decline | `getMarketBreadth()` | 🟢 |
| Sector indices | index list | 🟡 |
| FII/DII flows | NSE daily publication | 🔵 |
| USDINR, crude, US futures | external feed | 🔵 |

### Outputs 🔵

| Signal | Condition | Weight |
|---|---|---|
| `risk_off_regime` | VIX > 20 **and** breadth < 0.7 **and** defensive sectors leading | 0.35 |
| `sector_divergence` | symbol's sector diverging > 1.5σ from the index | 0.25 |
| `fii_selling_pressure` | FII net negative 3+ consecutive sessions | 0.25 |
| `currency_stress` | USDINR 1-day move > 0.5% | 0.20 |

### Future improvements
Regime classification with hysteresis (a regime label that flips daily is noise); economic-surprise index; correlation-regime detection (Chapter 8 §8.14).

---

## 7.5 News Intelligence 🟢

**Code:** `services/sentinel/src/intelligence/news-intelligence.service.ts` (105 lines) · `packages/ai-core/src/news/news-event-classifier.ts`
**Table:** `NewsEvent`

### Purpose
Classify financial headlines into a standardised taxonomy and correlate unscheduled news with realised volatility.

### The thirteen-category taxonomy

Derived from the NVIDIA AI model-distillation blueprint for financial data. The categories are a closed vocabulary for the same reason the relation vocabulary is closed: downstream logic branches on them, and a free-text label would silently break that branching.

### Processing

```
   getNews([symbol], 24h)
        │
        ▼
   NewsEventClassifier  ──► ProviderManager.getLlm()
        │                    tier: 'fast', jsonMode
        │
        │  ⚠️ provider-agnostic: NVIDIA_NIM_BASE_URL can point at a
        │     distilled student model and classification runs on it
        │     with ZERO code change
        ▼
   { eventType, confidence, symbols[] }
        │
        ▼
   persist NewsEvent  ──► correlate with realizedVolPct
        │
        ▼
   Signal: news_driven_volatility
```

### AI logic — the one place an LLM is load-bearing

News classification is genuinely a language task; there is no arithmetic that turns a headline into a category. So this is the one department where the LLM does analytical work rather than styling.

The design constraint that keeps it safe: **the LLM outputs a category from a closed set, not prose.** A hallucinated category is either a valid category (harmless — worst case, a misclassification) or invalid (rejected at the boundary). It cannot hallucinate a recommendation, because it is not being asked for one.

### The distillation story

The provider abstraction means this classifier can run on a frontier model during development and on a **distilled student model** (NeMo Data Flywheel output, served via NVIDIA NIM) in production, selected purely by configuration. Same code, ~10–50× cheaper per classification, and news classification is exactly the high-volume-low-complexity workload distillation is for. Chapter 18 §18.12.

### Failure handling

News feed unavailable ⇒ the department emits a single untriggered `news_driven_volatility` signal rather than throwing. No provider configured ⇒ classification is skipped, headlines are still persisted unclassified.

### Future improvements
Sentiment scoring alongside classification; entity extraction into the knowledge graph; scheduled-vs-unscheduled distinction (an earnings release is not a surprise; a regulatory action is); source-credibility weighting.

---

## 7.6 Economic Events 🔵

### Purpose
Track scheduled macro events and observe positioning risk around them.

### Inputs 🔵
Economic calendar (RBI policy, CPI, IIP, GDP, US FOMC/CPI/NFP), earnings calendar, expiry calendar (weekly Thursday, monthly last Thursday, quarterly), corporate actions.

### Outputs 🔵

| Signal | Condition | Weight |
|---|---|---|
| `event_risk_ahead` | high-impact event within 24 h | 0.25 |
| `earnings_proximity` | symbol reports within 2 sessions | 0.30 |
| `expiry_week` | current week contains a monthly expiry | 0.20 |
| `post_event_iv_crush` | IV elevated pre-event, event now passed | 0.30 |

**Design note:** this department is unusual in producing signals about the *near future* rather than the present. That is acceptable because a calendar is a fact, not a prediction. `event_risk_ahead` says "RBI policy is on Thursday" — it does not say what will happen.

---

## 7.7 Risk Intelligence 🟡

**Currently:** regime signals in `TrapIntelligenceService`.

### Outputs (implemented) 🟢

| Signal | Condition | Weight |
|---|---|---|
| `high_risk_market_conditions` | India VIX > 20 | 0.30 |
| `expiry_day_conditions` | symbol matches option-expiry pattern **and** VIX > 15 | 0.25 |

The expiry detection is a regex on the trading symbol:

```ts
const expiryLike = /\d{2}[A-Z]{3}.*(CE|PE)$/.test(s.symbol);
```

Pragmatic and honest about being so. 🔵 Should become `Instrument.expiryDate` + `expiryFlag`, which already exist on the model — a real, small, worthwhile cleanup.

### Specified additions 🔵

| Signal | Condition | Weight |
|---|---|---|
| `concentration_risk` | one position > 40% of portfolio value | 0.30 |
| `correlated_exposure` | multiple positions with 90-day ρ > 0.8 | 0.30 |
| `drawdown_pressure` | account down > 15% from its peak | 0.35 |
| `leverage_elevated` | margin used > 70% of capital | 0.30 |

⚖️ Note what these do **not** do: they never say "reduce your position." They say "this position is 47% of your portfolio" — a fact about the user's own account, which the user may not have noticed.

---

## 7.8 Behavioural Intelligence 🟢

**Code:** `services/sentinel/src/intelligence/emotion-intelligence.service.ts` (88 lines)

The department the platform exists for. Full behavioural treatment in Chapter 10; the mechanics here.

### Purpose
Observe the user's own behaviour in-session: entry pacing, position sizing relative to their own average, exit timing, discipline drift, revenge trading, loss-streak pressure.

### Inputs — and the inversion that matters

```ts
signals(trades: TradeSummary[]): Signal[]
```

**One argument. No database. No I/O. A pure function.**

> *"Reads ONLY the trade summaries services/api passes in — Sentinel never queries trading tables itself."*

Consequences (§5.6.1): no trading credentials in Sentinel; a DTO contract instead of schema coupling; and the whole department is unit-testable with an array literal. This is the file where the test suite should begin.

### Processing — five detectors

All operate on the trade array sorted ascending by time.

**1. Revenge trading** — a new entry within 15 minutes of a *losing* exit.

```ts
for (let i = 1; i < sorted.length; i++) {
  const prevLoss = (sorted[i-1].realizedPnl ?? 0) < 0;
  const gapMin = (t(sorted[i]) - t(sorted[i-1])) / 60_000;
  if (prevLoss && gapMin >= 0 && gapMin <= 15) revengeCount++;
}
sig('revenge_trading', revengeCount >= 2, 0.35, [...]);
```

Threshold is **2**, not 1. One quick re-entry after a loss is a coincidence; two is a pattern. The `gapMin >= 0` guard is not paranoia — trade timestamps can arrive out of order.

**2. Overtrading** — ≥15 trades in the current IST calendar day. Weight 0.25.

**3. Position sizing drift** — last trade quantity ≥ 2× the session average. Weight 0.30.

> *"Position sizing on the last trade was 2.4x your session average"*

Compared against **the user's own average**, not an absolute. A trader whose normal size is 10 lots doubling to 20 is the same behavioural event as one going 1 → 2, and an absolute threshold would only ever catch one of them.

**4. Impatient pacing** — median gap between consecutive trades < 3 minutes. Weight 0.20. Median rather than mean, because one long lunch break should not mask a morning of rapid-fire entries.

**5. Loss streak** — 3+ consecutive losing trades. Weight 0.30. Streak resets only on a trade with a *defined* non-negative `realizedPnl` — position-opening trades (where `realizedPnl` is undefined) neither extend nor break a streak, which is correct: opening a position is not a win.

### AI logic
**None.** Every detector is arithmetic on timestamps and quantities.

This is the right choice for a deeply pragmatic reason: **behavioural observations are the most sensitive output the platform produces.** Telling someone their trading is emotional is a claim that must be defensible to the exact minute. An LLM inferring "you seem frustrated" from trade data would be unfalsifiable, unauditable, and — given it is about a person's money and self-image — genuinely harmful when wrong.

### Outputs

| Signal | Condition | Weight | Evidence |
|---|---|---|---|
| `revenge_trading` | ≥2 entries within 15 min of a losing exit | 0.35 | `3 entries within 15 minutes of a losing exit in this session` |
| `overtrading` | ≥15 trades today | 0.25 | `18 trades today` |
| `position_sizing_drift` | last size ≥ 2× session average | 0.30 | `Position sizing on the last trade was 2.4x your session average` |
| `impatient_pacing` | median gap < 3 min | 0.20 | `Median gap between trades is 1.8 minutes` |
| `loss_streak` | ≥3 consecutive losses | 0.30 | `Longest losing streak this session: 4 trades` |

Every evidence line is a **number the user can verify**. That is the whole design: an observation you can check is an observation you can argue with, and arguing with it is the mechanism by which a habit gets noticed.

### UI
Live Safety Feed cards, expandable into "Why" panels. ⚖️ **The panel shows a neutral signal-source label** — *"Behavioural signal"* — **never the internal agent name.** `emotion-intelligence` is an implementation detail and reads as a diagnosis.

### Latency
< 5 ms. Pure computation over a small array.

### Future improvements
Cross-session baselines (today vs. this user's 30-day norm — the current window is session-only); time-of-day patterns (does this user lose money in the last 20 minutes?); correlation with `JournalEntry.mood`; win-rate-after-loss as a first-class metric (the mockup's own figure: "win rate after a losing trade drops by 22%").

---

## 7.9 Portfolio Intelligence 🔵

### Purpose
Observe the portfolio as a system rather than as a list of positions.

### Inputs 🔵
`PositionSummary[]` (passed in, same inversion as trades), portfolio summary, historical P&L, instrument sector/correlation metadata.

### Processing 🔵

```
   positions[]
      ├─► concentration    → HHI, largest position %
      ├─► correlation      → pairwise ρ over 90 days
      ├─► sector exposure  → % by sector vs index weight
      ├─► Greeks aggregate → net delta/gamma/vega across option legs
      └─► drawdown         → current vs peak equity
```

### Outputs 🔵

| Signal | Condition | Weight |
|---|---|---|
| `concentration_risk` | largest position > 40% of value | 0.30 |
| `hidden_correlation` | 3+ positions with pairwise ρ > 0.8 | 0.35 |
| `sector_overweight` | one sector > 60% of exposure | 0.25 |
| `net_delta_drift` | aggregate delta opposite to the user's stated bias | 0.25 |

**`hidden_correlation` is the highest-value signal in this department.** A user holding HDFC Bank, ICICI Bank, and Axis Bank believes they hold three positions; they hold one bet with 3× size. Nothing else in the product tells them that.

---

## 7.10 Learning Intelligence 🟡

**Code:** `brain/outcome-learning.service.ts` (80) · `brain/ontology/concept-reinforcement.service.ts`

### Purpose
Close the loop: did the thing Sentinel noticed actually matter?

### Processing — outcome learning 🟢

```
   pattern_occurrence written with outcome: null
        │
        │  ⏳ ≥ 15 minutes (MIN_AGE_MS)
        ▼
   evaluatePending(5)   ← piggybacks on /observe, no scheduler
        │
        ├─► fetch current price
        ├─► movePct = (now - priceAtDetection) / priceAtDetection × 100
        │
        └─► label:  movePct > +0.3%  → 'continued_up'
                    movePct < -0.3%  → 'continued_down'
                    otherwise        → 'unclear'
```

### Why the labels are directional, not judgmental

`continued_up` / `continued_down` / `unclear`. Deliberately **not** `confirmed` / `failed`. The docstring is explicit:

> *"Directional labels only — deliberately not pattern-specific 'confirmed/failed' semantics, which would require opinionated per-pattern interpretation this phase doesn't build yet."*

This is disciplined. "Did the bull trap confirm?" requires deciding what confirmation *means* for a bull trap, which is a modelling opinion. "Did the price go up or down?" is a fact. Record facts now; layer interpretation later, when there is enough data to validate the interpretation.

### Concept reinforcement 🟢

Confirmed and refuted observations update `learnedWeight`, `supportCount`, and `refuteCount` on `ConceptEdge` — **never** the canonical `weight`. The column separation (Chapter 6, DP5) is what makes this safe.

### Promotion 🟢

When runtime learning is confident enough about a concept or relation the ontology does not contain, it writes a `ConceptPromotion` row:

```
   runtime evidence accumulates
        │
        ▼
   ConceptPromotion { kind, rationale, evidence, supportCount, confidence,
                      status: 'pending', dedupeKey }
        │
        ▼
   🧑 human reviews  ──► edits knowledge-base/<domain>/<id>.yaml
        │
        ▼
   next reseed ──► canonical
```

**Sentinel never edits the YAML.** The `dedupeKey` is a service-computed stable key rather than a composite unique constraint, because Postgres treats NULLs as distinct and most of the columns are nullable — a composite `@@unique` would not actually dedupe. That is a small, correct schema decision hiding a real bug that was avoided.

### Future improvements
Per-pattern outcome semantics once sample sizes support them; user-specific learning ("this user's revenge trades lose 2.3× more than their planned trades"); precision/recall reporting per signal so weights can be calibrated from data rather than judgement.

---

## 7.11 Research Intelligence 🟢

**Code:** `brain/research-trigger.service.ts` (38 lines) · `packages/ai-core/src/research/`

### Purpose
Fill knowledge gaps about symbols Sentinel has never encountered.

### The design constraint that defines it

> *"Event-driven, never uncontrolled crawling (locked decision). Fires exactly once per symbol Sentinel has never met before: checks the knowledge graph first, and only researches when there's genuinely nothing there yet."*

```ts
async researchIfUnfamiliar(symbol: string): Promise<void> {
  const existing = await this.graph.getNode(`symbol:${symbol}`);
  if (existing) return;                    // already known — no re-crawling
  await this.research.run({ query: `${symbol} stock company overview…`,
                            namespace: 'sentinel', learn: true, maxResults: 3 });
}
```

Three properties, all deliberate:

1. **Idempotent by knowledge-graph check.** Not by a cache, not by a timestamp — by whether the knowledge actually exists.
2. **Fire-and-forget.** `void …catch(() => undefined)` at the call site. Zero latency added to `/observe`.
3. **Silently no-ops without a provider.** `ProviderNotAvailableError` is caught and *not even logged*, because in local development it is the expected state, and a warning that fires on every request is a warning nobody reads.

### Future improvements
Scheduled refresh for stale entries (`MemoryRecord.staleAfter` exists and is unused); depth tiers (a quick overview vs. a full research run) gated by entitlement; source-credibility weighting.

---

## 7.12 AI Coach 🟡

### Purpose
Turn observations into learning. The coach is not a separate agent — it is the *soft suggestion* half of every output plus the Contextual Training surface.

### The coaching contract

```
   observation surfaced
        │
        ├─► soft suggestion   "Consider waiting for confirmation."
        │                     "What pattern do you notice about your
        │                      exit timing?"
        │
        └─► Contextual Training  ──► the Learning Hub lesson tied to
                                     today's DOMINANT observation
```

**One lesson, tied to the dominant pattern.** Not a list of resources. A user who receives a `revenge_trading` observation sees the lesson on trading after losses — not a curriculum menu.

### ⚖️ Never
- Never "you should have…" (blame)
- Never "next time, buy at…" (advice)
- Never a performance grade or score
- Never a comparison against other users

The register is a good coach's, not a scorekeeper's: describe what happened, ask what the person notices, offer the relevant material.

### Future improvements
Spaced repetition of lessons tied to recurring patterns; per-user coaching memory (do not surface the same lesson twice in a week); measured effectiveness (does the observed behaviour change after the lesson?).

---

## 7.13 Trade Validator 🔵

**Status: specified. ⚖️ Read the constraint before designing anything here.**

### Purpose
Observe a *pending* order — before it is placed — and comment on it.

### The constraint

> **This is the highest-risk department in the platform.** It sits closest to the order path and therefore closest to violating ARCH-3.

Binding rules:

| Rule | |
|---|---|
| V1 | It is called **in parallel** with the order ticket being open, never as a step in placement |
| V2 | Its response **never gates** the submit button |
| V3 | Its absence or failure changes **nothing** about order placement |
| V4 | It never says "don't place this" — it observes what is unusual about the order |
| V5 | It has **no** timeout that anything waits on |

### Correct interaction model

```
   user opens order ticket
        │
        ├──────────────────────────────► POST /observe { context: 'order_ticket_open' }
        │                                       │  (parallel, non-blocking)
        │                                       ▼
   user fills quantity, price               observation card appears
        │                                   beside the ticket
        ▼
   user clicks SUBMIT ────────────────► POST /sim/orders
        │                                (does NOT wait for, check,
        │                                 or reference Sentinel)
        ▼
   order placed
```

### Observations it may make 🔵

| Observation | Example |
|---|---|
| Size vs. own average | *"This order is 3.1× your average position size."* |
| Time-of-day pattern | *"Your last 8 trades in the final 20 minutes of the session were net negative."* |
| Instrument familiarity | *"This is your first trade in this instrument."* |
| Regime context | *"India VIX is at 22 — realised moves have been ~1.8× their monthly average."* |
| Sequence | *"This would be your fourth entry within 15 minutes of a losing exit today."* |

Every one is a **fact about the user's own history or the market**, never a judgement about the order.

---

## 7.14 Market Context Engine 🟢

**Code:** `brain/market-context.service.ts` (47 lines)

### Purpose

> *"Composes a short, educational narrative for the active symbol from the live technical snapshot plus whatever the Brain already remembers about it. Not a signal generator: it explains 'what's the story here', never 'what to do about it'."*

### Processing

```
   part 1  live snapshot
           "NIFTY is at 24812.35, RSI(14) 68.2, open interest rising."

   part 2  Brain retrieval (namespace 'sentinel', limit 5)
           hits > 0 → "Sentinel has 4 relevant memory record(s) about
                       NIFTY from past sessions."
           hits = 0 → "No prior Brain memory for NIFTY yet — this is a
                       fresh context that will build over time."
```

### The honesty of the empty case

The zero-hit branch is the department's best decision. Rather than saying nothing (which reads as broken) or fabricating context (DP7 violation), it states the truth: *this is a fresh context that will build over time.*

That single sentence sets a correct expectation about how the system works, turns an absence into an explanation, and costs one branch. It is a template for how every unavailable value in the product should read.

### Failure handling

Retrieval failure ⇒ `logger.warn`, part 1 still returned. The whole call is `.catch(() => undefined)` at the orchestrator, so a total failure yields `marketContext: undefined` and the response is otherwise complete.

### Future improvements
Richer narrative from graph traversal ("NIFTY's recent behaviour resembles the pattern cluster around…"); regime-aware framing; per-user context ("you have traded this symbol 14 times, most often in the morning session").

---

## 7.15 Building a new department

The checklist. If you cannot answer all of these, the department is not designed yet.

```
□ PURPOSE
  One sentence. What question does it answer?
  Does it answer a question no existing department answers?

□ INPUTS
  Where does each come from? What if one is missing?
  Does it need trading data? → it must be PASSED IN, never queried.

□ PROCESSING
  Deterministic? (It should be.)
  If not, why is language genuinely required here?

□ OUTPUTS
  Signals with: name (snake_case), triggered, weight, evidence[], data?
  Is each evidence line quotable to a user verbatim?
  Is the weight calibrated against §6.5 DP2?

□ COMPLIANCE ⚖️
  Which category does it map to in ComplianceService.categoryFor()?
  Any imperative language? Any price target? → reject.

□ FAILURE
  Silent, degraded, or absent — never thrown.
  Which reliability tier (§6.6.2)?

□ LATENCY
  Budget? Cache key? Does it add to the /observe critical path?

□ UI
  Which surface? What does the "Why" panel show?
  What NEUTRAL signal-source label — never the agent name.

□ TESTS
  A pure-function test with a literal input array.
  A test that it does NOT trigger on the boundary case.
```

---

*Next: [Chapter 8 — Sentinel: Analytical Engines](08-sentinel-engines.md)*
