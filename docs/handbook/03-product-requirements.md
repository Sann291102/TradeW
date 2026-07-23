# Chapter 3 — Product Requirements Document

**Document status:** Binding for scope decisions. Supersedes ad-hoc scope discussion in `docs/product-architecture/*`, which remains authoritative for *design* while this chapter is authoritative for *what is in and out*.

---

## 3.1 Vision statement

> **TradeW is the operating system Indian retail derivatives traders live inside: it teaches before it executes, observes before it advises, and never tells anyone what to buy.**

Success looks like a trader who has been on the platform for six months placing fewer, better-reasoned trades than they did in month one — and being able to point at the platform as the reason.

---

## 3.2 Problem statement

### 3.2.1 The market

India has the world's largest listed derivatives market by contract volume, driven overwhelmingly by retail participation in weekly index options. SEBI's own repeatedly-published studies find that a large majority of individual F&O traders lose money, and that the losses are concentrated in high-frequency, short-holding-period activity.

The instinctive product response is *"give them better information."* We believe that response is wrong, and the entire platform is built on the alternative.

### 3.2.2 The five problems we actually target

| # | Problem | Evidence in trader behaviour | TradeW's answer |
|---|---|---|---|
| **P1** | **Behavioural leakage** — the plan is fine, the execution is not | Revenge entries within minutes of a loss; position size doubling after a win; averaging into losers | Sentinel Emotion Intelligence: observes the user's own trade sequence and reflects it back with evidence |
| **P2** | **Structural blindness** — the chart looks like a breakout and is not | Buying a breakout on 60% of average volume with declining OI | Sentinel Trap & Safety Intelligence: composite signals, never a single indicator |
| **P3** | **Practice without consequence** — demo accounts that teach nothing | Paper platforms with fake prices, instant fills, no margin, no slippage | A full paper OMS filling against **real live prices** with simulated margin that can genuinely reject |
| **P4** | **Explanation deficit** — tools state conclusions, never reasoning | "RSI: 71 — Overbought" with no context on regime, timeframe, or reliability | Explainability contract: every premium output shows evidence, confidence, precedent, sources |
| **P5** | **Fragmentation** — the workflow spans five products | Chart in one app, option chain in another, journal in a spreadsheet, learning on YouTube | One workspace: shared shell, shared auth, shared state, resumable |

### 3.2.3 What we deliberately do not treat as a problem

- **"Users can't find good signals."** Providing signals is the crowded, regulated, adversarial market we are explicitly not entering.
- **"Execution is too slow."** We are not competing on order latency; we are not a broker.
- **"Fees are too high."** Not our lever. Brokerage is the broker's business.

---

## 3.3 Target users

### 3.3.1 Market segmentation

```
                        SOPHISTICATION →
        │  ┌────────────────┬────────────────┬────────────────┐
   C    │  │  Curious       │  Committed     │  Semi-Pro      │
   A  ↑ │  │  Beginner      │  Retail        │  ▓▓▓▓▓▓▓▓      │
   P    │  │  ░░░░░░░░      │  ████████      │  secondary     │
   I    │  │  entry funnel  │  CORE MARKET   │                │
   T    │  ├────────────────┼────────────────┼────────────────┤
   A    │  │  Lottery-      │  Frustrated    │  Prop / Inst.  │
   L    │  │  ticket        │  Improver      │  ✗ NOT TARGET  │
        │  │  ✗ NOT TARGET  │  ████████      │                │
        │  │                │  CORE MARKET   │                │
        │  └────────────────┴────────────────┴────────────────┘
```

**Core market:** the Committed Retail trader and the Frustrated Improver — people who trade regularly, have lost money, know it is their own behaviour, and want a system rather than a tip.

**Explicitly not targeted:** the lottery-ticket buyer (cannot be helped by observation; will churn), and institutional/prop desks (need execution infrastructure and direct market access we do not and will not build).

### 3.3.2 Scale assumptions

| Metric | Year 1 target | Year 3 target | Architectural implication |
|---|---|---|---|
| Registered users | 10,000 | 250,000 | Postgres single instance → read replicas |
| Monthly actives | 3,000 | 80,000 | — |
| Peak concurrent sessions | 500 | 20,000 | `services/auth` extraction trigger is 50k |
| Peak concurrent WebSocket subscribers | 500 | 20,000 | Fan-out from the singleton ingestor; Chapter 12 §12.9 |
| Paper orders / day | 5,000 | 200,000 | Matching-engine poll interval revisit at ~50k resting orders |
| Sentinel `/observe` calls / day | 20,000 | 1,000,000 | Cache + composite gate keep LLM calls ≪ observe calls |

---

## 3.4 Personas

### Persona 1 — Arjun, 29, "The Committed Retail Trader" 🎯 **PRIMARY**

