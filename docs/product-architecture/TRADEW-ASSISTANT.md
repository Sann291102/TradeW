# TradeW Assistant (Floating) — Product Blueprint

Status: design, pre-implementation. Governed by [`TRADEW-OS.md`](TRADEW-OS.md) §5 (module boundaries). This is **not a new AI system** — it's an extension of TradeW AI's existing ambient copilot (`TRADEW-AI.md` §2.1) with the capabilities the Genesis v2 brief asks for: voice input, app-navigation commands, full application control, and — when entitlement allows — automatic invocation of Sentinel's premium reasoning. Same agent roster, same runtime (`services/tradew-ai`), same guardrails.

**The workspace agent, in one line:** TradeW AI can open and operate *every feature available to the current user* through text or voice — it is the OS-level command surface, not just a Q&A box (`TRADEW-OS.md` §1, §5).

## 1. What's new vs. what already exists

| Already in `TRADEW-AI.md` | New here |
|---|---|
| Docked chat panel + floating trigger, overlay on Home/Trading/Options/Portfolio | Floating trigger becomes **permanent on every page**, not just those four |
| Text input, routed to AI Researcher agent | **Voice input** (speech-to-text before the same routing) |
| Context-aware answers to analytical questions ("Explain this chart") | **Navigation/action commands** ("Open NIFTY", "Show Portfolio", "Open Option Chain") — a new intent class, not analysis |

## 2. Two intent classes

The AI Researcher agent (router, `TRADEW-AI.md` §3) already routes free-text questions to specialist agents. This adds one more routing branch upstream of that:

1. **Navigation intent** — "Open X", "Show Y", "Find Z", "Search <symbol>". Resolved to a route/action *without invoking an LLM analysis agent at all* — a lightweight intent classifier (regex/embedding match against a fixed command grammar) maps the phrase to an `apps/web` route or in-app action (open watchlist, open a symbol's option chain, jump to Learning Hub). This keeps navigation snappy and cheap — it shouldn't cost a full agent round-trip.
2. **Analysis intent** — everything else, routed exactly as today to AI Researcher → specialist agent.

```
Voice/Text Input
      │
      ▼
Speech-to-Text (voice only)
      │
      ▼
Intent Classifier (new, lightweight, in services/tradew-ai)
      │
      ├─ Navigation ──► apps/web route/action (no LLM call)
      └─ Analysis ────► AI Researcher → specialist agent (existing flow)
```

## 3. Command grammar (initial set, from the brief's examples)

`Open NIFTY` · `Open Option Chain` · `Show Portfolio` · `Open Learning` · `Open TradingView` · `Find Losing Trades` (→ Portfolio, filtered) · `Show Orders` · `Open Watchlist` · `Search <symbol>`.

This list grows as workspaces ship (e.g. Learning Hub commands only make sense once `LEARNING-HUB.md` is built) — it's not meant to be exhaustive on day one.

## 4. Context-awareness (unchanged from TRADEW-AI.md)

The assistant still reads the active route + entity in focus for analysis intents, exactly as specified in `TRADEW-AI.md` §3's per-page agent table (chart open → Technical Analysis; option chain open → Option Chain Analysis; portfolio open → Portfolio Insights). Navigation intents don't need this context — they're stateless commands.

## 5. Full application control

Per the direction update (§5), the assistant is capable of opening and navigating **every feature available to the current user** — not a fixed list. The command grammar (§3) is the seed; the general capability is:

- Any route/surface the user is entitled to reach, the assistant can open ("Open Learning", "Open TradingView", "Go to Portfolio").
- Any in-app view-level action the user could take by clicking, the assistant can trigger ("Find losing trades" → Portfolio filtered; "Open Watchlist" → sidebar watchlist).
- **Entitlement-scoped:** the assistant can only open what *this* user can access. A feature behind a subscription the user doesn't have resolves to the same Start Free Trial / Upgrade Plan surface a manual click would (`SUBSCRIPTIONS.md` §4), never a dead command.
- **Still never an order action** (§6) — "control every feature" means navigation and view-level actions, not placing/modifying/cancelling orders, which always stay on the manual order-entry path (`TRADEW-OS.md` §2.3).

## 6. Auto-invoking Sentinel (premium reasoning)

**Scope (2026-07-21):** this flow applies platform-wide. The docked assistant is part of the shared shell, so it is available in every workspace — including Sentinel's, where a user is already looking at Sentinel's own output and the escalation is correspondingly less likely to add anything. A scope note briefly claimed the assistant was absent from Sentinel entirely, on the assumption Sentinel was becoming a standalone application; that direction was reversed the same day (`SENTINEL.md` §5, `TRADEW-OS.md` §1).

When an analysis intent needs premium institutional reasoning — "Analyze this chart" with full market/behavior/historical context, "Why is my P&L negative?" — and the user's entitlement allows it, TradeW AI **automatically escalates to Sentinel** without the user having to switch to the Sentinel application.

**This is orchestrated at the ingress, not a direct service call** (`TRADEW-OS.md` §2.4, and the architectural reconciliation this section exists to make explicit):

```
User: "Analyze this chart"  (in the docked TradeW AI panel)
        │
        ▼
services/api  ── entitlement check ──►  has Sentinel? 
        │                                   │
        │                          ┌────────┴────────┐
        │                         yes               no
        │                          │                 │
        ├─► services/tradew-ai (Chart/Technical Agent — always)
        │                          │                 │
        └─► services/sentinel (Risk/Behavior/        └─► Start Free Trial /
            Orchestrator — only if entitled)              Upgrade Plan CTA
                                   │
                                   ▼
        services/api merges into ONE explainable answer (EXPLAINABILITY.md)
        rendered in the same TradeW AI panel
```

- `services/tradew-ai` never calls `services/sentinel` directly — the no-direct-arrow rule (`ARCHITECTURE.md` §9) is preserved. `services/api` is the orchestrator that invokes both and composes, exactly as `TRADEW-OS.md` §2.4 defines "TradeW AI invokes Sentinel."
- Without entitlement, the premium half is replaced by the upgrade CTA — the user still gets TradeW AI's own (non-premium) answer, plus a visible path to the premium reasoning, never a silent absence (`SUBSCRIPTIONS.md` §4).
- The merged premium answer carries the full explainability block (`EXPLAINABILITY.md` §2) — reasoning, evidence, historical examples, confidence, sources.

## 7. Guardrails (unchanged, restated for emphasis)

- Navigation and app-control commands never place, modify, or cancel an order — "Show Orders" opens the Orders view; it does not act on any order. Anything order-related still requires the normal manual order-entry flow (`ARCHITECTURE.md` §3, `TRADEW-OS.md` §2.3).
- Voice transcription is discarded after intent resolution — not stored as a standing recording, consistent with not collecting more personal data than the feature needs.
- All existing TradeW AI disclaimers and confidence-citation rules (`TRADEW-AI.md` §4) apply unchanged to analysis-intent responses; navigation/command responses carry no disclaimer (they're not an analytical claim).

## 8. Why no new service

Voice-to-text and intent classification are request-scoped, stateless operations — they belong inside `services/tradew-ai`'s existing request path, not a new `services/voice` or `services/nav` service. Splitting them out would add a network hop for no architectural benefit, same reasoning `ARCHITECTURE.md` §2.1 applies to `services/auth`. The Sentinel escalation (§6) likewise adds no new service — it reuses the existing `services/api` → `services/sentinel` path that already exists in the dependency graph.
