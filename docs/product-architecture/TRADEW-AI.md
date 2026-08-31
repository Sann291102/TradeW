# TradeW AI (Research) — Product Blueprint

Status: **partially implemented.** The ambient **app-control / voice assistant** (§2.1) is live in `apps/web` (`src/lib/assistant/` — intent detection, planner, narration, voice output, domain guard; unit-tested) and drives navigation/panels/theme with a hard boundary against order-placement and trade calls. It is named **Tara** in the product (`lib/assistant/identity.ts`); this document's "TradeW AI" is the system, Tara is the assistant inside it.

**Market analysis shipped 2026-08-31, and NOT as an agent.** Tara answers "analyse NIFTY on 15m" from a *canonical observation projection* of the same `MarketSnapshot` that Sentinel's own observation and the autonomous paper agents are computed from — `services/sentinel` `POST /market-observation` → `services/api` `POST /market-analysis` → `lib/assistant/analysis.ts`. There is no Technical Analysis LLM agent and deliberately no fourth indicator implementation; the JSON is authoritative for every number and the client renders it verbatim. See §3a.

The remaining **Research** agent roster below (Company/News analysis, Strategy Builder, Portfolio Insights) is **not yet wired** — `services/tradew-ai` is a plan-router with no market-data access, and the primitives live in `packages/ai-core`. Grounded in the Emergent mockups (`docs/design-reference/DESIGN-SYSTEM.md`) and the PRD's explicit non-goal: **no discretionary advice**. Every feature below explains and analyzes; none of them tell the user what to buy or sell, and none place an order.

## 1. What it is, in one line

The teammate that helps a trader **understand** the market — charts, companies, news, options, their own portfolio — on demand, everywhere in the app, without ever crossing into advice.

## 2. Two surfaces, one system

TradeW AI isn't a single page — it's two things sharing one identity and one guardrail set:

1. **The ambient copilot** — the docked chat panel + floating trigger, available as an overlay from Home, Trading, Options, and Portfolio. This is where "Explain this chart" / "Explain my portfolio" / "Market pulse" quick actions live.
2. **The Research workspace** — a dedicated nav item for deep, structured, per-symbol analysis (Overview / Fundamentals / Financials / Shareholding / Corporate Actions / News / Technicals / Risk Factors tabs), entered by searching a symbol.

Both are powered by the same agent roster (§3) and the same `services/tradew-ai` runtime — the split is a UX surface distinction, not an architectural one.

## 3. Agent roster & responsibilities

