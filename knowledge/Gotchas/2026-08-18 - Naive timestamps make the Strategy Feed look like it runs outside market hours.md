---
type: gotcha
date: 2026-08-18
tags: [gotcha, timezone, sentinel-py, prisma, asyncpg, frontend]
---

# Naive timestamps make the Strategy Feed look like it runs outside market hours

**Symptom.** The Strategy Feed shows events at **06:39 am** and **07:04 am** —
hours before the 09:15 IST open. The feed is supposed to fire only inside the
session, so it reads as the sweep running at the wrong time, or the market clock
being broken.

Neither. Every timestamp was short by **exactly 5h30m**, the IST offset. The
07:04 am entry was a real event at **12:34 pm IST**, four minutes old.

## The chain

```
DB      2026-08-18 07:04:29.531        timestamp WITHOUT time zone — correct UTC
wire    "2026-08-18T07:04:29.531000"   .isoformat() on a naive value: NO offset
browser new Date(...)                  ECMAScript parses offset-less as LOCAL (IST)
                                       → instant moves back 5h30m
render  "07:04 am"                     should have been "12:34 pm"
```

Prisma maps `DateTime` to `timestamp WITHOUT time zone`, so asyncpg returns
**naive** datetimes. The write side already knew this — `_now`/`_naive` in the
stores strip tzinfo deliberately, because asyncpg *refuses* an aware datetime
for such a column. What was missing was the re-labelling on the way **out**.

## Why it survived review

Every part looks right in isolation:

- The column really does hold UTC.
- `_aware()` already existed in `strategy/store.py` and correctly re-labels rows
  — but only for **in-process comparison**, never for JSON.
- The frontend formatter was already correct:
  `toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })`. It was handed an
  instant that had already moved, so asking for IST politely returned the wrong
  IST.
- No error, no warning. A valid ISO string, a valid Date, a plausible time.

The tell is that **every** timestamp is off by the same amount, and that amount
equals the local UTC offset.

## Fix

`app/core/timefmt.py::iso_utc` — stamp UTC on naive, normalise aware, emit
`+00:00`. Applied at all five wire sites (`watch/store.py` ×4,
`strategy/store.py` ×2). Regression tests in `tests/test_store_datetimes.py`.

`iso_utc` **assumes** naive is UTC rather than converting it. Using
`.astimezone()` on a naive value interprets it in the *server's* local zone,
which moves the instant on any host not set to UTC — the same bug, reappearing
only in deployment.

## The rule

**A datetime crossing a process boundary carries its offset, or it is not a
datetime — it is a number that looks like one.** Naive is acceptable *only*
inside the layer that owns the column, and must be re-labelled at every exit:
once for comparison (`_aware`), once for serialisation (`iso_utc`).

## Related

Same family as
[[Gotchas/2026-08-11 - Dhan WebSocket LTT is an IST-based epoch, REST is UTC]] —
there two upstream surfaces disagreed about what "epoch" meant; here one
internal surface dropped the label entirely. Both produce confident, plausible,
wrong wall-clock times rather than an error.