| | |
|---|---|
| **Role** | Software engineer, Bengaluru. Trades NIFTY/BANKNIFTY weekly options around a full-time job. |
| **Capital** | ₹3–5 lakh trading capital. Down ~₹80,000 over 18 months. |
| **Volume** | 8–15 trades/week, mostly 09:15–10:30 and 14:30–15:20 |
| **Tools today** | Zerodha Kite, TradingView (free), a Telegram group he does not trust, a Google Sheet journal he stopped updating in month three |
| **Sophistication** | Reads charts competently. Knows what IV and theta are. Cannot explain why his win rate collapses after a loss. |
| **Frustration** | *"I know what I'm supposed to do. I don't do it. And I don't notice until I look at the month."* |
| **Job to be done** | "Notice the thing I'm doing wrong, while I'm doing it, and show me the evidence so I can't argue." |
| **What he pays for** | Sentinel. He will not pay for signals; he has tried three and none worked. |
| **Success signal** | Trade count down 30%, average holding period up, and he can articulate a rule he now follows. |
| **Anti-pattern that loses him** | A card that says "Don't buy." He will disable notifications the same day. |

### Persona 2 — Priya, 24, "The Curious Beginner" 🎯 **PRIMARY (funnel)**

| | |
|---|---|
| **Role** | Recent MBA, Pune. First job. Has never placed a derivatives trade. |
| **Capital** | ₹50,000 saved, unwilling to risk it yet — correctly. |
| **Tools today** | YouTube, Instagram finfluencers, a demat account she has not funded |
| **Sophistication** | Knows "call" and "put". Does not know what a lot size is or why her ₹50,000 could vanish in an afternoon. |
| **Frustration** | *"Everyone assumes I already know. And every 'course' is someone selling a course."* |
| **Job to be done** | "Let me practise for real, with real prices, until I understand — and stop me before I fund the account too early." |
| **What she pays for** | Learning Hub Lifetime (₹299). Low friction, high perceived value. |
| **Success signal** | 90 days of paper trading, curriculum completion, and — importantly — she has *not* funded a live account yet. |
| **Design implication** | Every screen must be legible without prior jargon. This is why `explainer` is a required field on `ConceptNode` — the text users actually read, distinct from `definition`. |

### Persona 3 — Rakesh, 41, "The Frustrated Improver" 🎯 **PRIMARY**

| | |
|---|---|
| **Role** | Small-business owner, Surat. Trades since 2019. |
| **Capital** | ₹15–25 lakh. Profitable in 2021, flat-to-down since. |
| **Volume** | 20–40 trades/week, including intraday equity and index options |
| **Tools today** | Multiple brokers, an Excel model he built himself, a paid scanner, an options analytics site |
| **Sophistication** | High. Understands Greeks, IV rank, OI build-up. Builds spreads. |
| **Frustration** | *"My analysis is fine. My discipline in month three of a drawdown is not."* |
| **Job to be done** | "Institutional-grade analytics in one place, plus something that notices when I'm revenge-trading a drawdown." |
| **What he pays for** | Sentinel annual (₹999/mo on a 12-month commitment). Price-insensitive relative to his account size; quality-sensitive. |
| **Success signal** | Consolidates three tools into TradeW. Uses the journal. Renews. |
| **What loses him instantly** | A fabricated number. If the Market Context panel claims "institutional participation: high" without a real backing signal, he will notice, and he will leave. This is why `SENTINEL.md` §5 mandates reporting unavailable dimensions **honestly as not yet available, never fabricated.** |

### Persona 4 — Meera, 34, "The Systematic Semi-Pro" ⚪ **SECONDARY**

Trades full-time, ₹50 lakh+, runs a rules-based system, wants backtesting and API access. Served incidentally by `packages/sdk` (Phase 3) and the analytics surface. **We do not build features specifically for her in Year 1.** Recorded here so that "Meera would want X" is recognised as a scope-creep argument.

### Persona 5 — Dev, 31, "The Platform Engineer" 🛠️ **INTERNAL**

The reader of this handbook. Needs: local environment in fifteen minutes, decision records instead of tribal knowledge, honest status markers, and the ability to ship without breaking a regulated system. If Dev's needs are unmet, none of the other four personas get served.

---

## 3.5 Business goals

| # | Goal | Year 1 target | Measurement |
|---|---|---|---|
| **B1** | Establish paid conversion on intelligence, not execution | 4% of MAU on a paid tier | Subscription table, `status IN (ACTIVE, TRIALING)` |
| **B2** | Prove the behavioural thesis with data | Measurable behaviour change in ≥30% of Sentinel users after 60 days | Cohort analysis on `SentinelObservation` + `Trade` |
| **B3** | Learning Hub as a low-friction entry product | 15% of registered users purchase Lifetime (₹299) | — |
| **B4** | Keep infrastructure cost per MAU below ₹8/month | ≤₹8 | Cloud billing ÷ MAU |
| **B5** | Zero regulatory findings | 0 | SEBI/DPDP posture review, quarterly |
| **B6** | Retention over acquisition | 60% D30 retention for users who complete onboarding | — |

### 3.5.1 Pricing model

| Product | Price | Notes |
|---|---|---|
| **Demo (paper) — Free** | ₹0 | Full OMS. Real prices. No order limit. Basic market data. |
| **Demo — Weekly** | ₹99/week | Extended historical depth, more watchlists, more layouts |
| **Demo — Monthly** | ₹199/month | As above, plus higher AI research quota |
| **Learning Hub — Lifetime** | ₹299 one-time | Full curriculum, permanent access |
| **Sentinel — Monthly** | ₹1,399/month | Full premium reasoning, explainability, Brain access |
| **Sentinel — Annual** | ₹999/month (billed annually) | Same, 28% commitment discount |

