# TradeW Assistant (Floating) — Product Blueprint

Status: design, pre-implementation. Governed by [`TRADEW-OS.md`](TRADEW-OS.md) §5 (module boundaries). This is **not a new AI system** — it's an extension of TradeW AI's existing ambient copilot (`TRADEW-AI.md` §2.1) with the capabilities the Genesis v2 brief asks for: voice input, app-navigation commands, full application control, and — when entitlement allows — automatic invocation of Sentinel's premium reasoning. Same agent roster, same runtime (`services/tradew-ai`), same guardrails.

**Expanded 2026-08-10.** The direction update of that date turns the assistant from a capable dock into the product's operating layer, and splits three concerns into their own docs: [`AI-PERSONA.md`](AI-PERSONA.md) (the user names the AI before signup; that name is the identity everywhere), [`AI-VOICE.md`](AI-VOICE.md) (wake word and full duplex voice, replacing the single phrase "voice input" in this doc), and [`AI-CONVERSATION-LIFECYCLE.md`](AI-CONVERSATION-LIFECYCLE.md) (the thread persists all day and rolls at 02:30 IST). What that update adds *here* is §9–§11: the request pipeline every interaction runs through, the assistant's ability to compose the workspace as part of an answer, and the server-side compliance gate.

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

> **Superseded in part — direction call 2026-07-26.** Sentinel is *the* premium
> product, and the assistant must not relay, summarise or explain what Sentinel
> is doing. The escalate-and-merge flow described in this section is therefore
> **not the current intent**: the assistant navigates *to* Sentinel (a route
> like any other) and stops there. Paraphrasing Sentinel's reasoning through the
> free assistant would give away the thing users pay for. Implemented as a hard
> boundary in `apps/web/src/lib/assistant/domain-guard.ts` (refuses only when
> "sentinel" co-occurs with an explain-verb, so "open Sentinel" still works) —
> see [[../../knowledge/Patterns/2026-07-26 - TradeW AI assistant control layer (Comet-style app control)]].
> The architectural point this section makes — that any such orchestration
> belongs at `services/api`, never as a direct `tradew-ai → sentinel` call
> (ARCHITECTURE.md §9) — still stands, and applies if the direction reverses.

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

## 9. The request pipeline (added 2026-08-10)

Every user request — typed or spoken, navigation or analysis — runs the same six stages. This is what "the assistant is the product's operating system" means concretely: one path in, one path out, no feature-specific side doors.

```
Input (voice → transcript, or text)
   │
   1. UNDERSTAND    what is the user trying to do?          intent + entities
   │
   2. ROUTE         which specialists are needed?           AI Researcher (router)
   │
   3. GATHER        pull the data those specialists need    market-data, analytics, portfolio
   │
   4. REASON        analyse across it                       specialist agents
   │
   5. COMPLY        check before the user ever sees it      §11 — server-side, fail-closed
   │
   6. RESPOND       speech + text + UI actions              §10
```

| Stage | Runs in | Status today |
|---|---|---|
| 1. Understand | `apps/web` for commands (deterministic); `services/tradew-ai` for analysis | **Built** for commands — `lib/assistant/router.ts`. Not built for analysis |
| 2. Route | `services/tradew-ai` (AI Researcher, `TRADEW-AI.md` §3) | Not built — `services/tradew-ai` is a stub; the agent logic lives in `packages/ai-core` |
| 3. Gather | `services/api` fans out to `market-data` / `analytics` / portfolio (read-only) | Data services exist; the fan-out for AI requests does not |
| 4. Reason | `services/tradew-ai` specialists; `services/sentinel` when entitled (§6) | Not built |
| 5. Comply | `services/api`, on the response path | **Partial and in the wrong place** — see §11 |
| 6. Respond | `apps/web` — speech (`AI-VOICE.md` §5), text, and actions | Actions built; speech not |

**Stage 1 short-circuits.** A resolved navigation command skips stages 2–4 entirely and goes straight to 6 — that is §2's rule, and it is why "open the option chain" is instant and free while "explain this chart" is neither. Stage 5 still runs on everything.

## 10. The living AI workspace (added 2026-08-10)

Beyond answering, the assistant **composes the workspace as part of its answer.** "Summarise today's market" produces a short spoken summary *and*, where it helps, a panel in the dashboard holding the detail behind it — one request, one conversation, several surfaces updated.

This is the existing `AssistantAction` capability set (`apps/web/src/lib/assistant/types.ts`) extended from "navigate and toggle panels" to "assemble a view," and it inherits every constraint that set was built with:

- **Composition is view-level only.** Opening, arranging, and populating panels — never placing, modifying, or cancelling an order (§7, `TRADEW-OS.md` §2.3). The capability type has no order variant and gains none here.
- **Entitlement-scoped** exactly as §5 requires; a panel the user isn't entitled to resolves to the upgrade surface, not a blank.
- **The user stays in control of their layout.** A composed panel is announced in the trace, is dismissible in one action, and never silently rearranges surfaces the user placed themselves. An assistant that reorganises your desk while answering a question is a liability, not a feature.
- **Speech summarises; the panel holds the detail** (`AI-VOICE.md` §5). The two are one response, not a spoken version and a written version of the same thing.

## 11. Compliance is a gate, not a prompt (added 2026-08-10)

`TRADEW-OS.md` §1 requires observation-never-advice as an *architectural* property. Today it is not one: `apps/web/src/lib/assistant/domain-guard.ts` is real and working, but it runs **in the browser, on the request path** — which means it is bypassable by anyone talking to the API directly, and it cannot see model output at all, because there is no model output yet.

The requirement, when stage 4 starts producing text:

- **Every response passes a server-side compliance gate at `services/api` before reaching the client** — regardless of which agent produced it, whether it came from `tradew-ai` or `sentinel`, and whether the request arrived by voice, text, or an internal call.
- **Fail closed.** A response the gate cannot evaluate is not shown. Availability is not the value being protected here.
- **The gate is not a prompt instruction.** System-prompt guidance is a first line and will be there; it is not the control, because prompts are probabilistic and a user-supplied persona name flows into the same prompt (`AI-PERSONA.md` §5).
- **Verdicts are logged** with the message (`AI-CONVERSATION-LIFECYCLE.md` §6, `complianceVerdict`), so the posture is auditable rather than asserted.
- `domain-guard.ts` stays where it is as fast client-side feedback — it becomes a UX affordance, not the enforcement point.
