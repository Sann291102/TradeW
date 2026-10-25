# Autonomous Paper-Trading Lifecycle — Readiness Audit & Build Plan

**Date:** 2026-09-07 · **Author:** Claude (Opus 4.8), commissioned by Vivek
**Scope:** Make the autonomous bots manage the *complete* trade lifecycle in **PAPER** — plan → enter → manage → trail → target → exit → post-trade analysis → learning → improvement — with hard, independent risk controls, a knowledge pipeline, regime awareness, and full observability.
**Non-goal (explicit):** No live-money execution. `ExecutionEnvironment` stays single-member `PAPER`. Honors CLAUDE.md Rule 2 and ADR-046.

> This report is grounded in the actual source, not the docs. Every "BUILT" line names the file that backs it. The distinction the brief demanded — simulation vs. paper vs. live-data vs. order-decision vs. order-submitted/filled — is preserved throughout.

---

## 0. The one fact that reframes everything

**There is no live-money order path in this repository, by construction.**

- `packages/database/prisma/schema.prisma:2052` — `enum ExecutionEnvironment { PAPER }`. One member. Live money is *unrepresentable*, not merely disabled.
- Every `placeOrder` routes to the paper OMS `services/api/src/sim` (fills internally at last price). No broker order client is wired in anywhere.
- `services/trading-engine/` (the intended live bot) is a **README-only stub**.
- External blocker even if built: Dhan order APIs require **static-IP whitelisting with a 7-day change lock** (SEBI algo rule) + 24h token expiry.

Consequence for tomorrow: we can run **autonomous bots on live market DATA, making real decisions and paper executions, fully observable** — that is genuine and achievable. We must never label a paper fill a real trade (§11 of the brief; already enforced by `environment` stamping everywhere).

---

## 1. What already exists (BUILT — verified in code)

The system is far more complete than "signals only." This is a real autonomous paper-trading engine.