**Never priced:** order placement, positions, portfolio, P&L, journal, chart, option chain, watchlist. (Principle 1, Chapter 2 §2.1.)

**Billing provider:** undecided. Razorpay is the natural default for the Indian market and has not been ratified. Integration happens **only** through the `SubscriptionLifecycle` interface; nothing else mutates `Subscription` / `PlanGrant` / `EntitlementOverride`. Tracked as open decision OD-3 (Chapter 26 §26.9).

---

## 3.6 Success metrics

### 3.6.1 North Star

> **Weekly Reflective Sessions** — the count of weekly-active users who, in that week, (a) opened a Sentinel observation's "Why" panel, or (b) wrote a journal entry, or (c) completed a Learning Hub lesson tied to an observation they received.

This is deliberately not "sessions", "trades placed", or "time in app". Each of those rewards behaviour the product exists to reduce. The North Star rewards the user *engaging with their own behaviour*, which is the mechanism the whole thesis rests on.

### 3.6.2 Metric tree

```
                    WEEKLY REFLECTIVE SESSIONS
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   ACTIVATION            ENGAGEMENT             LEARNING
        │                     │                     │
  ┌─────┴─────┐        ┌──────┴──────┐       ┌──────┴──────┐
  │ onboarding│        │ observations│       │ lessons     │
  │ completion│        │ surfaced    │       │ completed   │
  │           │        │             │       │             │
  │ first     │        │ "Why" panel │       │ concept     │
  │ paper     │        │ open rate   │       │ mastery     │
  │ order     │        │             │       │             │
  │           │        │ journal     │       │ curriculum  │
  │ workspace │        │ entries     │       │ progression │
  │ customised│        │ /week       │       │             │
  └───────────┘        └─────────────┘       └─────────────┘
```

### 3.6.3 Counter-metrics (we watch these to make sure we are not winning wrongly)

| Counter-metric | Why it matters |
|---|---|
| Trades per user per week **rising** | We may be gamifying trading. The thesis predicts this should *fall*. |
| Observation dismiss rate > 60% | Sentinel is too noisy, or too directive, and users have tuned it out |
| "Why" panel open rate < 15% | Explainability is decorative rather than trusted |
| Median session length **rising** sharply | We may have built an attention product rather than a decision product |
| Support tickets containing "it told me to buy" | ⚖️ A compliance incident, not a UX issue. Escalates immediately. |

### 3.6.4 Engineering metrics

| Metric | Target | Status |
|---|---|---|
| API p95 latency (uncached read) | ≤200 ms | ⚪ not measured |
| Web LCP (dashboard, cold) | ≤2.0 s | ⚪ not measured |
| Interaction to visual acknowledgement | ≈20 ms | ⚪ not measured |
| Error rate (5xx / total) | ≤0.1% | ⚪ not measured |
| Uptime (`services/api`) | 99.5% | ⚪ not deployed |
| Test coverage (statements) | ≥70% | 🔴 ~0% |
| Time from merge to production | ≤15 min | ⚪ not deployed |

The number of ⚪ rows in this table is the honest state of the platform's measurement practice and is the reason Chapter 20 §20.9 and Chapter 21 §21.1 are written as remediation plans rather than descriptions.

---

## 3.7 Product scope

### 3.7.1 In scope — Year 1

| Area | Scope |
|---|---|
| **Identity** | Email/password auth, JWT + rotating refresh tokens, session management, preferences, audit trail |
| **Entitlements** | Plans, grants, subscriptions, per-user overrides, usage quotas, capability checks |
| **Market data** | NSE indices + equities; live quotes; historical candles; option chain; market depth (real-time only, never persisted) |
| **Charts** | Candlestick/line/area, standard timeframes, ~20 indicators, drawing tools, multi-layout, replay |
| **Paper trading** | Full OMS: 4 order types, modify, cancel, exit, partial fills, simulated margin, positions, portfolio, P&L |
| **Watchlists** | Multiple lists, reordering, inline sparklines, quick-trade |
| **Portfolio** | Holdings, positions, closed positions, allocation, daily/realised/unrealised P&L |
| **Journal** | Mood-tagged entries, AI annotation flag, tags |
| **Sentinel** | 4 agents + orchestrator, composite trap detection, Brain (memory + entity graph + concept graph), explainability, compliance audit trail |
| **TradeW AI** | Ambient docked copilot + Research workspace; 8-agent roster |
| **Learning Hub** | Curriculum, lessons, progress, contextual training tied to observations |
| **Workspace** | Dockable panels, command palette, keyboard shortcuts, themes, layout persistence |
| **Notifications** | In-app centre; email for account events |
| **Knowledge** | In-app vault viewer (dev-gated), concept graph visualisation |

### 3.7.2 Out of scope — Year 1, with reasons

