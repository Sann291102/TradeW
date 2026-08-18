---
type: gotcha
date: 2026-08-18
tags: [gotcha, sentinel, execution, orders, admin, discipline, caching, audit]
---

# "Paper orders are not appearing in Admin / Web" is almost always *no order was created*

An end-to-end audit of the Sentinel paper-order visibility path — Sentinel
execution → `OrderService` → Postgres → `/admin/orders` → admin console →
`/sim/orders` → apps/web. **The read path was clean at every hop.** The orders
the operator expected to see did not exist.

Worth writing down because the symptom ("counters climb, the list stays flat")
points hard at a query filter, a cache or a stale poll, and a day can be spent
there before anyone checks whether a row was ever written.

## What the read path actually does (measured, not read)

Queried at the same instant against the running stack, for the two real agent
order ids `443d6dc9-…` and `46e57c7f-…`:

| Hop | Result |
|---|---|
| `/admin/orders/stats?hours=24` | byStatus total **6** |
| `/admin/orders?hours=24&limit=200` | **6** rows, both ids PRESENT |
| `/admin/orders?…&source=sentinel` | **2** rows, both ids PRESENT |
| `/sim/orders` (bound user's JWT) | **6** rows, both ids PRESENT |
| admin console proxy leg (`:3001/api/proxy/orders`) | **6** rows, both ids PRESENT |

Field-by-field `status/side/type/quantity/filledQuantity/price/avgFillPrice/
placedAt/executionIntentId` — **no diffs** between the admin row and the user
row. Stats total equalled list rows exactly. `AdminService.orders` and
`orderStats` share one window (`placedAt >= since(hours, 24)`), so they cannot
drift by construction; there is no ownership, source, window or serialization
divergence to find.

Live propagation, timed on a fresh order: visible at **all three** hops within
**196 ms** of creation, and a cancel reached all three within **86 ms**. One
row, one id, no duplication, no sync layer — exactly as
[[Decisions/2026-08-18 - Sentinel paper execution bound to real TradeW user accounts]] claims.

## Where the orders actually stopped: two independent daily-loss gates

The bound account (`vivek.sannidhi29@gmail.com`) had a **real** loss that day —
a manual SELL of 650 × `NIFTY:20260818:24250:CE` @ 17.75 realized **−110,955**.
That single human trade closed both doors, and both are *working as designed*:

1. **`evaluatePolicy` → `maxLossPerDay`** — account-wide by deliberate design
   (the position limit governs the agent's concurrency, the loss limit governs
   shared *capital*). `realizedPnlToday` = **−110,987.50** against the profile's
   **25,000** floor → every pass produces a **REJECTED intent with no Order row**.
2. **`DisciplineService.evaluatePlacement`** — runs unconditionally inside
   `OrderService.placeOrder`, so it gates the agent too. Returns **409
   `discipline_limit`** (MAX_LOSS −110,955 vs 100,000; also MAX_MINUTES 502 vs
   240). `PaperExecutionService` catches the throw and marks the intent
   **FAILED** — again **no Order row**.

So intents accumulate and orders do not. **`ExecutionQueryService.stats` groups
`ExecutionIntent` by status with no join to `Order` at all**, which is why the
Sentinel scoreboard keeps moving while the recent-orders table cannot. The card
is honestly labelled "Intents" — read the label before concluding the list is
broken.

**Do not "fix" either gate.** A human's losses stopping their own agent is the
behaviour the account-wide loss bound exists to produce. Never place the order
by passing `overrideToken` from the loop: the override is a *human* friction
mechanism (signed, single-use, 20 s dwell, 40-char reason) and an agent that can
mint one has no limit at all.

## The one real defect found, and it was not the cause

`apps/admin/src/app/api/proxy/[...path]/route.ts` **rebuilds** the upstream
response and used to copy only `content-type`. `services/api` sends
`Cache-Control: no-store`; the browser was getting **no cache directive and no
validator**. Measured: upstream `no-store`, proxy `(NONE)`.

Latent rather than active — nothing was observably stale — but every page in
that console is a `usePolling` loop over these exact URLs (Orders re-reads
`/orders` every 8 s), and a polled JSON URL with no directive is one heuristic
-freshness decision away from a console that repaints the same rows forever
while the metric cards above them climb. That failure would be *indistinguishable
from this very bug*, which is why it is now restated explicitly (not forwarded)
and pinned by `src/lib/adminProxyCacheHeaders.test.ts`.

## The check that would have saved the day

Before touching any query, cache or poll, ask the database whether the row
exists:

```sql
SELECT count(*) FROM "Order" WHERE "executionIntentId" IS NOT NULL;
SELECT status, count(*) FROM "ExecutionIntent" GROUP BY status;
```

Intents present with `REJECTED`/`FAILED` and no matching orders = a **write-path
stop**, and the reason is on `ExecutionIntent.rejectReason`. Two more traps in
the same area: agent **square-off** orders carry `executionIntentId = null` (one
intent submits exactly one order, `@unique`), so `source=sentinel` shows an
agent's entry and never its exit; and `apps/web`'s `OrdersSection` opens on the
**Open** tab (`OPEN/TRIGGER_PENDING/PARTIALLY_FILLED`), so an instantly-FILLED
agent order is invisible there until the user picks **Executed**.

Related: [[Decisions/2026-08-18 - Sentinel paper execution loop (execution capability, not a second Sentinel)]],
[[Gotchas/2026-08-18 - Sentinel telemetry sink is never installed]].
