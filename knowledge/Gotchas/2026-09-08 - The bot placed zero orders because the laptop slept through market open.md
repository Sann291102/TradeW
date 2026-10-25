---
type: gotcha
date: 2026-09-08
tags: [gotcha, paper-execution, operations, market-data, diagnosis]
---

# The bot placed zero orders because the laptop slept through market open

**Read FIRST when asked "why has the autonomous bot placed no orders?" — before reading any
execution code.** The answer is almost never in the execution path. Rank the hypotheses by
what the running system can prove, in this order.

## The diagnosis that actually worked (2026-09-08)

`ExecutionEvaluationLog` is the whole diagnostic. It is written on **every** tick, for every
armed profile, whatever the verdict — so its *shape over time* answers "is the bot running?"
without touching a single service.

```sql
-- 1. Is the loop ticking at all, and when did it stop?
select date_trunc('minute', at) at_utc, count(*)
from "ExecutionEvaluationLog" where at > now() - interval '6 hours'
group by 1 order by 1;

-- 2. What has it actually been deciding?
select outcome, verdict, "checkId", "marketState", count(*), min(confidence), max(confidence)
from "ExecutionEvaluationLog" group by 1,2,3,4 order by count(*) desc;
```

That second query returned **5202 of 5223 rows = `MARKET_CLOSED`**. The bot had essentially
never been alive while the Indian market was open. Everything else was a red herring.

## The cause: Windows Modern Standby, not a crash

The API process **never died** — `.logs/api.log` showed no exception and no restart. What it
showed was `LeaderElectionService` *re-acquiring* every lease at 8:45, 11:00, 11:35, 11:38,
12:13. A lease is only re-acquired after it **expires**, so the process had stopped renewing
for hours at a stretch: its timers were frozen, not dead.

Confirmed against the OS, which is the evidence that settles it:

```powershell
Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'} |
  Where-Object {$_.Id -in 42,107,506,507}
```

`506 = entering Modern Standby`, `507 = exiting`. Entered 8:38, and the last eval row was
written at **08:44:18** — the same second as a 506. Market opens 09:15. The machine stayed in
standby until 12:13. **Zero orders was the correct behaviour of a bot that was asleep.**

The Prisma `Can't reach database server at localhost:5433` errors at 11:36 are a *symptom of
the wake*, not a cause: on resume the process's timers all fire at once while Docker's port
forward is not yet back. Do not chase them.

## Why "no orders" is usually not a bug at all

Even fully awake, the resting state is `no-side-in-focus` — Sentinel observed the market and
published nothing. The gate is `observation.sideInFocus` in
`services/sentinel/src/execution/execution-evaluation.service.ts`, which needs Sentinel's own
publication conditions (see [[Decisions/Sentinel publication gate]]); a profile's
`minConfidence` is a **second, stricter floor and never a looser one**. On this day Sentinel
sat at 47–49% against a 70% floor. That is the strategy working.

**So separate these three, and never collapse them into "no trade":**

| | Proof |
|---|---|
| Bot not running | a *hole* in `ExecutionEvaluationLog`, or rows saying `MARKET_CLOSED` |
| Running, no setup | rows saying `no-side-in-focus` with a live spot that moves tick to tick |
| Setup blocked downstream | a `rejectReason` / `rejectCheckId` on `ExecutionIntent` |

## Prove the downstream path without manufacturing a trade

`npm run verify:execution-path -w @tradew/api` already exists for exactly this. It walks every
gate *after* Sentinel against live data — contract resolution, live premium, freshness, wallet,
risk plan, all 14 policy checks, discipline — and **never calls `placeOrder`**. It substitutes
confidence at the profile's own floor and says so on every run, so a pass can never be misread
as a real signal. Run it before concluding anything is broken downstream.

## Two things that look broken and are not

- **The `Candle` table is months stale.** The execution path does not read it. Sentinel reads
  the market-data bridge (`GET localhost:4600/candles`), which is live. Verify with the bridge,
  not the table.
- **`ExecutionPosition` / `ExecutionJournal` are empty despite closed intents.** Those tables
  were created by `20260830000000_autonomous_paper_agents`, *after* the only real bot trades
  (2026-08-18). Check the migration date before calling a table "not being written".

The bridge's candle parameter is **`interval`**, not `timeframe` — an unknown parameter is
silently ignored and you get the 5m default, which looks exactly like "all timeframes return
the same bars". Related: [[Gotchas/2026-09-07 - The app hid the bot's own orders behind a default tab]].