| Brief requirement | Status | Evidence |
|---|---|---|
| §1 Autonomous decision → **explicit Trade Plan** (bias, contract, entry, stop, target, R:R, size, confidence, invalidation) | **BUILT** | `paper-execution.service.ts` writes an `ExecutionIntent` carrying bias, strike, planned entry, stop, target, risk budget, reward target, confidence, evidence, regime, calibration version — atomically, *before* any order. The intent **is** the trade plan. |
| §1 Wait/enter/exit/hold verdicts | **BUILT** | `decidePosition()` + Sentinel's 5 gates + `no-side-in-focus` resting state (`docs/AUTONOMOUS-TRADING.md`). |
| §2 Position lifecycle: hold / move stop / trail / exit-at-target / exit-on-stop / exit-on-invalidation / square-off / emergency | **BUILT** | `position-manager.service.ts` (2s loop) + `position-decision.ts` (6-level precedence: EMERGENCY > STOP > TARGET > TRAIL > INVALIDATED > SQUARE_OFF). Atomic-claim exits; disarmed profiles still managed. |
| §2 React to stale feed / dead feed / regime change | **BUILT** | EMERGENCY exit on no-price/frozen-feed/closed-session; thesis-invalidation exit from strategy exit-rules. |
| §3 Per-trade experience record | **PARTIAL** | `ExecutionJournal` records market state, evidence, confirmations, index direction, confidence, strategy+version+regime, entry/exit, stop/target, trail history, exit reason, holding seconds, realized P&L, charges, **R-multiple**, calibration version. **Missing: MFE, MAE, explicit slippage, structured post-trade "expected vs actual / thesis-correct / confidence-vs-outcome".** |
| §4 Controlled learning (no uncontrolled self-modification) | **PARTIAL** | `execution-calibration.ts` folds outcomes into `(agent,symbol,strategy,version,regime)` buckets and **can only ever tighten** the confidence floor (clamped at platform 70). This is the anti-catastrophe design. **Missing: the staged Candidate-Improvement → Validation (backtest/replay/walk-forward) → Promotion pipeline for strategy/param changes.** |
| §5 Knowledge Graph / Brain | **BUILT (retrieval)** | Sentinel Brain (Postgres + pgvector), concept ontology (`knowledge-base/`), citation corpus (223 docs/2229 chunks). **Missing: an operator-facing ingest pipeline for *new* books/research with provenance/version/reliability metadata as a first-class flow.** |
| §6 Combine data + history + strategy + textbook + KG + own execution history | **PARTIAL** | Decisions use live data + strategy rules + KG corpus + calibration history. **Missing: explicit theory-vs-observed comparison per concept/regime.** |
| §7 Regime awareness | **PARTIAL** | `regime` is recorded on every intent/journal and buckets calibration. **Regime is consumed but its *classification* is coarse; a first-class regime classifier (trending/ranging/breakout/mean-revert/high-vol/low-vol/event/gap) is not centralized.** |
| §8 Autonomous strategy selection by regime | **PARTIAL** | `strategyIds` roster per mandate + Sentinel `auto` mode selects among them. **Regime→strategy fitness learned from outcomes is not yet a selection input.** |
| §9 Hard, independent risk controls | **PARTIAL — see §2 below** | Max size, allocation ceiling, risk budget, daily-loss (account-wide), order limits, dup-order prevention, instrument restriction, margin/funds — **BUILT**. **Missing: runtime kill switch (global + per-bot) with emergency-flatten, and max-drawdown.** |
| §10 Full observability (STATUS/THINKING/POSITION/LEARNING/AUDIT) | **PARTIAL** | Backend surfaces exist: `agentState()`, `PositionManagerService.liveState()`, `ExecutionSchedulerService.status()`, rejections, journal, trace. **Admin UI (`apps/admin`) coverage of all five panels needs an audit/build.** |
| §11 Never fake autonomous trading (state ladder) | **BUILT** | `environment` stamped on every row; `ExecutionIntentStatus` = PROPOSED/REJECTED/SUBMITTED/FILLED/FAILED/CLOSED; `ExecutionPositionState` = OPEN/EXITING/CLOSED; every action carries a timestamped reason. |
| §12 Daily learning cycle (analyze trades + missed + planned-vs-actual → memory → candidates → validate → promote → report) | **PARTIAL** | Sentinel `MarketCloseAnalysisService` reviews the *session narrative* (setups detected/confirmed/missed). Per-trade calibration folds continuously. **Missing: an agent-execution EOD cycle that ties trades → planned-vs-actual → candidate improvements → validation → promotion → report.** |

**Infrastructure BUILT and reused:** three-cadence leader-elected scheduler (evaluate 30s / manage 2s / reconcile 15s), off-by-default two-act arming, idempotency via unique `idempotencyKey`, `JobLease` leader election, Dhan live-feed bridge (candles/quotes/optionchain), paper OMS with T+1 settlement, `Backtest*` replay engine (no look-ahead, verified), Agent-Lab Phase-0 scaffolding (`labEnabled`/`ExperimentEvent`).

---

## 2. Hard-risk-control gap detail (§9 — the safety-critical set)

| Control | Status | Where |
|---|---|---|
| Max position size | BUILT | `execution-risk.ts` (lots × allocation ceiling × risk budget) |
| Max exposure (per trade) | BUILT | `capitalAllocationPct` |
| **Max aggregate exposure (portfolio)** | **GAP** | only position *count* bounded (`maxOpenPositions`) |
| Max daily loss (account-wide) | BUILT | `execution-policy.ts` `daily-loss-limit` |
| **Max drawdown** | **GAP** | no peak-to-trough equity control |
| Order limits / day | BUILT | `max-orders-per-day` |
| Duplicate-order prevention | BUILT | `idempotencyKey` unique + atomic claim |
| Instrument restriction | BUILT | mandate `symbol` + `strategyIds` + long-options-only constant |
| Margin/funds check | BUILT | `affordable` + OMS `computeMargin` |
| **Emergency shutdown (runtime)** | **GAP** | only `PAPER_EXECUTION_ENABLED` (needs restart) |
| Per-bot kill (halt entries) | BUILT | `profile.enabled = false` |
| **Per-bot kill (halt + flatten now)** | **GAP** | no force-flatten action |
| **Global kill switch (runtime)** | **GAP** | no runtime halt-all |
| Broker/API failure handling | BUILT | freshness gate + EMERGENCY exit |
| Learning cannot disable controls | BUILT | calibration only *tightens*, clamped at floor; enum has no LIVE |

