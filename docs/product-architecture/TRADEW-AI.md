# TradeW AI (Research) — Product Blueprint

Status: design, pre-implementation. Grounded in the Emergent mockups (`docs/design-reference/DESIGN-SYSTEM.md`) and the PRD's explicit non-goal: **no discretionary advice**. Every feature below explains and analyzes; none of them tell the user what to buy or sell, and none place an order.

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
| **Option Chain Analysis** | Explains PCR, Max Pain, IV skew, OI shifts; answers "Explain this chart" when invoked from the Options page | Options workspace (via ambient dock) | live option chain, Greeks | Suggest a specific strike to trade |
| **Technical Analysis** | Explains chart structure (EMA/VWAP/support-resistance, the "AI: Observed support zone" annotation style) when "Explain this chart" is invoked from Trading | Trading workspace (via ambient dock) | OHLC, indicators in use on the active chart | Predict a price target |
| **Strategy Builder** | Helps construct and explains multi-leg option strategies and their payoff diagram; the user still adds/removes each leg manually | Options → Strategy Builder | user-constructed legs, live pricing | Auto-add or auto-execute a leg |
| **Portfolio Insights** | Powers "Explain my portfolio" and Sector Allocation commentary | Portfolio, ambient dock | user's holdings/positions (read-only, via `services/api`) | Recommend a rebalance action |
| **Learning Assistant** | Answers "what does this mean" style platform/terminology questions ("Ask AI to explain further" links) | Anywhere, low-stakes fallback | static help content, glossary | Access another user's data |

## 4. Compliance guardrail (non-negotiable, per ARCHITECTURE.md §4)

- Every agent response carries the disclaimer pattern from the design system ("TradeW AI shares observations only — never investment advice.").
- Numeric/analytical claims cite recency and, where applicable, a confidence indicator — matching the "5 min ago · 82% confidence" pattern already in the mockup's Active AI Insights cards.
- No agent calls `services/trading-engine`. If a response implies a next step, the UI presents it as something the user must separately initiate through the normal order-entry flow (ARCHITECTURE.md §3) — the agent never has order-placement capability, not even gated.

## 5. Example workflows

**"Explain this chart" (ambient copilot, from Trading):**
1. User taps "Explain this chart" while viewing RELIANCE's 15m chart with EMA active.
2. `services/api` forwards the request to `services/tradew-ai`'s Technical Analysis agent with the chart's current symbol/timeframe/indicator context (read-only).
3. Agent returns a plain-language read of price structure + volume context (mirrors the mockup's actual sample output: "price is consolidating above the 20-EMA... Volume has been below the 10-session average...").
4. Response renders in the dock with the standard disclaimer and a set of next-step quick-action chips (e.g. "Explain my portfolio", "Market pulse") — not a "Buy"/"Sell" button.

**Deep company research:**
1. User opens Research, searches "RELIANCE."
2. Company Analysis agent populates the Overview tab (market cap, P/E, ROE, 52-week range, institutional activity, earnings calendar) — sourced from `services/market-data`/`services/analytics`, not generated by the LLM from nothing; the agent narrates and contextualizes real data, it doesn't invent figures.
3. "Explain This Company" invokes a synthesis pass across Fundamentals + News + Risk Factors tabs into one plain-language summary.

**Portfolio insight:**
1. User taps "Explain my portfolio" from the Home dashboard.
2. Portfolio Insights agent reads current holdings/sector allocation (read-only, via `services/api`) and narrates concentration, notable movers, and sector tilt — framed as observation ("your IT allocation has grown to X% this month"), not as a rebalancing instruction.

## 6. Data dependencies

- `services/market-data` — live quotes, OHLC, sector data
- `services/analytics` — fundamentals, institutional activity, portfolio aggregates
- `services/trading-engine` (via `services/api`, read-only) — positions/orders for portfolio commentary only, never for placing/modifying orders
- `agents/tradew-ai/` — the declarative definitions for each agent in §3