| Excluded | Reason |
|---|---|
| **Real-money order routing** | Requires broker integration hardening, SEBI posture review, and `services/trading-engine` migration. Year 2. |
| **Automated / algorithmic execution** | Violates ARCH-2 in the general case. Any future form must be user-authored, user-triggered, and never AI-initiated. |
| **Portfolio recommendations / robo-advisory** | Regulated activity. Not our licence, not our product. |
| **Social feed, copy trading, leaderboards** | Directly adversarial to the behavioural thesis. Copy trading is advice with extra steps. |
| **Crypto** | Different regulator, different data, different risk profile. `TradingBot` (a separate project) is explicitly out of scope. |
| **Mutual funds, IPOs, bonds** | Not our user's job-to-be-done. |
| **Multi-broker** | One broker (Dhan) until the abstraction has earned a second implementation. Year 3. |
| **Native mobile apps** | `apps/mobile` is a roadmap folder. Responsive web first. Year 3. |
| **Public developer API** | `packages/sdk` exists as a folder; the OpenAPI-generated client is Phase 3. |
| **International markets** | India-only. `User.country` defaults to `"IN"` and every time utility is IST. |
| **Tax reporting / P&L statements for filing** | Paper trading has no tax consequence. Revisit with real money. |

### 3.7.3 The scope-creep test

Before adding anything, answer all four:

1. Which persona (3.4) does this serve, by name?
2. Which problem (P1–P5) does it address?
3. Does it violate ARCH-1..4?
4. Does it require a *new* platform system, or can it extend an existing one?

A feature that fails (3) is rejected. A feature that answers "new system" to (4) needs an RFC and an architecture review before any code.

---

## 3.8 Functional requirements

Requirements are identified `FR-<area>-<n>` and referenced from Chapter 21's test plan.

### FR-AUTH — Identity & session 🟢

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-AUTH-1 | Sign up with email + password; password hashed with bcrypt (cost ≥12) | P0 | 🟢 |
| FR-AUTH-2 | Log in returning a short-lived access JWT and a rotating refresh token | P0 | 🟢 |
| FR-AUTH-3 | Refresh tokens stored **hashed** (`RefreshToken.tokenHash`, unique), with `expiresAt` and `revokedAt` | P0 | 🟢 |
| FR-AUTH-4 | Logout revokes the presented refresh token | P0 | 🟢 |
| FR-AUTH-5 | `GET /auth/me` returns the current profile; `PATCH /auth/me` updates it | P0 | 🟢 |
| FR-AUTH-6 | Arbitrary typed user preferences via `GET /auth/preferences`, `POST /auth/preferences/:key` | P1 | 🟢 |
| FR-AUTH-7 | Every auth-significant event written to `AuditEvent` with IP and user agent | P0 | 🟢 |
| FR-AUTH-8 | Onboarding captures `experienceLevel` and `optionsFamiliarity` and adapts the first-run experience | P1 | 🔵 |
| FR-AUTH-9 | Password reset by emailed single-use token | P1 | 🔵 |
| FR-AUTH-10 | Optional TOTP two-factor | P2 | ⚪ |

### FR-ENT — Entitlements 🟢

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-ENT-1 | `Plan` → `PlanGrant` (capability + optional quota metric/limit/period) | P0 | 🟢 |
| FR-ENT-2 | `Subscription` with lifecycle `ACTIVE / TRIALING / PAST_DUE / GRACE / CANCELED / EXPIRED` | P0 | 🟢 |
| FR-ENT-3 | Per-user `EntitlementOverride` with a mandatory `reason` and `grantedBy` | P0 | 🟢 |
| FR-ENT-4 | `GET /entitlements/me` returns effective capabilities | P0 | 🟢 |
| FR-ENT-5 | `GET /entitlements/me/check/:capability` for a single check | P0 | 🟢 |
| FR-ENT-6 | `CapabilityGuard` enforces at the controller boundary | P0 | 🟢 |
| FR-ENT-7 | `UsageCounter` meters quota'd metrics per period key | P0 | 🟢 |
| FR-ENT-8 | Admin endpoints to grant/cancel subscriptions and set overrides | P1 | 🟢 |
| FR-ENT-9 | Billing provider integration **only** via `SubscriptionLifecycle` | P1 | 🔵 |
| FR-ENT-10 | Entitlement gates reasoning, **never** visibility — locked state with upgrade CTA | P0 | 🟢 |

