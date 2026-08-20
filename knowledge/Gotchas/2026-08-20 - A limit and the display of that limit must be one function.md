---
type: gotcha
date: 2026-08-20
tags: [gotcha, admin, execution, paper-trading, observability, prisma]
---

# A limit and the display of that limit must be one function

Four defects found while making the admin console honest about the
paper-execution loop. Three share a shape worth naming: **a fact was recorded
correctly and displayed by a second implementation that had drifted.** Nothing
crashed, nothing logged, and every one of them read as a plausible number.

## 1. The open-position count (the reason for this note's title)

`maxOpenPositions` bounds what **this profile** holds. `PaperExecutionService`
gated on exactly that — walking the profile's own FILLED intents to their
instruments and asking the position table which were still non-zero.
`ExecutionQueryService.profiles()`, which renders the console's
`openPositions/maxOpenPositions` cell, counted **every non-zero position on the
account**.

On a dedicated machine account those are the same number, which is why it
survived review: the only positions there are the profile's own. Bind a profile
to a real person's account — which
[[Decisions/2026-08-18 - Sentinel paper execution bound to real TradeW user accounts]]
exists to do — and they diverge. A trader holding two positions of their own
made their agent display `2/1`: **visibly over a limit it was nowhere near**,
while the gate that actually decides was looking at 0 and letting every pass
through.

The failure mode is not the wrong number. It is that the wrong number points an
operator at the wrong action: disarm a working profile, or go hunting for a
stuck position that does not exist. **A limit and its own display disagreeing is
worse than either being wrong alone**, because the console is where someone goes
to find out why the loop did what it did.

Fixed by deleting one of the two implementations, not by correcting it:
`execution-open-positions.ts` is now the only place that counts, and both
callers call it. The comment in that file is the argument; the spec beside it is
the fence.

## 2. A refusal written for a human cannot be counted

`ExecutionIntent.rejectReason` interpolates live numbers — *"Realized
-₹110,987.50 today, at or past the -₹25,000 floor"*. Perfect for someone reading
one intent. Useless in aggregate: **no two rows are the same string**, so
`GROUP BY rejectReason` returns the list you started with, sorted differently.

That is why answering "why did nothing trade today?" on 2026-08-18 meant opening
rejections one at a time, and why
[[Gotchas/2026-08-18 - Paper orders invisible in Admin_Web is usually no order, not a read bug]]
records a day spent auditing a read path that was clean the whole time. The
reason was sitting on forty-odd intents, one click apart.

A refusal now gets stored twice, deliberately: the sentence for reading, and
`rejectCheckId` — the failing gate's id — for counting. Both come out of one
`evaluatePolicy` call, and one map in `execution-policy.ts` supplies both a live
check's label and a stored refusal's, so renaming a check cannot leave an
unlabelled bar on the console.

**If a value is written for a person to read, it is not a value you can group
by. Store the key as well as the sentence, at the moment you have both.**

## 3. A unique FK is a fact about one direction only

`Order.executionIntentId` is `@unique` because one intent submits exactly one
order — that constraint IS the idempotency guarantee at the order layer. So the
loop's **square-off** could not use it, and carried no intent link at all.

Consequence: `orders?source=sentinel` matched entries and no exits. The agent
appeared to open positions it never closed, its exits were filed as a human's
orders, and the one order class whose provenance is least obvious from the row
was the class with no trace behind it. The filter was not broken; it was
answering a narrower question than its name implied.

`Order.exitOfIntentId` is the second link — nullable, and deliberately **not**
unique: a position can be flattened by more than one order when an exit fails
and the next reconcile tick retries it, and a unique constraint would turn an
ordinary retry into a crash.

## 4. "Enabled" in the database cannot answer "running" in the process

The console counted `ExecutionProfile.enabled` and labelled it *"may place paper
orders"*. Whether anything ticks is `PAPER_EXECUTION_ENABLED` plus a leader
lease — **facts about a process, invisible to any query**. An armed profile read
identically whether it was being evaluated every minute or had never been looked
at, and the only hint was a footnote in small print under the table.

`GET /admin/execution/status` reports the process's own live state. Note what it
is not: a status row in a table would be a second copy of a fact the process
already holds, and it would keep asserting "running" after that process had
gone.

## And one that only a from-scratch migration reveals

CI's drift job compares a database built by replaying every migration against
`schema.prisma`. It had been reporting a diff on `Order.updatedAt` (a database
`DEFAULT CURRENT_TIMESTAMP` that the schema never declared, added
2026-07-22) — on `main` as much as on any branch. Reproduced locally by applying
main's migrations to an empty Postgres: identical output with none of this
work's changes present. Corrected in the migration that next touched the table.

Worth knowing because a job that has been red for weeks stops being read, and
the next real drift lands in a log nobody checks.

Related: [[Decisions/2026-08-18 - Sentinel paper execution loop (execution capability, not a second Sentinel)]].
