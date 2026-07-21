# Sentinel (Safety Nets) — Product Blueprint

Status: design, pre-implementation. Grounded in the Emergent mockups' actual Sentinel workspace and the architecture doc's "Safety Nets" concept (Phase 4). Sentinel's job is to help a trader **avoid costly mistakes** — it observes, explains its concern, and asks questions. It never blocks an order and never issues an instruction.

## 1. Why this is a separate system from TradeW AI

TradeW AI answers "what does this mean?" (market/company/portfolio understanding). Sentinel answers "am I about to do something I'll regret?" (behavioral and structural risk). Different question, different data (Sentinel needs the user's *own* trading behavior history, not just market data), different tone (diagnostic and reflective, not explanatory), and — per the mockup — a visibly different workspace with its own nav entry, not a tab inside Research.

"Separate system" here means a separate **runtime and agent roster** (`services/sentinel`, `agents/sentinel/`), not a separate product. Sentinel is a workspace inside TradeW and the AI intelligence layer beneath the platform — see §5.

## 2. Agent architecture (as already defined in the mockup — not reinvented here)

The landing page's "Live Agent Desk Preview" and the four feature cards on the Sentinel marketing section map directly to four agents plus one synthesizer:

| Agent | Job | Primary inputs |
|---|---|---|
| **Market & Technical Intelligence** | Continuously observes technical structure — OHLC, EMA, RSI, VWAP, CPR, volume, OI, IV — across whatever the user is watching or holding | live market data, option chain |
| **Emotion Intelligence** | Observes the user's own behavior in-session: entry pacing, position sizing relative to their average, exit timing, discipline drift, revenge-trading and FOMO patterns | user's own order/trade history, session timing (via `services/trading-engine`, read-only) |
| **Trap & Safety Intelligence** | Specializes in composite trap detection (§3) — combines signals from the two agents above rather than watching for any single pattern in isolation | outputs of Market & Technical + Emotion agents, news feed |
| **Compliance & Audit** | Logs every observation from the other three agents with evidence and a SEBI-relevant category label, building the audit trail each Live Safety Feed card's "Why" panel draws its evidence from (§4, §5) | outputs of the other three agents |
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

## 4. Full feature set (safety nets + supporting application features)

Updated 2026-07-21 to map onto the current, binding UI (§5) rather than the archived shared-shell dashboard. Every item below is still the same underlying agent behavior — only which component surfaces it changed:

- Emotion Detection, FOMO Detection, Revenge Trading Detection, Overtrading Detection, Position Sizing Check — outputs of the Emotion Intelligence agent, surfaced as **Live Safety Feed** cards (e.g. "Pause", "Enough", "Book & Breathe"), each expandable into a "Why" panel showing evidence and confidence — never a verdict.
- Stop Loss Validation, Trail Stop Assistant, Exit Timing Coach, Wait Confirmation — Market & Technical + Emotion agents jointly, also surfaced as Live Safety Feed cards ("Wait & Watch", "Trail or Exit"); these are the "soft suggestion" half of the Trap & Safety output, not separate UI sections.
- Trap Detection — Trap & Safety Intelligence agent, §3, reflected in the Market Context panel's trap-probability reading and, when a specific signal triggers, its own Live Safety Feed card.
- Risk Warnings — Sentinel Orchestrator's synthesized output, shown as the pinned, highest-priority card at the top of the Live Safety Feed (replaces the old top-level alert callout card).
- Trading Psychology Coach — today expressed as **Contextual Training**, surfacing the lesson tied to the session's dominant observation. The mood-tagged Trading Journal component still exists in code but isn't part of the current bound UI — reintroducing it as a longitudinal view is an open product decision, not yet specified here.
- **Compliance & Audit agent's output** — every observation is still logged with evidence server-side exactly as before (ARCHITECTURE.md's SEBI/DPDP compliance-first requirement); it is no longer exposed as a dedicated user-facing "Agent Activity Timeline"/"Observation Feed" — evidence is surfaced per-card via each Live Safety Feed card's "Why" panel instead. A full historical audit view, if needed, is an admin/backend concern, not a Sentinel-application feature today.

## 5. UI: a premium workspace inside TradeW