### FR-MD — Market data 🟡

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-MD-1 | Instrument catalogue keyed by canonical `symbol` (globally unique) | P0 | 🟢 |
| FR-MD-2 | Dhan scrip-master sync populating `securityId`, `exchangeSegment`, `isin`, `lotSize`, `tickSize` | P0 | 🟢 |
| FR-MD-3 | Delisted instruments soft-deleted (`active=false`), never removed | P0 | 🟢 |
| FR-MD-4 | Latest-snapshot quotes: one `Quote` row per instrument, updated in place | P0 | 🟢 |
| FR-MD-5 | `source` field distinguishing `simulated` from live | P0 | 🟢 |
| FR-MD-6 | Live Dhan WebSocket feed with binary packet parsing | P0 | 🟡 |
| FR-MD-7 | Deterministic OU simulator for local dev and market-closed hours | P0 | 🟢 |
| FR-MD-8 | Token-bucket rate limiting respecting Dhan's 1 req/sec quote cap | P0 | 🟢 |
| FR-MD-9 | Historical candles persisted (`Candle` model, Migration 2) | P0 | 🔵 |
| FR-MD-10 | Option chain metrics (`OptionMetrics`, Migration 3) — separate from `Quote` | P0 | 🔵 |
| FR-MD-11 | Level-2 depth real-time only; **never persisted** | P0 | 🔵 |
| FR-MD-12 | Corporate actions (`CorporateAction`) with historical price adjustment | P1 | 🔵 |
| FR-MD-13 | Feed reconnection with exponential backoff and gap detection | P0 | 🟡 |

### FR-SIM — Paper trading 🟢

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-SIM-1 | Place MARKET / LIMIT / SL / SL_M orders | P0 | 🟢 |
| FR-SIM-2 | Validity DAY (expires at IST session close) and IOC (resolved immediately) | P0 | 🟢 |
| FR-SIM-3 | Product types MIS / CNC / NRML with distinct simulated margin | P0 | 🟢 |
| FR-SIM-4 | Reject on: bad lot size, insufficient margin, unresolvable instrument — with `rejectReason` | P0 | 🟢 |
| FR-SIM-5 | Modify quantity / price / trigger on a resting order | P0 | 🟢 |
| FR-SIM-6 | Cancel a resting order, releasing blocked margin | P0 | 🟢 |
| FR-SIM-7 | Resting-order matching against live prices | P0 | 🟢 |
| FR-SIM-8 | Partial fills; `filledQuantity`; quantity-weighted `avgFillPrice` | P0 | 🟢 |
| FR-SIM-9 | Position maths: add / partial close / full close / **close-and-flip** | P0 | 🟢 |
| FR-SIM-10 | Realised, unrealised, and daily P&L with an IST session-open anchor | P0 | 🟢 |
| FR-SIM-11 | `PaperWallet` created lazily on first order, ₹10,00,000 starting capital | P0 | 🟢 |
| FR-SIM-12 | Charges at 3 bps of gross trade value | P0 | 🟢 |
| FR-SIM-13 | Exit one position; exit all positions | P0 | 🟢 |
| FR-SIM-14 | Closed positions retained as history (quantity 0 rows never deleted) | P0 | 🟢 |
| FR-SIM-15 | Portfolio summary: net worth, available balance, margin used, position value | P0 | 🟢 |
| FR-SIM-16 | Option-contract orders from the Option Chain | P0 | 🔵 |
| FR-SIM-17 | Bracket / cover orders (`parentOrderId` exists, unpopulated) | P2 | 🔵 |
| FR-SIM-18 | Simulated slippage model (`Order.slippage` exists, unpopulated) | P1 | 🔵 |

### FR-SEN — Sentinel 🟡

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-SEN-1 | Four agents: Market & Technical, Emotion, Trap & Safety, Compliance & Audit | P0 | 🟢 |
| FR-SEN-2 | Orchestrator is the **only** producer of user-facing copy | P0 | 🟢 |
| FR-SEN-3 | Composite gate: ≥2 triggered signals AND ≥0.7 combined weight | P0 | 🟢 |
| FR-SEN-4 | Output structure: evidence → pattern name → soft suggestion, always | P0 | 🟢 |
| FR-SEN-5 | Deterministic composition when no LLM provider is configured | P0 | 🟢 |
| FR-SEN-6 | Every observation persisted with evidence + SEBI category | P0 | 🟢 |
| FR-SEN-7 | Never blocks, delays, or gates an order (ARCH-3) | P0 | 🟢 |
| FR-SEN-8 | Trade history received as request data; Sentinel never queries trading tables | P0 | 🟢 |
| FR-SEN-9 | Service-token-guarded ingress; unreachable from the browser | P0 | 🟢 |
| FR-SEN-10 | Concept knowledge graph: 15 domains, 13-relation closed vocabulary, polarity + transitivity | P0 | 🟢 |
| FR-SEN-11 | Runtime learning separated from canonical knowledge at the column level | P0 | 🟢 |
| FR-SEN-12 | `ConceptPromotion` human review queue; Sentinel never edits canonical YAML | P0 | 🟢 |
| FR-SEN-13 | Day Classification hero card | P0 | 🟡 |
| FR-SEN-14 | Market Context panel; unavailable dimensions reported honestly, never fabricated | P0 | 🟡 |
| FR-SEN-15 | Live Safety Feed with per-card "Why" panels | P0 | 🟡 |
| FR-SEN-16 | Contextual Training tied to the session's dominant observation | P1 | 🔵 |
| FR-SEN-17 | Session timeline | P1 | 🟡 |
| FR-SEN-18 | Full 14-signal trap catalogue (Chapter 8) | P0 | 🟡 |