**The bot cannot override risk controls** today (good) — but a human operator also cannot *instantly* halt-and-flatten without a restart. That is the top safety gap and Phase 1 below.

---

## 3. Readiness audit — the brief's 15 verification points

| # | Item | Status | Note |
|---|---|---|---|
| 1 | Broker/API auth & permissions | **LIVE (data only)** | Dhan feed token, 24h SEBI cap, browser-2FA mint. No order permission (by design). |
| 2 | Live market-data connectivity + instrument mapping | **LIVE** | bridge `/candles`/`/quotes`/`/optionchain`; scrip-master resolves contracts. Token freshness is the daily operational risk. |
| 3 | Order place/modify/cancel/fill | **PAPER** | `sim` OMS only. No live broker order path. |
| 4 | Position reconciliation with broker | **N/A (paper)** | reconciled against paper OMS rows, not a broker. |
| 5 | Risk management / max-loss | **PARTIAL** | daily-loss yes; drawdown + kill switch = Phase 1. |
| 6 | Position sizing / exposure limits | **BUILT** | per-trade; portfolio aggregate = Phase 1. |
| 7 | Duplicate-order prevention | **BUILT** | idempotency. |
| 8 | Partial fills / rejects / timeouts / disconnects / stale prices / API failures | **BUILT** | freshness + EMERGENCY exit + retry-on-exit-failure. |
| 9 | Market-hours / pre-open / open / close | **BUILT** | `market-calendar` + session gates + square-off. |
| 10 | Recovery after restart / network failure | **BUILT** | state in Postgres; in-memory caches degrade safely; positions re-managed on restart. |
| 11 | Persistent trade/execution logging | **BUILT** | `ExecutionIntent`/`Outcome`/`Position`/`Journal`/`TrailAdjustment`. |
| 12 | Bot state persistence | **BUILT** | mandates + positions in DB; loop status is (correctly) process-local. |
| 13 | Learning-memory persistence | **BUILT** | calibration buckets; Brain memory. |
| 14 | KG retrieval during decisions | **BUILT** | Sentinel corpus/Brain in the evaluate path. |
| 15 | Monitoring / alerts / audit trail | **PARTIAL** | rich per-decision audit; UI panels + alerting = Phase 3. |

---

## 4. Exact commands to run the autonomous PAPER bots on tomorrow's live session

```bash
# 0. Ensure the Dhan feed token is fresh (SEBI 24h cap — must be minted for the day)
#    (browser-2FA consent flow; see dhan-supervisor). Confirm the bridge is serving live data.

# 1. Create the mandates (idempotent; creates NIFTY + SENSEX agents DISARMED)
npm run agents:seed -w @tradew/database
npm run agents:seed -w @tradew/database -- --list     # review what exists

# 2. Turn the loop clock ON (env), then restart the API process
#    In the API process environment:
#      PAPER_EXECUTION_ENABLED=true
#    Restart services/api.

# 3. Arm the specific mandates you want live (per-profile, an audited operator act)
#    POST /admin/execution/profiles/:id/enabled     (via the admin console)

# 4. Confirm the loop is actually ticking (process fact, not a DB flag)
#    GET /admin/execution/status        -> enabled:true, isEvaluateLeader:true, lastEvaluateAt advancing
#    GET /admin/execution/profiles      -> which mandates are armed
#    GET /admin/execution/rejections    -> why nothing traded (no-side-in-focus is the normal resting state)
#    GET /admin/execution/intents       -> decisions made
#    GET /admin/execution/positions     -> what is held right now
```