| Agent | Job | Primary UI surface | Reads | Never does |
|---|---|---|---|---|
| **AI Researcher** (router/persona) | The face of the ambient copilot — greets, routes a free-text question to the right specialist agent below, holds conversation context | Docked chat | conversation history, active page context | Answer with a direct buy/sell instruction |
| **Company Analysis** | Powers Research's Overview/Fundamentals/Financials/Shareholding/Corporate Actions/Risk Factors tabs; answers "Explain This Company" | Research workspace | company fundamentals, filings, ownership data | Rate the company as a "buy" |
| **News Analysis** | Sentiment-tags and summarizes news (the positive/negative/neutral pills on Home's Live News); powers Research's News tab | Home, Research | news feed | Predict price impact as a certainty |
| ~~**Option Chain Analysis**~~ · **superseded** | PCR, max pain and the ATM CE/PE row are now *measured*, not narrated — served by the canonical observation route (§3a), not by an agent | Assistant dock | the front-expiry chain via `MarketSnapshot.optionChain` | Suggest a specific strike to trade |
| ~~**Technical Analysis**~~ · **superseded** | Chart structure (EMA/VWAP/RSI/MACD, support-resistance, BOS/CHoCH, liquidity) is now *measured* by the canonical engine and rendered deterministically (§3a). **The chart itself still exposes no indicator state** — `TradeChart.tsx` renders candles and price lines only — so "indicators in use on the active chart" was never readable and the engine's own reads are the source instead | Assistant dock | canonical `MarketSnapshot`, on the requested timeframe | Predict a price target |
| **Strategy Builder** | Helps construct and explains multi-leg option strategies and their payoff diagram; the user still adds/removes each leg manually | Options → Strategy Builder | user-constructed legs, live pricing | Auto-add or auto-execute a leg |
| **Portfolio Insights** | Powers "Explain my portfolio" and Sector Allocation commentary | Portfolio, ambient dock | user's holdings/positions (read-only, via `services/api`) | Recommend a rebalance action |
| **Learning Assistant** | Answers "what does this mean" style platform/terminology questions ("Ask AI to explain further" links) | Anywhere, low-stakes fallback | static help content, glossary | Access another user's data |

## 3a. Canonical market analysis (shipped 2026-08-31)

**The rule: one engine, three consumers.**

```
MarketIntelligenceService.snapshot(symbol, interval)   ← the canonical MarketSnapshot
  ├─ SentinelOrchestrator        → /observe             premium verdict
  ├─ ExecutionEvaluationService  → /execution/evaluate  autonomous paper agents
  └─ MarketObservationService    → /market-observation  Tara (measurements only)
```

Tara's `analyzeMarket` action carries only a symbol and a timeframe. The measurements come back as structured JSON and `lib/assistant/analysis.ts` formats them; **no language model is in the numeric path.** If RSI is 63.4 in the payload, 63.4 is what the user is told; if a measurement could not be taken it is `null` with a reason in `unavailable`, never a zero and never an estimate.

**What crosses the free/premium boundary.** Measurements do; conclusions do not. The projection type has no field for `synthesis`, `publication`, `sideInFocus`, `strategyAdvice`, `strategyMatches` or `confidence`, and both sides of the api↔sentinel hop check for them. This resolves the conflict recorded in [`TRADEW-ASSISTANT.md`](TRADEW-ASSISTANT.md) §6: reading VWAP off a chart is arithmetic anyone can do, and gating it protected nothing while the number stayed visible on screen. What users pay for is Sentinel deciding what the arithmetic *means*.

**Symbol coverage is explicit.** NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50, SENSEX, BANKEX and NSE equities route to the canonical snapshot. **Crypto and spot FX do not** — Sentinel's provider is Dhan/NSE-only with no simulator fallback, and the workspace charts crypto from Binance through a cross-origin TradingView iframe nothing on our side can read. `services/api/src/market-analysis/symbol-coverage.ts` classifies the symbol *before* any fetch, so a BTC request makes no outbound call to the NSE engine at all and comes back with a refusal that names the real data path. Running NSE indicators over a Binance market and presenting the result beside that market's chart would be fabrication.

**Timeframe is explicit end to end.** The request carries `symbol` + `timeframe`; the response carries the interval actually measured (`timeframe`), what was asked for (`requestedTimeframe`) and a note when they differ (the weekly pill is read on daily bars, and says so). The chart publishes its interval as `workspaceStore.chartTimeframe` — a field of its own, never parsed back out of `chartSeries.seriesKey`, whose format belongs to the drawing-staleness invariant.

## 4. Compliance guardrail (non-negotiable, per ARCHITECTURE.md §4)

- Every agent response carries the disclaimer pattern from the design system ("TradeW AI shares observations only — never investment advice.").
- Numeric/analytical claims cite recency and, where applicable, a confidence indicator — matching the "5 min ago · 82% confidence" pattern already in the mockup's Active AI Insights cards.
- No agent calls `services/trading-engine`. If a response implies a next step, the UI presents it as something the user must separately initiate through the normal order-entry flow (ARCHITECTURE.md §3) — the agent never has order-placement capability, not even gated.

## 5. Example workflows

**"Analyse the current chart" (as built, 2026-08-31):**
1. User says "analyse the current chart" (or "analyse NIFTY on 15m") from anywhere in the app.
2. The deterministic grammar resolves an `analyzeMarket` action. Nulls in it are filled from the live workspace — `selectedSymbol` and `chartTimeframe` — by the executor, never guessed by the grammar.
3. `POST /market-analysis` → `POST /market-observation` → the canonical `MarketSnapshot` on that interval, projected to measurements.
4. `lib/assistant/analysis.ts` renders the payload: price, OHLC, volume, RSI/EMA/VWAP/MACD/CPR, support and resistance, structure and any break of it, liquidity pools and sweeps, market profile and regime, index-direction votes, option-chain aggregates and the ATM CE/PE row, and data freshness — plus an explicit list of anything that could not be measured. The observation-only disclaimer is attached.

*What this is not:* an agent narrating a screenshot. There is no vision pass, no page narration, and no model-generated number.

**Deep company research:**
1. User opens Research, searches "RELIANCE."
2. Company Analysis agent populates the Overview tab (market cap, P/E, ROE, 52-week range, institutional activity, earnings calendar) — sourced from `services/market-data`/`services/analytics`, not generated by the LLM from nothing; the agent narrates and contextualizes real data, it doesn't invent figures.
3. "Explain This Company" invokes a synthesis pass across Fundamentals + News + Risk Factors tabs into one plain-language summary.

**Portfolio insight:**
1. User taps "Explain my portfolio" from the Home dashboard.
2. Portfolio Insights agent reads current holdings/sector allocation (read-only, via `services/api`) and narrates concentration, notable movers, and sector tilt — framed as observation ("your IT allocation has grown to X% this month"), not as a rebalancing instruction.

## 6. Data dependencies

- `services/sentinel` (via `services/api`, read-only) — the canonical `MarketSnapshot` projection behind §3a. The **only** source of indicator, structure and option measurements; `apps/web` computes none of its own
- `services/market-data` — live quotes, OHLC, sector data
- `services/analytics` — fundamentals, institutional activity, portfolio aggregates
- `services/trading-engine` (via `services/api`, read-only) — positions/orders for portfolio commentary only, never for placing/modifying orders
- `agents/tradew-ai/` — the declarative definitions for each agent in §3