### FR-AI — TradeW AI 🟡

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-AI-1 | Provider-agnostic LLM/embedding/research contracts; no provider name in a type | P0 | 🟢 |
| FR-AI-2 | Logical model tiers `fast / balanced / deep`, mapped by configuration | P0 | 🟢 |
| FR-AI-3 | Neural Brain pipeline: search memory → hit? use : research → learn → store → connect → answer | P0 | 🟢 |
| FR-AI-4 | `BrainAskResponse.path` records how the answer was produced, for audit | P0 | 🟢 |
| FR-AI-5 | Memory with pgvector embeddings; `embeddingModel`/`embeddingDim` recorded so mixed-provider vectors are never compared | P0 | 🟢 |
| FR-AI-6 | Token-budgeted context assembly | P0 | 🟢 |
| FR-AI-7 | `CORE_GUARDRAILS` injected into every system prompt | P0 | 🟢 |
| FR-AI-8 | Tool registry with **no** order-placement tool | P0 | 🟢 |
| FR-AI-9 | 13-category news event classification | P1 | 🟢 |
| FR-AI-10 | Ambient docked copilot on every page | P0 | 🟡 |
| FR-AI-11 | Research workspace with 8-agent roster | P0 | 🔵 |
| FR-AI-12 | Streaming token-by-token responses | P0 | 🔵 |
| FR-AI-13 | Voice + navigation assistant | P2 | 🔵 |

### FR-WS — Workspace 🟢

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-WS-1 | Persistent icon-rail sidebar + top bar on every authenticated surface | P0 | 🟢 |
| FR-WS-2 | Five-zone dock (not free-floating windows) with draggable splitters | P0 | 🟢 |
| FR-WS-3 | Command palette (⌘K) as unified global search with pluggable providers | P0 | 🟢 |
| FR-WS-4 | Keyboard shortcuts with a discoverable help overlay | P0 | 🟢 |
| FR-WS-5 | Layout persistence to localStorage, hydration-safe | P0 | 🟢 |
| FR-WS-6 | Theme engine, dark-first, no flash on load | P0 | 🟢 |
| FR-WS-7 | Closed-panel restoration menu | P1 | 🟢 |
| FR-WS-8 | Server-side workspace continuity across devices | P1 | 🔵 |

### FR-LRN — Learning Hub 🔵

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-LRN-1 | Curriculum: tracks → modules → lessons | P0 | 🔵 |
| FR-LRN-2 | Per-user progress and completion | P0 | 🔵 |
| FR-LRN-3 | Contextual training surfaced from a Sentinel observation | P0 | 🔵 |
| FR-LRN-4 | Lifetime entitlement (₹299) | P0 | 🔵 |
| FR-LRN-5 | Content generated from validated Knowledge Graph nodes (v2) | P2 | ⚪ |

---

## 3.9 Non-functional requirements

| ID | Category | Requirement | Target |
|---|---|---|---|
| NFR-P1 | Performance | Interaction → visual acknowledgement | ≈20 ms |
| NFR-P2 | Performance | Micro-interaction completion | ≤150 ms |
| NFR-P3 | Performance | Panel open | 200–300 ms |
| NFR-P4 | Performance | Route change | ≤350 ms |
| NFR-P5 | Performance | API read p95 (uncached) | ≤200 ms |
| NFR-P6 | Performance | Quote tick → cell update | ≤16 ms (one frame) |
| NFR-P7 | Performance | Sentinel `/observe` p95 (no LLM) | ≤300 ms |
| NFR-P8 | Performance | AI first token | ≤800 ms |
| NFR-A1 | Availability | `services/api` uptime | 99.5% |
| NFR-A2 | Availability | Market-data feed uptime during session | 99.9% |
| NFR-A3 | Availability | Sentinel down ⇒ platform fully functional | mandatory |
| NFR-S1 | Security | All traffic TLS 1.3 | mandatory |
| NFR-S2 | Security | Passwords bcrypt cost ≥12 | mandatory |
| NFR-S3 | Security | Access token TTL | ≤15 min |
| NFR-S4 | Security | Refresh token TTL | ≤30 days, rotating |
| NFR-S5 | Security | No secret in git | mandatory |
| NFR-S6 | Security | All input validated at the controller boundary (`class-validator`) | mandatory |
| NFR-C1 | Compliance ⚖️ | Every AI output carries a disclaimer | mandatory |
| NFR-C2 | Compliance ⚖️ | Every Sentinel observation logged with evidence + category | mandatory |
| NFR-C3 | Compliance ⚖️ | No Buy/Sell/Entry/Target language anywhere | mandatory |
| NFR-C4 | Compliance ⚖️ | Audit records immutable | mandatory |
| NFR-C5 | Compliance ⚖️ | Personal data resident in India | mandatory |
| NFR-M1 | Maintainability | Test coverage (statements) | ≥70% |
| NFR-M2 | Maintainability | No file exceeds 500 lines without a documented reason | guideline |
| NFR-M3 | Maintainability | Every service ships its own `.env.example` | mandatory |
| NFR-M4 | Maintainability | Config validated at boot, fail-fast | mandatory |
| NFR-U1 | Usability | WCAG 2.1 AA | target |
| NFR-U2 | Usability | Every action keyboard-reachable | target |
| NFR-U3 | Usability | Usable at 1366×768 | mandatory |
| NFR-U4 | Usability | Green/red reserved strictly for market direction and sentiment | mandatory |
| NFR-SC1 | Scalability | 20k concurrent sessions without architecture change | Year 3 |
| NFR-SC2 | Scalability | One deployment per service, independently scalable | mandatory |
| NFR-SC3 | Scalability | Background work never blocks the request path | mandatory |