**Required env/secrets:** `PAPER_EXECUTION_ENABLED=true`; Dhan feed creds (`DHAN_API_KEY`/`DHAN_API_SECRET` + minted 24h token); `SENTINEL_LIVE_FEED_URL`; `SENTINEL_SERVICE_TOKEN`; DB `DATABASE_URL`; operator auth (`OPERATOR_JWT_SECRET`, `ADMIN_SESSION_SECRET`, `ADMIN_API_TOKEN`). Optional cadence overrides: `PAPER_EXECUTION_INTERVAL_MS`/`_MANAGE_MS`/`_RECONCILE_MS`/`_MAX_QUOTE_AGE_MS`.

**Reality check for tomorrow:** the paper loop has **never been verified against a live open market** (all prior verification was market-closed with scripted prices). So tomorrow is also its first true live-data shakedown — expect to watch `status`/`rejections` closely.

---

## 5. Phased build plan (incremental, additive, reversible — CLAUDE.md Rule 3)

**Phase 1 — Hard risk controls (safety-critical, do first).**
Runtime **global kill switch** + **per-bot halt-and-flatten**, **max-drawdown** control, **portfolio aggregate-exposure** cap. Additive `ExecutionControl` table + `maxDrawdownPct`/`maxPortfolioExposurePct` columns; enforced in the execution path (not the orchestrator), unoverridable by learning. Admin endpoints + tests.

**Phase 2 — Post-trade analytics (§3/§6).**
Add MFE/MAE tracking (`lowWaterPrice` mirror of `highWaterPrice`), explicit slippage, and a structured `postTradeAnalysis` (expected-vs-actual, thesis-correct, confidence-vs-outcome, missed upside after exit) computed at journal write.

**Phase 3 — Observability UI (§10).**
Per-bot STATUS / CURRENT THINKING / POSITION / LEARNING / AUDIT panels in `apps/admin`, on the existing backend surfaces, with the §11 state ladder shown explicitly and paper clearly labeled.

**Phase 4 — Regime + strategy selection (§7/§8).**
Centralize a regime classifier; feed regime→strategy fitness (from calibration buckets) into `auto` selection.

**Phase 5 — Staged learning pipeline (§4/§12).**
Candidate-Improvement → Validation (reuse `Backtest*` replay + walk-forward) → operator-gated Promotion (reuse `CognitiveProposal` governance). Agent-execution **Daily Learning Cycle** job producing a daily report. **No uncontrolled self-modification** — promotion is always operator-gated + validated.

**Phase 6 — Knowledge ingestion (§5).**
Operator-facing ingest for new books/research with provenance/version/reliability + concept linking, feeding the same corpus the bots already read.

---

## 6. LIVE / NOT-LIVE summary

| Component | Status |
|---|---|
| Live market **data** feed | **LIVE** (Dhan bridge; daily token dependency) |
| Autonomous **decision** engine | **LIVE-capable** (runs on live data) |
| Trade **plan** generation | **LIVE-capable** |
| Position **management** (stop/target/trail/exit) | **LIVE-capable** (paper) |
| **Order submission** | **PAPER ONLY** (sim OMS; no broker path) |
| **Real-money execution** | **NOT LIVE — unbuilt by design; will remain so** |
| Learning / calibration | **LIVE-capable** (per-trade, tightening-only) |
| KG retrieval | **LIVE** |
| KG new-material ingestion | **NOT BUILT as an operator flow** (Phase 6) |
| Kill switch (runtime) | **NOT BUILT** (Phase 1) |
| Max drawdown | **NOT BUILT** (Phase 1) |
| Observability UI (5 panels) | **PARTIAL** (backend live; UI Phase 3) |
| Daily learning cycle (agent-execution) | **PARTIAL** (Phase 5) |

---

*Implementation proceeds in the phases above, each verified before the next. Nothing here adds a live-money path; every change is additive and reversible.*
