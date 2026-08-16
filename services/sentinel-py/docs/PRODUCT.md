# Sentinel (Python) — Product Definition

**Service:** `services/sentinel-py` · **Status:** built and merged to `main`, not yet
validated against live market data
**Last verified against the code:** 2026-08-15

---

## 1. What this product is

Sentinel watches **the strategy the user declared** and tells them when the
conditions *they* wrote down have been met.

That sentence is the whole product, and every constraint below follows from
it. It is deliberately narrower than the older `services/sentinel`
(TypeScript, port 4010), which analyses the market on its own account and
publishes a market read. This service has no opinion about the market. It has
an opinion about nothing at all. It reads the user's rules and reports whether
they are currently true.

### The user's sentence

> "Watch the first 15-minute high and low. Tell me when price closes beyond
> one of them, comes back to it, and closes back through — and tell me
> whether volume backed it up."

Sentinel's job is to watch exactly that. Not a variation of it, not an
improved version of it, and not an additional setup it noticed while looking.

---

## 2. Non-negotiable principles

These are enforced in code and in tests, not merely stated here. Each names
where it lives.

| # | Principle | Where it is enforced |
|---|---|---|
| 1 | **The user's strategy, never ours.** Sentinel proposes no strategy, ranks none against another, and nominates none. The catalogue is a menu. | `app/strategy/templates.py`; a test asserts no catalogue entry carries `score`, `rank`, `recommended` or `primary` |
| 2 | **Alert, never auto-trade.** No order path exists in this service, and none may be added. | No broker client is imported anywhere in `app/` |
| 3 | **Never a buy/sell signal.** No Buy/Sell/Entry/Target/Stop language reaches any user surface. | `app/notify/compliance.py` — rejects banned wording *and* forbidden metadata keys |
| 4 | **Confirmation before notification.** Only closed candles are evaluated. A wick through a level is not a breakout. | `app/watch/evaluator.py::closed_candles` |
| 5 | **Real data only.** No candles means an error and a recorded skip, never an alert computed from invented data. | `app/market/feed.py::MarketDataUnavailableError` |
| 6 | **Never invent, never silently drop.** The parser extracts only what the user expressed, and reports the words it did not understand. | `app/strategy/parser.py` |
| 7 | **The user's own numbers.** Entry, invalidation and direction are declared by the user. Sentinel proposes none of them. | `app/watch/router.py` position endpoints |

### Why 3 is not a style preference

TradeW's product constitution (`docs/handbook/00-front-matter.md` ARCH-4,
`26-decision-records.md`, root `CLAUDE.md` Rule 2) forbids directive trading
language on every surface and names notifications explicitly. It is a **SEBI
compliance posture**: an unregistered platform telling a retail user to buy
something is investment advice.

The TypeScript Sentinel enforces this by *rewriting* vocabulary. This service
**rejects** instead: it composes its own short strings from a fixed set of
templates, so a banned term means a template is wrong and should fail loudly
in tests rather than be laundered into different words at runtime.

---

## 3. What a user can do today

```
Describe a strategy in plain English        ──┐
                                              ├── one UserStrategy
Adopt one of 10 built-in definitions        ──┘
                    ↓
        Review what Sentinel understood
                    ↓
        Configure it (generated form)
                    ↓
        Apply it to a market / option
                    ↓
        Sentinel watches, and explains its state
                    ↓
        Lifecycle events, then performance
```

All of it lives in the **"Your strategies"** section of `/sentinel`. There is
deliberately no second strategy page.

### What Sentinel tells the user

Two pre-entry tiers, and a set of in-trade observations. Nothing is phrased as
an instruction:

| Tier | Meaning |
|---|---|
| `wait_and_watch` | Some of your conditions are met; the setup is developing |
| `side_in_focus` | Every mandatory condition you defined is now met |

In-trade (only after the user declares they took a position, with their own
entry, invalidation level and direction): R-multiple milestones, *Invalidation
Reached*, *Projected Level Reached*, structure break.

Note the vocabulary: "Invalidation Reached", not "Stop Loss Hit". "Projected
Level Reached", not "Target Hit". Each is a one-string edit if the compliance
rule is ever relaxed — and they are the same event either way.

---

## 4. What Sentinel deliberately does not do

- **Predict.** It reports what is true now against the user's rules.
- **Score confidence.** No confidence model exists here and none was invented.
  The feed thresholds on `strength` — the real ratio of mandatory conditions
  met to conditions the user defined.
- **Rank strategies.** Performance describes *this user's* history with *their*
  strategy. It never compares one strategy with another.
- **Fill silence.** A quiet market produces no events. An unreadable market
  says so (`dataStatus`), rather than looking identical to a quiet one.
- **Manufacture analytics.** A breakdown with no observations behind it is not
  rendered empty — it is not rendered.

---

## 5. Compliance summary

| Requirement | Status | Evidence |
|---|---|---|
| No directive trading language on user surfaces | **Enforced** | `app/notify/compliance.py`, tests in `tests/test_notify.py` |
| No order placement path | **Enforced by absence** | no broker client in `app/` |
| Forbidden metadata keys blocked in notifications | **Enforced** | `FORBIDDEN_METADATA_KEYS` |
| Every alert traceable to a user-authored rule | **Enforced** | `WatchObservation.ruleEvaluations` stores per-rule results per sweep |
| Audit trail of what was evaluated and when | **Stored** | `WatchObservation`, including sweeps that could not read the market |
| User data isolation | **Enforced at the gateway** | `services/api` fills `userId` from `req.user.sub`; client query strings are not forwarded |
| Entitlement gating | **Enforced** | `AuthGuard` + `CapabilityGuard('sentinel')` |

**Not yet evidenced:** behaviour against live market data. See PLAN.md §4.