---

## 3.10 User stories & acceptance criteria

Format: Given / When / Then. These are the source for Chapter 21's E2E suite.

### Epic A — Practise without risk

**US-A1 — Place a paper order**
> As Priya, I want to place a paper order using real market prices, so that practice teaches me something true.

```gherkin
Given I am authenticated and the market is open
  And NIFTY is trading at ₹24,812.35 on my chart
When I place a MARKET BUY for 1 lot of NIFTY
Then the order is created with status PENDING
  And it fills within one matching tick
  And the fill price is within one tick of the price shown on my chart
  And a Trade row is created with charges = 3 bps of gross value
  And my PaperWallet cash decreases by (margin + charges)
  And a Position row exists with quantity = lotSize and avgPrice = fillPrice
  And my portfolio net worth reflects the new position
```

**US-A2 — Insufficient margin**
```gherkin
Given my available balance is ₹5,000
When I place a MARKET BUY requiring ₹50,000 of simulated margin
Then the order is REJECTED
  And rejectReason explains insufficient margin in plain language
  And no Trade, Position, or wallet mutation occurs
  And the rejection is visible in the order book within 200 ms
```

**US-A3 — Stop-loss trigger**
```gherkin
Given I am long 1 lot at ₹24,800
  And I have placed an SL_M SELL with triggerPrice ₹24,750
Then the order rests with status TRIGGER_PENDING
When the live price crosses ₹24,750
Then the order fills at market on the next matching tick
  And my position quantity returns to 0
  And realizedPnl on the closing Trade is negative and correct
  And the Position row is retained (not deleted) as history
```

**US-A4 — Close and flip**
```gherkin
Given I am long 100 units at avgPrice ₹500
When I SELL 150 units at ₹520
Then realized P&L on the closed 100 is +₹2,000
  And my position is short 50 at avgPrice ₹520
  And the closing and opening halves are accounted separately
```

**US-A5 — Day order expiry**
```gherkin
Given I have an unfilled LIMIT order with DAY validity
When the IST session closes
Then the order transitions to EXPIRED on the next matching tick
  And blocked margin is released to my available balance
```

### Epic B — Notice my own behaviour

**US-B1 — Revenge trading observation**
```gherkin
Given I have closed two losing trades today
  And I opened a new position within 15 minutes of each losing exit
When Sentinel observes my session
Then a revenge_trading signal is triggered with weight 0.35
  And its evidence cites the exact count and window
  And it is persisted to SentinelObservation with category
      'behavioral_pattern_observation'
```

**US-B2 — Composite gate suppresses noise** ⭐ *the most important test in the suite*
```gherkin
Given exactly one signal is triggered with weight 0.35
When the orchestrator evaluates
Then NO synthesis is produced
  And no user-facing card is shown
  And the signal is still persisted for the audit trail
```
> If this test ever fails, the product has become a noisy alert system and the thesis is broken.

**US-B3 — Composite gate surfaces corroboration**
```gherkin
Given low_volume_breakout (0.40) and revenge_trading (0.35) are both triggered
When the orchestrator evaluates
Then combined weight 0.75 ≥ 0.70 and count 2 ≥ 2
  And a synthesis is produced naming the dominant pattern
  And it follows evidence → pattern → soft suggestion
  And it contains NO imperative Buy/Sell/Don't language
  And confidence = min(0.95, 0.75/2 + 0.3) = 0.675
  And an orchestrator observation is persisted with surfaced=true
```

**US-B4 — Sentinel is never a gate** ⭐ **ARCH-3 regression test**
```gherkin
Given services/sentinel is completely unreachable
When I place a MARKET order
Then the order is placed with unchanged latency
  And no error is surfaced to me
  And the Sentinel panel shows a degraded state, not an error modal
```

**US-B5 — Explainability**
```gherkin
Given a Live Safety Feed card is displayed
When I expand its "Why" panel
Then I see the evidence lines that produced it
  And a confidence value
  And a neutral signal-source label ("Behavioral signal")
  And NEVER an internal agent name ("emotion-intelligence")
```

### Epic C — Understand the market

**US-C1 — Honest unavailability** ⭐ *Rakesh's trust test*
```gherkin
Given the Market Context panel includes an "institutional participation" dimension
  And no real backing signal exists for it
Then it is displayed as "not yet available"
  And it is NEVER displayed with a fabricated value or a plausible guess
```

**US-C2 — Brain answers from memory**
```gherkin
Given a relevant MemoryRecord exists for my question
When I ask TradeW AI
Then the answer is produced with path = 'memory'
  And no research run is triggered
  And no research quota is consumed
```

**US-C3 — Provider-free operation**
```gherkin
Given no LLM provider is configured
When Sentinel produces a synthesis
Then the deterministic template composes it
  And the structure is unchanged
  And no error is surfaced
```

