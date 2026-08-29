# The index is the market instrument — a watch is THREE instruments, not a pair

**Read before touching `app/watch/poller.py`, `app/watch/direction.py`,
`WatchCreator`, `StrikeCombobox`, or anything that reads
`WatchObservation.metadata`.** Related:
[[2026-08-18 - The watch is an option PAIR (a strike number is not an instrument)]]
— this **widens** that node rather than replacing it: both legs still travel,
both are still addressed by token, and "a CE control must never select a PE
instrument" is still guarded three times. What that node got wrong is narrower
and stated below. Also
[[2026-08-16 - Selecting a market starts the watch (three charts read, trading days only)]]
(where "naming which leg MOVED is a description, ranking a ladder is a
recommendation" was established — the distinction this node leans on).

## What was wrong

Two things, and the screen hid both.

**1. The engine never read the index.** `fetch_index_candles` was reachable
from exactly one branch of `_candles_for`: a watch with *no legs at all*. So an
option watch read its focused leg (to evaluate rules on) and both legs (for the
observation record), and never once looked at the underlying. The workspace drew
three charts, `WatchSession` stored three instruments, and the sweep read two.

**2. So whatever directional sense the engine had came out of a premium
series.** That is the one series that cannot answer the question. A call premium
can fall on a rising index — IV collapsing faster than delta pays, or theta into
the afternoon — and BOTH legs can rise together when volatility is being bid
ahead of an event. A premium series answers *"what did this contract do"*. Only
the underlying answers *"which way is the market going"*.

The UI made the same claim as the code. Two large CE/PE cards sat under a
heading called **"Option pair under observation"**, below the market dropdown,
which reads as *pick your contracts; the index is a setting above them*.

## The shape now

```
WATCH  [ NIFTY Nifty 50 ▾ ]  [ 24200 CE ▾ ]  [ 24200 PE ▾ ]
```

Three dropdowns of one kind, in one row, because they are three instruments of
one watch. `MarketSelector` was already this control; `StrikeCombobox` was
**reshaped into it** rather than replaced, so its 16 tests and all three
cross-side guards carried over untouched.

| Instrument | Role | Read by |
|---|---|---|
| Index | **Market instrument** — the only series direction comes from | `_read_index` |
| CE | Tradable leg | `_read_pair`; `_candles_for` when in focus |
| PE | Tradable leg | `_read_pair`; `_candles_for` when in focus |

`app/watch/direction.py` is pure and takes candles: rising index → **CE** is the
aligned leg, falling → **PE**, inside the 0.05% flat band → **neither**, and
unreadable → **neither**. Flat and unreadable are *not* defaulted to CE; a
default would assert an alignment the tape did not show, on the reading that is
weakest. It is written onto every observation as `metadata.marketContext`, with
`basis: "index"` stated outright so no later reader can mistake it for a reading
of a premium series.

## The half that is easy to get wrong

The 2026-08-18 node ends with *"Rule 2: the pair is recorded, never ranked — no
'bullish → CE' shortcut anywhere."* **That conflated two different claims**, and
only one of them is forbidden:

- **ALIGNED** — "the index rose, and the call is the leg whose direction agrees
  with a rising index." Arithmetic on one series, past tense. A description of
  the tape.
- **PREFERRED** — "the call is the better trade." A ranking, and a
  recommendation however it is worded.

Only the second is off-limits (Rule 2 / ARCH-4). Nothing in `direction.py` reads
premium, liquidity or volatility, nothing compares one strike with another, and
`alignedSide` never reaches a notification — `app/notify/compliance.py` rejects
a `side`/`bias` key in a notification payload outright, and
`tests/test_direction.py` asserts that boundary rather than assuming it. The
alignment lives on the **observation record**, where the evidence sits beside
it.

## Side in focus, restated

It is **the user's preferred trade side within a three-instrument watch**, and
that is all it has ever been able to be since 2026-08-18. It selects which leg
the rule set is evaluated against. It is **not a subscription**: both contracts
are read whichever way it is set, `_validate_pair` refuses a half-configured
pair, and — the new part — the index is read, and read *identically*, either
way. A direction that moved with the toggle would be a reading of the operator
rather than of the tape, and there is a test named for exactly that.

## Cost

**One extra bridge call per option watch per sweep.** `_read_index` mirrors
`_candles_for`'s index branch condition-for-condition, so an underlying watch
(and a degenerate option row with no expiry) **reuses** the series already
fetched rather than doubling it — the watches that were reading the index
correctly all along pay nothing. Index failures are swallowed and *named*: a
dead index costs the directional context and nothing else, and must never skip
a sweep whose legs read fine.

## What was verified

- `services/sentinel-py`: **330 passed** (26 new in `tests/test_direction.py`),
  up from 304. Covers the mapping, the flat band, the compliance boundary, the
  legacy single-leg row, the no-double-fetch guard, and a full `sweep_once`
  asserting the observation carries `marketContext.basis == "index"`.
- `apps/web`: **656 passed** (15 new in `threeInstrumentWatch.test.tsx`), up
  from 641; `tsc --noEmit` clean; `next lint` clean on the changed files.
- ⚠️ **Not driven in a browser and not run against a live chain** — same
  limitation as the 2026-08-18 node, and for the same reason (Postgres + api +
  sentinel-py + a Dhan bridge on a 24h token, and chain reads only return during
  market hours). What is asserted is the arithmetic, the request/persistence
  contracts, and the rendered resting state.
- ⚠️ `marketContext` is **written and not yet read** by any surface —
  deliberately, like `optionPair` before it. Nothing in the timeline, the feed
  or the admin portal renders it. Surfacing it is a separate change with its own
  vocabulary review, and doing it here would have meant redesigning parts of the
  Market Watch page the brief said not to touch.
