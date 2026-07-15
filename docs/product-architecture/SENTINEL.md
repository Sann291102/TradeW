# Sentinel (Safety Nets) — Product Blueprint

Status: design, pre-implementation. Grounded in the Emergent mockups' actual Sentinel workspace and the architecture doc's "Safety Nets" concept (Phase 4). Sentinel's job is to help a trader **avoid costly mistakes** — it observes, explains its concern, and asks questions. It never blocks an order and never issues an instruction.

## 1. Why this is a separate system from TradeW AI

TradeW AI answers "what does this mean?" (market/company/portfolio understanding). Sentinel answers "am I about to do something I'll regret?" (behavioral and structural risk). Different question, different data (Sentinel needs the user's *own* trading behavior history, not just market data), different tone (diagnostic and reflective, not explanatory), and — per the mockup — a visibly different workspace with its own nav entry, not a tab inside Research.

## 2. Agent architecture (as already defined in the mockup — not reinvented here)

The landing page's "Live Agent Desk Preview" and the four feature cards on the Sentinel marketing section map directly to four agents plus one synthesizer:

| Agent | Job | Primary inputs |
|---|---|---|
| **Market & Technical Intelligence** | Continuously observes technical structure — OHLC, EMA, RSI, VWAP, CPR, volume, OI, IV — across whatever the user is watching or holding | live market data, option chain |
| **Emotion Intelligence** | Observes the user's own behavior in-session: entry pacing, position sizing relative to their average, exit timing, discipline drift, revenge-trading and FOMO patterns | user's own order/trade history, session timing (via `services/trading-engine`, read-only) |
| **Trap & Safety Intelligence** | Specializes in composite trap detection (§3) — combines signals from the two agents above rather than watching for any single pattern in isolation | outputs of Market & Technical + Emotion agents, news feed |
| **Compliance & Audit** | Logs every observation from the other three agents with evidence and a SEBI-relevant category label, building the audit trail the mockup's "Observation Feed" and "Agent Activity Timeline" are backed by | outputs of the other three agents |
| **Sentinel Orchestrator** | Synthesizes across all four into the single, user-facing warning or reflection — this is the "combine multiple signals before warning" behavior explicitly wanted; no individual agent talks to the user directly | outputs of all four agents above |

This mirrors the UI states already shown ("observing" / "observing" / "synthesizing") — the orchestrator is the only one that produces user-facing copy; the other agents produce structured internal observations it draws on.

## 3. Trap Detection — composite signal design

Each of these is a **signal**, not a standalone verdict. The Trap & Safety Intelligence agent computes all applicable signals for the user's current context, and the Sentinel Orchestrator only surfaces a warning when enough signals corroborate each other — matching the example already given: low volume *and* declining OI *and* a breakout, together, not any one alone.

| Signal | What it needs | What it looks for |
|---|---|---|
| Fake breakout detection | OHLC, volume | Price crosses a level but volume doesn't confirm |
| Bull trap | OHLC, volume, OI | Breakout above resistance reverses quickly |
| Bear trap | OHLC, volume, OI | Breakdown below support reverses quickly (the mockup's actual example: "sharp dip below support reclaimed within 2 candles") |
| Liquidity sweep | OHLC (wicks), OI | Price briefly pierces a level (stop cluster) then reverses |
| Stop-hunt detection | OHLC, order-book/OI proxy | Sharp wick through an obvious stop-loss level, no follow-through |
| FOMO entries | user's own entry timing vs. move already in progress | User entering after a large move already happened |
| Chasing green candles | user's entry sequence | Repeated entries immediately after consecutive up candles |
| Averaging down emotionally | user's position-add history vs. price | Adding size into a loss without a pre-set plan |
| Revenge trading after a loss | user's trade timestamps | New entry within a short window of a losing exit (mockup's own metric: "win rate after a losing trade drops by 22%") |
| Low-volume breakout warnings | volume vs. 20-day average | Breakout with below-average participation (the mockup's literal example output) |
| News-driven volatility alerts | news feed + realized volatility | A breakout coinciding with an unscheduled news event |
| Expiry-day options traps | expiry calendar, OI | Elevated risk of pin/whipsaw price action near expiry |
| Gamma squeeze / IV crush warnings | OI, IV term structure | Concentration of short-dated OI at nearby strikes; IV collapsing into/after an event |
| High-risk market conditions | India VIX, breadth | Elevated index-level volatility regardless of the specific symbol |

**Output tone contract** (already established by the mockup, keep it exactly): explain the concern, cite the specific evidence, suggest waiting for confirmation — never a flat "don't buy." E.g.: *"Price has broken above resistance, but volume is below the 20-day average and open interest is declining. This resembles a low-conviction breakout. Consider waiting for confirmation."* Every generated warning should follow this **evidence → pattern-name → soft suggestion** structure.

## 4. Full feature set (safety nets + supporting workspace features)

From the user's list, plus what the mockup shows is already built around them:

- Emotion Detection, FOMO Detection, Revenge Trading Detection, Overtrading Detection — outputs of the Emotion Intelligence agent, surfaced via **Reflection Cards** ("Exit Discipline", "Revenge Trading", "Holding Time" categories seen in the mockup), each ending in a "Reflect with AI ↗" prompt, not a verdict.
- Position Sizing Check — Emotion Intelligence agent, surfaced in the **Observation Feed** ("Position sizing on last trade was 2.4x your average — noted for journal review").
- Stop Loss Validation, Trail Stop Assistant, Exit Timing Coach, Wait Confirmation — Market & Technical + Emotion agents jointly; these are the "soft suggestion" half of the Trap & Safety output, not separate UI sections.
- Trap Detection — Trap & Safety Intelligence agent, §3.
- Risk Warnings — Sentinel Orchestrator's synthesized output, shown as the top-level alert cards (e.g. the "Bear Trap" callout card).
- Trading Psychology Coach — the **Trading Journal** (mood-tagged entries: Focused/Anxious/Confident/Frustrated, with "flagged by AI Sentinel" annotations) plus the **Session Summary** panel (Trades Today, Plan Adherence %, Discipline Δ, Flagged Events) — this is the longitudinal, reflective layer above the real-time Reflection Cards.
- **Agent Activity Timeline** and **Observation Feed** — the Compliance & Audit agent's user-visible output; every entry here must be traceable to a logged, evidenced observation (ARCHITECTURE.md's SEBI/DPDP compliance-first requirement).

## 5. UI workspace layout (per the mockup, don't redesign this)

Sentinel is a full nav-level workspace (not a dock overlay like TradeW AI): top alert callout cards → AI Reflection Cards row → three-column footer (Agent Activity Timeline / Observation Feed / Session Summary) → Trading Journal below the fold. Shares the same top bar/sidebar chrome as every other workspace (design system §3).

## 6. Compliance guardrails (non-negotiable)

- Sentinel **never blocks or delays an order** — it observes and comments in parallel with the normal order flow (ARCHITECTURE.md §3), it is not a gate in that flow.
- Every observation is logged with evidence and a SEBI-relevant label via the Compliance & Audit agent — this is what makes the Observation Feed defensible, not just a UX flourish.
- Language is always diagnostic/reflective ("Consider waiting for confirmation", "What pattern do you notice?"), never directive ("Don't buy", "Sell now").

## 7. Data dependencies

- `services/trading-engine` (via `services/api`, read-only) — the user's own order/trade/position history, for Emotion Intelligence
- `services/market-data` — live OHLC, volume, OI, IV, VIX
- News feed (shared with TradeW AI's News Analysis agent — same underlying feed, different consumer)
- `agents/sentinel/` — declarative definitions for the four agents + orchestrator in §2