### Epic D — One workspace

**US-D1 — Resume, don't restart**
```gherkin
Given I have arranged four panels and set a symbol
When I reload the page
Then my layout, panel set, and active symbol are restored
  And there is no theme flash
  And there is no hydration mismatch warning
```

**US-D2 — Entitlement gates reasoning, not visibility**
```gherkin
Given I have no 'sentinel' capability
Then Sentinel is still visible in my sidebar
When I open it
Then I see the workspace with a locked state and an upgrade CTA
  And NOT a 404, a hidden item, or a silent absence
```

---

## 3.11 Release plan

### 3.11.1 MVP definition

**MVP is reached when a real user can complete this loop unaided:**

```
   sign up → onboarding → paper order at a real price →
   receive a corroborated Sentinel observation →
   open its "Why" panel → write a journal entry →
   complete the linked lesson → return the next day to a restored workspace
```

Every step in that loop must work. Nothing outside it is MVP.

**MVP requirement set:** all P0 rows in FR-AUTH, FR-ENT, FR-SIM, FR-WS; FR-MD-1..8 and 13; FR-SEN-1..12; FR-AI-1..8; FR-LRN-1..4.

**Explicitly not MVP:** option-contract orders (FR-SIM-16), Research workspace (FR-AI-11), streaming (FR-AI-12), server-side continuity (FR-WS-8), corporate actions (FR-MD-12), admin console, mobile.

### 3.11.2 Release train

| Release | Genesis phases | Contents | Gate to ship |
|---|---|---|---|
| **v0.4** — Foundations | 1, 2 | Workspace shell, auth, entitlements, paper OMS, market data ingestion | Local `docker compose` green; manual smoke of the MVP loop |
| **v0.5** — Intelligence | 8 (partial) | Sentinel 4 agents + orchestrator + Brain; composite gate; compliance trail | US-B2 and US-B4 pass; zero directive-language findings in a manual review of 100 generated observations |
| **v0.6** — Knowledge | 5, 6 | Research Vault read surface, Validation Engine, concept graph UI | Validation gate demonstrably rejects single-signal promotions |
| **v0.7** — Education | 4 | Learning Hub v1, contextual training | Curriculum navigable end-to-end; progress persists |
| **v0.8** — Deployment | — | OCI provisioning, CI/CD, Caddy/TLS, backups, monitoring | Blue-green deploy demonstrated; restore-from-backup rehearsed |
| **v0.9** — Hardening | — | Test suite to ≥70%, ESLint, performance budgets in CI, load test | All NFR-P targets **measured**, not asserted |
| **v1.0** — GA | 3, 9, 10, 11 | Assistant, TradingView workspace, server-side continuity, n8n ops | Security review passed; compliance posture review passed |

### 3.11.3 Release gates (all must be green)

```
   ┌─ CODE ────────────────────────────────────────────┐
   │ ✓ tests pass          ✓ coverage ≥ threshold      │
   │ ✓ typecheck clean     ✓ lint clean                │
   └───────────────────────────────────────────────────┘
   ┌─ ARCHITECTURE ────────────────────────────────────┐
   │ ✓ ARCH-1..4 unviolated                            │
   │ ✓ no new arrow in the dependency graph            │
   │ ✓ no duplicated platform system                   │
   └───────────────────────────────────────────────────┘
   ┌─ COMPLIANCE ⚖️ ───────────────────────────────────┐
   │ ✓ no directive language in any new copy or prompt │
   │ ✓ disclaimers present on every AI surface         │
   │ ✓ new observations carry evidence + category      │
   └───────────────────────────────────────────────────┘
   ┌─ OPERATIONS ──────────────────────────────────────┐
   │ ✓ migrations reversible or forward-only by design │
   │ ✓ rollback rehearsed   ✓ runbook updated          │
   │ ✓ dashboards/alerts exist for what changed        │
   └───────────────────────────────────────────────────┘
```

---

## 3.12 Future roadmap (product view)

Engineering view in Chapter 27.

| Horizon | Theme | Headline capabilities |
|---|---|---|
| **Y1 H2** | Complete Genesis | All 11 phases; first paying Sentinel cohort; measured NFRs |
| **Y2 H1** | Real money, carefully | `trading-engine` migration; live Dhan routing under user credentials; SEBI audit surface |
| **Y2 H2** | Depth | Options strategy builder with payoff visualiser; scanner/screener; advanced portfolio analytics |
| **Y3 H1** | Autonomy in research | Overnight research agents filing evidence into the Research Vault; multi-broker abstraction |
| **Y3 H2** | Mobile | React Native consuming `packages/sdk` + `packages/types` |
| **Y4** | Platform | Public developer API; ClickHouse analytics; Kafka *if and only if* a real durability need appears |
| **Y5** | Enterprise | Organisation entitlements (`Subscription.organizationId` already modelled); white-label; compliance-desk product |

**Permanently out of scope, at every horizon:** automated execution of AI-generated signals; discretionary investment advice; custody of client funds.

---

*Next: [Chapter 4 — Platform Overview](04-platform-overview.md)*
