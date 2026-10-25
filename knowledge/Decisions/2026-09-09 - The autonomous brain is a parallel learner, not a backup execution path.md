---
type: decision
date: 2026-09-09
tags: [decision, autonomous-engine, learning, journal, sentinel, schema]
---

# The autonomous brain is a parallel learner, not a backup execution path

**Read before touching `services/api/src/autonomous/*`, the `Autonomous*` tables,
or either autonomy flag.**

## The reframe

Phase 2 built a Sentinel-independent scanner and gated it on
`AUTONOMOUS_ENGINE_ENABLED`. That was the wrong shape. The brain is not a
standby execution path — it is a **second brain watching the same market**,
deciding independently, recording what it would have done, and learning from
what actually happened, while holding **no authority whatsoever**.

## The flag split, which is the load-bearing change

| flag | question | default |
|---|---|---|
| `AUTONOMOUS_OBSERVER_ENABLED` | may it watch, decide and journal? | off |
| `AUTONOMOUS_ENGINE_ENABLED` | may it place an order? | off — **nothing reads it** |

Conflating them meant **the only way to collect a decision dataset was to let
the brain trade**, which is exactly backwards. It must be able to be wrong ten
thousand times at no cost while the dataset that would let it stop being wrong
accumulates. `SetupScannerService` therefore has no enablement check at all:
scanning is an observation, and observations are free.

## Three tables, and why not one

```
AutonomousScan       what it SAW       (one row per bar per symbol)
AutonomousCandidate  what it DECIDED   (immutable)
AutonomousOutcome    what HAPPENED     (written later, never merged up)
```

The split is structural, not stylistic. **"Was the original reasoning correct?"
is only answerable if the original reasoning still says what it said before the
answer was known.** One wide table would make that a convention; two tables make
it a fact about the schema. The journal writes candidates with
`createMany({ skipDuplicates: true })` — never an upsert — and the resolver
writes only to `AutonomousOutcome`.

## Rows are keyed per BAR — and the defect that taught us the second half

The observer polls faster than the timeframe it decides on, so per-poll writing
would inflate the dataset thirtyfold with duplicates and bias every aggregate
toward whichever setups persisted longest.

The first key was `(symbol, setupId, timeframe, signalBarAt)`. **It lost
information, and live traffic proved it within minutes**: `buildSnapshot`
overrides `lastPrice` with the venue's live ticker, so a rule reading it can
genuinely flip inside one bar. The observer logged "brain accepted 1 candidate"
while the table held **zero** accepted rows — the first poll's refusal had
claimed the key and the later acceptance was dropped as a duplicate
(BTCUSDT/`agent-ema-cross`, refused 19:45, accepted 20:07).

Fixed by adding `accepted` to the key: **at most one refusal and one acceptance
per setup per bar.** Two rows captures the transition — a setup that only
validates late in a bar is one whose entry timing matters — without reopening
the duplication.

## DECIDED: the brain decides on CLOSED BARS ONLY

The defect above forced the question, and it is now an explicit architectural
decision rather than an accident of which price happened to be in the snapshot.

`SetupScannerService.buildSnapshot` overrides `lastPrice` with the close of the
last CLOSED bar. `composeSnapshot` sets it from the forming bar and an earlier
version went further and substituted the venue's live ticker — both make the
decision depend on WHEN the poll landed, because nine rules and the whole level
layer read `lastPrice`.

**The deciding argument is backtest parity, not elegance.** A live ticker DOES
NOT EXIST in historical data. A brain that decides on one can never be replayed:
the backtester would evaluate closed bars while the live engine evaluated
intra-bar prices, and every divergence between them would be unattributable.
"Backtest and live call the same core" is only true if the core is handed the
same KIND of input in both — which makes this the same class of mistake as
having two strategy implementations, just better hidden.

So: one bar, one market state, one answer, reproducible forever from the
journalled feature vector. Asserted by a test that feeds a ticker 50% away from
the bar and requires the entry to ignore it.

The live ticker is **not discarded** — it remains the freshness signal
(`lastDataAt` → `dataAgeSeconds`), which answers "is this feed alive?" That is a
different question from "what is the market state?", and conflating the two is
what produced the non-determinism. Same distinction the 2026-08-17 incident
turned on.

The two-row `accepted` key is kept as defence in depth: it costs nothing, and it
means a future change that reintroduces intra-bar variation degrades the dataset
rather than silently corrupting it.

**Known modelling assumption, stated rather than hidden:** the shadow outcome
measures R from the PLANNED entry (the signal bar's close) while walking from
the next bar. The backtester enters at the next bar's OPEN, so a gap between the
two is unmodelled — mildly optimistic on gappy instruments. Recording a realised
entry needs a column on `AutonomousOutcome`; worth doing next time that table
changes.

## Sentinel as benchmark, never as authority

`SentinelBenchmarkService` reads `ExecutionEvaluationLog` — a table the existing
loop already writes — **after** the brain has journalled its decision, and
records `agreement` as one of `both-acted` / `both-waited` / `autonomous-only` /
`sentinel-only` / `sentinel-silent`.

It does not call Sentinel, import from `services/sentinel`, or construct a
client. With Sentinel off the query returns nothing and the brain is unaffected.
**The rule that must never break: a benchmark value must never become an input
to a decision** — the moment the brain reads `sentinelConfidence` before
deciding it has become a filter on Sentinel rather than an independent brain.
That is why `attach()` takes a scan id rather than a snapshot and returns void.

First live run already produced a finding: NIFTY paired `both-waited`, while
BTCUSDT, GOLD and BANKNIFTY were `sentinel-silent` — Sentinel is not watching
them at all.

## Outcomes are pessimistic, and refusals are resolved too

The walk reuses `execution-simulator.ts`'s conclusions rather than restating
them: a bar spanning both levels is a **STOP**, and a gap through the stop fills
at the **open**. Entry is never taken on the signal bar itself (look-ahead —
the decision came from that bar's close). Costs are deliberately NOT modelled: a
shadow outcome measures whether the LEVELS were right, and charging costs
against a trade that was never placed would blend two questions.

**Refused candidates are resolved as well, and it is the most valuable column in
the table.** A refusal for `risk-below-noise-floor` whose levels would have paid
3R is evidence the floor is too high; one that would have been stopped is
evidence it earns its place. `brain-report.ts` prints exactly that verdict.

`wouldHaveHitTarget` separates "the thesis was wrong" from "the stop was too
tight" — a question neither the entry nor the exit can answer alone.

## Learning proposes nothing yet, deliberately

`brain:report` is read-only. The existing evidence-gated `learning-cycle.ts`
already establishes that improvements must come from accumulated history, be
risk-neutral-or-reducing, survive a chronological holdout, and be promoted by an
operator. Nothing here shortcuts it. Aggregates under n=20 are labelled
indicative rather than printed as results.

## Operational trap this phase hit twice

A schema change makes `predev:api`'s `build:if-stale` regenerate the Prisma
Client, which fails on Windows with **EPERM** because every running service
memory-maps `query_engine-windows.dll.node` — and that **blocks the API from
booting at all**. Stopping the services was not enough; the handle survived.
**The fix that works: delete the DLL, then `npm run build -w @tradew/database`**
— generate recreates it, and with no file to rename over there is nothing to
lock. See [[Gotchas/2026-09-09 - Every index read 0.00 because the feed reset its own backoff]]
for the other Windows-lock papercut in the same session.

Related: [[Decisions/2026-09-08 - Autonomous decision core extracted to strategy-core (Sentinel no longer authorises trades)]],
[[Patterns/2026-09-09 - Autonomous scanner and the market-data port]].