**Status: binding.** Sentinel shares the shell described in `docs/design-reference/DESIGN-SYSTEM.md` §3 — persistent icon-rail sidebar, shared top bar — with Core Platform, TradeW AI and Learning Hub. It is the platform's flagship premium intelligence workspace and the AI intelligence layer beneath the rest of the product, reached from the shared sidebar like any other pillar (`TRADEW-OS.md` §1, `ARCHITECTURE.md` §2.2).

Sentinel's workspace has its own layouts, screens and workflows because what it does differs from trading or research. That is a workspace difference, not a product boundary: same shell, same design language, same navigation, same auth, same entitlements. A user entering Sentinel has not left TradeW.

**Marketing (pre-auth) is a separate concern.** A dedicated Sentinel landing page, marketing site, domain or subdomain — hero, problem statement, how it works, feature overview, screenshots, pricing (per `SUBSCRIPTIONS.md`), FAQ, "Start Free" CTA — is fine and expected, because marketing reaches people who are not yet users. The boundary is sign-in: after authentication the user lands in the TradeW application, in the Sentinel workspace, with the full shared shell around them.

**Entitlement gates reasoning, not visibility.** Sentinel is always visible in the sidebar. An authenticated but unentitled user sees the workspace with an in-app locked state and an Upgrade CTA in place of live observations — never a hidden or missing nav item (`SUBSCRIPTIONS.md` §4, `TRADEW-OS.md` §3).

> **Reversed direction, 2026-07-21.** This section previously specified a standalone marketing site plus a separate Sentinel-only application with no shared sidebar, no TradeW branding and no cross-links to other pillars. That was a misreading of the product vision — TradeW is one ecosystem in the sense that Bloomberg Terminal, Microsoft 365, Adobe Creative Cloud and Notion are one ecosystem — and it has been reversed.
>
> It was **never executed in code.** `apps/web/src/app/sentinel/page.tsx` renders inside the shared shell today. An earlier attempt at a chrome-less Sentinel page was reverted the same day for a concrete reason worth remembering: it left the user no way to navigate back out.

The workspace answers the same five standing questions this document has always specified, rendered as:

- a **Day Classification** hero card — day label (Trend/Selective/Choppy/Trap-Prone/Quiet), confidence, plain-language explanation, supporting signals;
- a **Market Context** panel — volatility, momentum, trap probability, market structure, and any dimension without a real backing signal (e.g. institutional participation) reported honestly as not yet available, never fabricated;
- a **Live Safety Feed** — chronological, plain-language cards (Wait & Watch, Enough, Book & Breathe, Trail or Exit, Pause, Setup Forming), each expandable into a **Why** panel showing evidence, confidence, and a neutral signal-source label (e.g. "Behavioral signal", "Structural risk signal") — never an internal agent name;
- **Contextual Training** — the Learning Hub lesson tied to today's dominant observation;
- a closing **Timeline** of session observations.

**Everything platform-level is shared, and must never be duplicated for Sentinel:** authentication, users, organizations, permissions, entitlements, billing, market data, portfolio data, orders, positions, watchlists, AI infrastructure, backend services, APIs, database, event system, notifications. `services/sentinel` is reached only through `services/api` as the single ingress, gated by the same JWT + entitlement/capability system as every other pillar (`hasCapability('sentinel')`). A second implementation of any of the above for Sentinel is an architecture violation (`TRADEW-OS.md` §2.1, "extend before you build").

`terminal/panels/SentinelPanel.tsx` (Core Platform's `/trade` dock) remains a locked/upgrade teaser cross-selling Sentinel — it links to the `/sentinel` workspace in the same application, not out to a separate product.

## 6. Compliance guardrails (non-negotiable)

- Sentinel **never blocks or delays an order** — it observes and comments in parallel with the normal order flow (ARCHITECTURE.md §3), it is not a gate in that flow.
- Every observation is logged with evidence and a SEBI-relevant label via the Compliance & Audit agent — this is what makes each Live Safety Feed card's "Why" panel defensible, not just a UX flourish.
- Language is always diagnostic/reflective ("Consider waiting for confirmation", "What pattern do you notice?"), never directive ("Don't buy", "Sell now").

## 7. Data dependencies

- `services/trading-engine` (via `services/api`, read-only) — the user's own order/trade/position history, for Emotion Intelligence
- `services/market-data` — live OHLC, volume, OI, IV, VIX
- News feed (shared with TradeW AI's News Analysis agent — same underlying feed, different consumer)
- `agents/sentinel/` — declarative definitions for the four agents + orchestrator in §2
