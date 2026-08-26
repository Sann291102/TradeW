# Sentinel Automatic Paper Trading — Operator Runbook

**Scope:** the autonomous paper-execution loop in `services/api/src/paper-execution/`,
which turns a Sentinel observation that already cleared Sentinel's own gates into
a PAPER order through the existing `OrderService`, tracks it to a recorded
outcome, reconciles reality against the database, and squares off automatically.

Live money is **unrepresentable**: `ExecutionEnvironment` has exactly one member,
`PAPER`. There is no enum value to route to real capital, so no env var, config
change or compromised session can move this loop onto real money — only a schema
migration and a code review could.

---

## What is operational

The end-to-end lifecycle runs against real SQL and is proven by the integration
harness (see [Test evidence](#test-evidence)):

```
Sentinel evaluation → ITM/ATM/OTM strike selection → ExecutionIntent
  → 10-check risk policy → OrderService → fill → Trade → Position
  → reconcile → square-off → realized P&L → ExecutionOutcome → analytics
```

Discipline, safety and observability added in the 2026-08-26 hardening pass:

- **Global kill switch** — `SystemExecutionControl` (ON / OFF / EMERGENCY_STOP),
  read fresh every pass, audited, no redeploy.
- **Stale/missing market-data guard** — a quote older than the freshness limit
  is refused (`fresh-market-data`); the loop never fills against a dead feed.
- **One authoritative NSE session** — weekend / holiday / pre-market / active /
  post-market; entries only in `active`.
- **Restart recovery** — an intent orphaned by a crash mid-submit is failed out.
- **Performance analytics** — measurement only, no self-modification.
- **A derived liveness health surface** — no hard-coded "RUNNING" label.

---

## How to enable paper execution

Two switches, both required, in two different places (so neither alone can start
trading):

1. **Process env:** `PAPER_EXECUTION_ENABLED=true` on the `services/api` process.
   Off, the scheduler starts **no timers**.
2. **Per profile:** the profile's own `enabled` column (arm it — see below).

The runtime kill switch must also be `ON` (its default). If someone left it at
`OFF`/`EMERGENCY_STOP`, no new entries open regardless of the two switches above.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PAPER_EXECUTION_ENABLED` | `false` | Whether the scheduler's timers exist at all. |
| `PAPER_EXECUTION_INTERVAL_MS` | `60000` | Evaluate-tick cadence (opens positions). |
| `PAPER_EXECUTION_RECONCILE_MS` | `15000` | Reconcile/square-off cadence. |
| `PAPER_EXECUTION_MAX_QUOTE_AGE_MS` | `20000` | A quote older than this is stale → NO TRADE. |
| `PAPER_EXECUTION_REQUIRE_FRESH_QUOTE` | `false` | Strict: refuse an untimed quote too. |
| `PAPER_EXECUTION_ALLOWED_SYMBOLS` | `NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY` | Market allowlist. |
| `PAPER_EXECUTION_ALLOWED_AGENTS` | `sentinel-alpha,sentinel-beta,sentinel-gamma` | Agent allowlist. |
| `SENTINEL_SERVICE_URL` / `SENTINEL_SERVICE_TOKEN` | — | The api→sentinel `/execution/evaluate` hop. Unset token ⇒ loop fails closed. |
| `SENTINEL_EXECUTION_TIMEOUT_MS` | `30000` | Ceiling on that call. |
| `DHAN_LIVE_URL` | `http://localhost:4600` | The live market-data bridge the OMS prices against. |

The **kill switch mode is not an env var** — it is the `SystemExecutionControl`
row, flipped from the console so it takes effect on the next pass.

---

## How to arm a profile

Create/rebind and arm through the admin console (all routes under
`/admin/execution/*`, behind `AdminAccessGuard`):

1. `POST /admin/execution/profiles` — create or rebind (never armed on create).
2. `GET /admin/execution/profiles/:id/authorization` — confirm it *would* be
   allowed to trade right now (env PAPER, scope matches account, consent present
   for USER_PAPER, market + agent allowed, wallet).
3. `POST /admin/execution/profiles/:id/enabled` `{ "enabled": true }` — arm it
   (separately audited: arming is never a side effect of editing sizing).

CLI alternative: `npm run execution:profile -w @tradew/database -- --name … --enable`.

## How to authorize an account (USER_PAPER)

To let an agent trade a **real user's** paper account, that user's recorded
consent is required and re-read every pass:

- `GET /admin/execution/accounts` — eligible real accounts (no credentials).
- `POST /admin/execution/accounts/:userId/agent-trading` `{ "enabled": true }` —
  grant (audited with the operator). Revoking here stops the agent on its next
  pass; a cached grant never outlives its revocation.

A `SYSTEM_PAPER` profile needs no consent — its account is a non-loginable
machine account.

---

## How to monitor execution

| Endpoint | Answers |
|---|---|
| `GET /admin/execution/health` | Is the loop alive? Derived headline (RUNNING/HALTED/PAUSED/IDLE/DISABLED), leader leases, heartbeats, live NSE session, feed-freshness probe, kill-switch mode, today's orders/fills/open positions/rejections/realized P&L, latest execution/rejection/failure. |
| `GET /admin/execution/status` | Loop liveness only (timers, leases, last ticks, session). |
| `GET /admin/execution/stats` | Headline counts + win rate over a window. |
| `GET /admin/execution/analytics` | Performance: win rate, expectancy, profit factor, drawdown; breakdowns by strategy / confidence band / instrument / strike role / regime / hour / exit reason / side. |
| `GET /admin/execution/rejections` | "Why did nothing trade?" grouped by the gate that stopped it. |
| `GET /admin/execution/intents` | Recent decisions and their state. |
| `GET /admin/execution/trace/:intentId` | The full backward+forward provenance of one decision. |

**Sentinel silence is normal.** A quiet loop that produces no intents because no
setup cleared the gates is working correctly, not broken — the rejection
breakdown and the intent feed distinguish "nothing qualified" from "something is
wrong".

---

## How to stop all agents (the kill switch)

`POST /admin/execution/control` with a body of:

- `{ "mode": "OFF", "reason": "…" }` — **pause.** No new entries; open positions
  still close on their own square-off schedule.
- `{ "mode": "EMERGENCY_STOP", "reason": "…" }` — **stop now.** No new entries AND
  every open agent position is squared off on the next reconcile tick, ignoring
  each profile's square-off minute. Lifecycle cleanup is exactly what an
  emergency stop must not block.
- `{ "mode": "ON", "reason": "…" }` — resume.

`GET /admin/execution/control` shows the current mode, who set it, and when. Every
change is audited (`execution.system-control.set`). The effect is immediate — the
loop re-reads the switch each pass; no redeploy.

Per-profile stop: `POST /admin/execution/profiles/:id/enabled` `{ "enabled": false }`.

---

## How to recover from failures

The loop fails **safe** and self-heals; the reconcile tick reconciles the
database against reality every interval and once shortly after boot.

| Failure | Behaviour |
|---|---|
| Sentinel unavailable / timeout / 500 | No trade. The pass records the skip; the next pass retries. |
| Market data unavailable | No trade — the contract can't be priced (`failed`) or the quote is stale (`fresh-market-data`). Never a fill at a default price. |
| OMS raises on submit | Intent `FAILED` (`submission-raised`); idempotency prevents a duplicate on retry. |
| Process restart mid-submit | A PROPOSED intent with no order, older than 2 min, is failed out under `recovery-orphaned` on the next reconcile (guarded on status, so it can never clobber an intent that became an order). |
| Missed square-off tick | The next reconcile squares off any position past its window; a startup pass catches up immediately. |
| Database unreachable | The kill-switch read fails **closed** (no new entries); nothing assumes an execution succeeded. |

Idempotency is a database uniqueness constraint on the decision, claimed by
INSERT **before** any order exists — never a check-then-insert. Two ticks, two
replicas, a retry, or a reconnect all converge on one intent and one order.

---

## Known limitations

- **No live-stack acceptance run in this environment.** The repo ships no
  `docker-compose`, and the live Dhan bridge needs a real broker credential and
  an open market, so the literal "live feed → real signal → real fill" run has
  not been executed here. Everything above is proven by the unit suite and the
  real-Postgres integration harness; a staging run against the live bridge during
  market hours is the remaining step before calling it production-ready.
- **The live Dhan bridge is not yet a first-class deployed service** — it has a
  Dockerfile but is not in a compose/orchestration file, and there is no
  `/health` route on it. Until it is deployed and health-checked, the OMS has no
  price source in a stock production stack.
- **Paper OMS realism**: margin is simplified (not real SPAN), no partial fills,
  no bracket/OCO. Inherited from the underlying paper OMS.
- **Analytics is measurement only.** Nothing feeds these numbers back into
  Sentinel weights or strike rules yet — that calibration phase is deliberately
  not built.
- **Multi-profile is architecturally supported and integration-tested for one
  profile**; running several concurrently is designed for but not yet exercised
  at scale against a live feed.

---

## Test evidence

Unit suite (`services/api`, no DB required):

```
npx vitest run    # 45 files, 610 tests green — incl. system-execution-control,
                  # execution-policy (fresh-market-data), market-session,
                  # execution-lifecycle-recovery, execution-analytics, execution-health
```

Real-Postgres integration harness (drives the real loop against real SQL):

```
DATABASE_URL=postgresql://…/tradew_test \
  npx vitest run --config vitest.integration.config.ts    # 9 tests green
```

The integration harness proves, end to end: the full success lifecycle
(intent → order → fill → OPEN → square-off → CLOSED with realized P&L),
idempotency (one intent / one order for a repeated decision), the rejection
matrix (no-signal, below-confidence, stale-data, holiday, kill-switch OFF,
EMERGENCY_STOP force-flatten), and orphan recovery.
