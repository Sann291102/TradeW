---
type: decision
date: 2026-08-18
tags: [decision, sentinel, execution, accounts, consent, paper-trading, admin]
---

# Sentinel paper execution bound to real TradeW user accounts

Follows [[Decisions/2026-08-18 - Sentinel paper execution loop (execution capability, not a second Sentinel)]],
which executed only into dedicated machine accounts. An execution profile can
now target an ordinary TradeW user's own paper account.

## The mechanism is that there is no mechanism

`GET /sim/orders` and `GET /sim/positions` scope by `req.user.sub` and read the
same `Order` / `Position` tables the admin console reads. So writing the order
under the user's own `userId` is the entire integration — the user's app shows
it because it is **literally the same row**. No sync layer, no mirroring, no
admin-side ledger, and no frontend change was needed or made.

Verified by reading through both paths and asserting equality:

| Path | Call | Result |
|---|---|---|
| Admin | `AdminService.orders({source:'sentinel'})` → `/admin/orders` | `443d6dc9-…` |
| User app | `OrderService.orderBook(userId)` → `/sim/orders` | `443d6dc9-…` |

Same id, one row, `count(executionIntentId = intent) === 1`.

## Schema: two additive columns, no backfill

- `ExecutionAccountScope { SYSTEM_PAPER, USER_PAPER }`, and
  `ExecutionProfile.accountScope` defaulting to **SYSTEM_PAPER** — which is why
  the pre-existing profile kept working untouched.
- `User.agentPaperTradingEnabledAt` / `agentPaperTradingGrantedBy`. A
  **timestamp**, not a boolean, for the reason `phoneVerifiedAt` is one: the
  audit question is *when*, and by whom.

`ExecutionEnvironment` still has exactly one member. Live money stayed
unrepresentable.

## The scope column is a declaration, not a permission

This is the part worth remembering. `accountScope` is written by an operator, so
trusting it would leave two routes to trading a real person's money without
consent, and `authorizeAccount` closes both:

1. **Label a real account SYSTEM_PAPER** to skip the consent check →
   SYSTEM_PAPER additionally requires the account be structurally
   **non-loginable** (no `passwordHash`, no `googleId`).
2. **Mark it USER_PAPER and never ask** → USER_PAPER requires
   `agentPaperTradingEnabledAt`, **re-read on every pass**, never cached on the
   profile. A cached grant is a grant that survives its own revocation.

Enforced at write time (`ExecutionProfileService.upsert`) *and* at run time
(`runProfile`), because a profile can become unauthorized after it is saved.

**No credential is involved anywhere.** `authorize` collapses
`passwordHash`/`googleId` to booleans at the query boundary; `eligibleAccounts`
does not select them at all. There is no password field in the schema, the DTOs,
the UI or the env.

## Two bugs that only a real account could expose

Both were found by binding to `vivek.sannidhi29@gmail.com` and would never have
appeared on a dedicated machine account.

**1. A human's own positions disarmed their agent.** `maxOpenPositions` counted
*every* open position on the account. A trader holding one position of their own
consumed the agent's entire `maxOpenPositions: 1` budget — "1 open against a 1
limit" — a deadlock lasting as long as they held anything. Now counted from the
profile's own FILLED intents. Note the deliberate asymmetry with
`maxLossPerDay`, which stays **account-wide**: the position limit governs the
agent's concurrency, the loss limit governs shared *capital*, so there a human's
losses correctly stop the agent.

**2. A rejected decision owned the window.** A policy rejection produced an
intent with no order, and its idempotency key then blocked that contract for the
remaining 15 minutes — even though the rejection was conditional on state that
moves ("1 open against a 1 limit" stops being true when the position closes).
Now a `REJECTED`/`FAILED` intent **with no order** is re-claimed via a
conditional `updateMany` guarded on `status` (atomic, so a racing replica loses
and falls through to the duplicate path). An intent that owns an order is never
re-claimed — that is the case idempotency is actually about.

## Evidence

- `npm run verify:user-binding -w @tradew/api` — **40/40**, real account, real
  order `443d6dc9-3f43-4ec0-8ea5-d28fd0ce30c2`, wallet ₹8,77,471 → ₹8,72,451 on
  entry, realized ₹0 → ₹−26 after square-off.
- `npm run verify:paper-execution -w @tradew/api` — **41/41**, SYSTEM_PAPER
  unchanged before and after.
- `npm run verify:admin-routes -w @tradew/api` — 11/11 routes declared. Reads
  decorator metadata rather than booting Nest, so it cannot contend for the
  leader lease with a running dev server.

Market was closed, so the decision was recorded rather than live-published and
the session gate was overridden for the downstream path only — both printed by
the script. **Not** a live-market verification; see
[[Gotchas/2026-08-18 - Sentinel telemetry sink is never installed]] for the one
trace stage that stays unpopulated.
