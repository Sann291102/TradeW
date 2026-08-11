---
type: pattern
date: 2026-08-12
tags: [pattern, sentinel, notifications, safety, rule-2, events]
status: implemented
---

# Sentinel event contract — notifications consume a gated event, never the response

**Read before adding any delivery channel (email, push, SMS) for Sentinel, and
before adding a field to `SentinelEvent`.** Phases 1–2 of the notification
program: Sentinel observations now persist as durable notifications instead of
existing only for as long as a browser tab is open.

## The shape

```
Orchestrator → publication gate → deriveSentinelEvents() → ObserveResponse.events
                                                                 ↓
                                        SentinelEventDispatcher (services/api)
                                                                 ↓
                                                    Notification row (durable)
```

Events are derived in `services/sentinel/src/events/sentinel-event.ts`, at the
point where the four-condition gate's decision is authoritative, and travel on
the new `ObserveResponse.events` field. `services/api` forwards new response
fields for free (`return res.json()`), the same property
[[2026-08-06 - Sentinel publication gate (four conditions, not one threshold)]]
records.

## Why a separate contract rather than notifying from `ObserveResponse`

`ObserveResponse` is a **dashboard** payload — it carries `sideInFocus`,
`optionContext`, strategy lifecycles and the full publication record because a
trader looking at the workspace gets all of it *in context*. A notification has
no context: it arrives on a lock screen or in a mail client, stripped of the
page that explains it. Handing the raw response to a dispatcher and letting
each channel decide what to say is exactly how a directional field ends up in a
push notification.

So the gate produces events, and **the events are what travels**.

## The safety property, and why it is structural

`SentinelEvent` has no `side`, no `bias`, no `strike`, no `direction` — and
`deriveSentinelEvents` is never *handed* one. `sideInFocus` is in scope at the
call site in the orchestrator and is deliberately not passed. This is the
direct lesson of
[[Gotchas/2026-08-11 - Sentinel feed fabricated a CE direction on signals that had none]]:
all four defects there were a *derivation* recovering a side from something
that never carried one. **A field that does not exist cannot be defaulted to
CE.**

The rule is asserted at both ends, on purpose:

- `sentinel-event.spec.ts` — the emitted event carries no directional field
  even when the synthesis prose is unambiguously bullish.
- `sentinel-event-dispatcher.spec.ts` — a rogue `side`/`strike` arriving over
  HTTP still cannot reach a row, because `toNotification` names every field
  explicitly and never spreads the incoming object.

Both were confirmed to **fail when violated** before being claimed (a `side`
field was temporarily added to the emitter; the guard failed as intended, then
was reverted). The gotcha note records a documented rule silently reverting
while its explanatory comment sat intact above the reverted body — a comment is
not a gate, and a test that passes both ways guards nothing.

What an event says instead is that Sentinel's state changed and why, and that
the workspace holds a read worth looking at. The gated detail stays on the page
where the evidence sits beside it.

## Dedupe: one vocabulary, two windows

`SentinelEvent.dedupeKey` deliberately shares its vocabulary with
`MarketTimelineEngine`'s (`guidance:…`, `risk:…`, `state:…`) — the timeline and
the notification feed are two renderings of one session, and two schemes would
let a repeat be a duplicate on the narrative and a fresh event in the inbox.

The **windows** differ and must:

| Surface | Window | Why |
|---|---|---|
| Timeline | in-memory, recent entries | narrative is rebuilt per request |
| Notifications | durable, per user + IST trading day | a row a user comes back to; must survive restarts and hold across replicas |

An in-memory set would re-notify everyone on every deploy.

Two dedupe details worth keeping:

- **Emotional risk is banded, not thresholded.** A raw `score >= 65` re-fires
  every poll while the score jitters across the line. The key is
  `emotion:${floor(score/10)*10}`, so the next notification requires a genuine
  10-point deterioration.
- **Batch-local dedupe is separate from the DB check.** The DB read happens
  before either row is written, so an observation emitting the same key twice
  would slip straight past it.

## What earns an interruption

`NOTIFIABLE_STATES` is deliberately **narrower** than the gate's
`GUIDANCE_STATES`: `WAIT_AND_WATCH` and the early analysis states are where
Sentinel spends most of a session, so notifying on them makes the channel a
heartbeat. A quiet wait-and-watch poll emits nothing — that is the intended
resting state, and it is pinned by a test.

Note the asymmetry the `risk-elevated` kind encodes: the composite-risk path
surfaces a synthesis **while the publication gate says no**. That is upstream
policy (a revenge-trading pattern matters whether or not a technical setup
confirmed), so the absence of `published` is the signal, not a bug.

## Prose is reused, never re-composed

For the kinds carrying a synthesized read, `body` is the synthesis content
verbatim — it has already been through the vocabulary enforcer. Composing fresh
prose in the event layer would route around it and give the notification
channel its own unreviewed voice. Same reasoning as
[[2026-08-03 - SentinelIntelligence (second reasoning engine, citation-grounded)]]'s
"enforce derived text, append reviewed constants after".

## Known limits (honest status)

- **Poll-driven only.** Events exist only when something calls `/observe`, and
  today the only caller is the user's own browser on a 45s poll. Notifications
  are now *durable* (survive refresh, unread state, cross-device readable) but
  are not yet *generated* while the tab is closed. The background per-user
  sweep is Phase 2b, and it is blocked on a real constraint:
  [[2026-08-04 - SentinelIntelligence continuous reasoning (the watch asks the questions)]]
  records that background runs deliberately carry **no trader position data**,
  so the personalized kinds (emotional-risk, composite risk) cannot be derived
  there without new plumbing.
- **Dedupe is read-then-write with no unique constraint.** Two concurrent polls
  from one user can both miss and insert. Deliberate trade: the failure mode is
  one extra row, and the fix — a `(userId, dedupeKey, tradingDate)` unique
  index — needs no change to the dispatcher.
- **Severity lives in `Notification.metadata`, not a column.** Avoids an enum
  migration; `NotificationCategory` still has no security type, see
  [[2026-08-11 - Transactional email + in-app notification wiring]].
- **Not browser-E2E'd against a live stack.** Verified by `tsc --noEmit` on
  both services plus 309 sentinel / 291 api unit tests. Deferred to the dev
  deployment, matching the note above.
- The `/sentinel/market-close/review` outcome scorecard is Phase 3 and is
  still unreached by any frontend caller.

## Related

- [[Gotchas/2026-08-11 - Sentinel feed fabricated a CE direction on signals that had none]]
- [[2026-08-06 - Sentinel publication gate (four conditions, not one threshold)]]
- [[2026-08-11 - Transactional email + in-app notification wiring]]
- [[2026-07-23 - Sentinel market selector + event-driven safety feed]] — the
  earlier frontend-only `pushworthy` flag this generalises into a backend contract
