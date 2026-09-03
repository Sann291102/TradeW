---
type: pattern
date: 2026-08-19
tags: [pattern, sentinel, market-data, options, state-management, frontend, backend]
status: implemented
---

# Canonical expiry resolution — one rule, both runtimes

## For future Claude
Read this before touching anything that decides *which option expiry* a surface is on — a dropdown, a chain request, a chart, a watch, a cache key, a Sentinel observation. There is exactly ONE function that answers that question and both runtimes import it. If you are about to write `expiries[0]`, a date filter, or anything resembling "next Tuesday", stop and use `resolveActiveExpiry` instead.

## The bug this closes
On 2026-08-19 the `/sentinel` watch creator rendered, in one frame:

- an expiry dropdown reading **25 Aug**
- an "Option Pair Under Observation" panel reading **"No live chain for NIFTY 18 Aug right now."**
- a validation line reading **"The 2026-08-18 contracts have expired. Choose a later expiry."**

Three surfaces, two expiries. The instinct is "the panel is stale". It was the opposite:

1. `WatchContext` restored `selection.expiry` from `localStorage` as `2026-08-18`.
2. Its settle effect was **write-once** — `prev.expiry === null ? … : prev` — so a restored value was never reconciled against the live list. The canonical expiry stayed on a dead contract for the whole session.
3. `useExpiries` filtered the list to live expiries, so `2026-08-18` had no `<option>`.
4. **A `<select>` whose `value` matches no `<option>` renders its FIRST option.** The dropdown displayed "25 Aug" while the application held 18 Aug. The control was not out of sync — it was lying, and the panel was the only honest thing on screen.

The write-once guard was protecting something real: an operator who picks a later series must not be dragged back to the front month on the next poll. But "has it been set?" cannot distinguish a deliberate choice from a stale one. The rule had to become **"is it still real?"**.

## The architecture
`packages/types/src/expiry.ts` — the single resolver, in `@tradew/types` because both `apps/web` and `packages/market-data`/`services/*` already depend on it.

```
Market API → normaliseExpiryList → liveExpiries(todayIso) → resolveActiveExpiry
          → canonical selectedExpiry → option-chain request → CE/PE → charts → Sentinel → watch
```

Key exports:
- `tradingDateIso(now?)` — the **IST** calendar date. See the timezone trap below.
- `normaliseExpiry` / `normaliseExpiryList` — ISO, ISO-datetime and day-first formats; round-trip validated so `2026-02-30` is rejected rather than silently rolled to 2 March.
- `liveExpiries(list, todayIso)` — `>= todayIso`, because contracts trade **through** their expiry day until 15:30 IST.
- `resolveActiveExpiry({symbol, availableExpiries, currentTime?, requestedExpiry?})` — two rules: **a valid request is always honoured** (manual selection survives), **an invalid one is always replaced** (never sent upstream). Reports `autoRolled` + `rollReason`.
- `isValidFutureExpiry(expiry, available, todayIso)` — the guard before any request.
- `describeExpiryResolution(r)` — one log line, identical in both runtimes so the two logs read side by side.

It **never computes** a date. NSE has moved NIFTY's expiry weekday twice in two years and shifts it around holidays; any derived date is wrong a few times a year and silently requests contracts that do not exist.

## Where it is wired
| Stage | File |
|---|---|
| expiry list + IST filter | `apps/web/src/lib/sentinel/useExpiries.ts` |
| rollover without refresh | `apps/web/src/lib/sentinel/useTradingDate.ts` |
| canonical reconciliation | `apps/web/src/lib/sentinel/WatchContext.tsx` |
| nearest-expiry wrapper | `apps/web/src/lib/sentinel/optionChain.ts` (`pickNearestExpiry`) |
| chain poll | `apps/web/src/lib/sentinel/useOptionChainStrikes.ts` |
| bridge routes | `services/market-data/scripts/live-feed-server.ts` |
| Sentinel engine | `services/sentinel/src/market-data/candle-market-data.provider.ts`, `intelligence/market-intelligence.service.ts` |

## Gotchas worth the reading time

**The `<select>` first-option lie.** A `value` with no matching `<option>` does not render blank — it renders option one. Any control bound to a filtered list must either guarantee the value is in the list or render an explicit placeholder. `WatchCreator` now does both.

**UTC is the wrong day for five and a half hours, every day.** `new Date().toISOString().slice(0, 10)` was used in four places to mean "today". It is the UTC date, so from 00:00–05:30 IST it is *yesterday* — and the pre-open session (09:00 IST = 03:30 UTC) sits inside that window daily. Use `tradingDateIso()`.

**Filter expired contracts on the way OUT of a cache, never on the way IN.** The bridge caches expiry lists for 5 minutes and Sentinel's provider for 15 (served far longer when the bridge is down). A list filtered at *store* time carries the date it was filtered on and keeps offering a dead series across the boundary. Store what the provider said; filter against *now* on every read. Both caches were fixed this way.

**Cache keys must name the RESOLVED expiry.** The bridge auto-rolls; if `cacheKey` were built from the requested expiry an auto-rolled response would be filed under the dead contract's name and served to the next caller asking for it. `qk.optionChain.chain(symbol, expiry)` already did this correctly on the web side.

**Date fixtures in a date-filtering suite are time bombs.** Three `candle-market-data.spec.ts` tests broke the moment expired contracts started being dropped, because their fixtures were literal dates that had since passed — they had asserted nothing since the day they were written. They now use `isoInDays(n)` offsets. `pickNearestExpiry`'s tests had the same defect.

**A removed fallback.** `pickNearestExpiry` used to end `future[0] ?? valid[valid.length - 1]` — with everything past it returned the most recent *past* expiry, so "nothing is live" and "this is live" were the same return value. It now returns `null`, and one test that pinned the old behaviour was changed with it.

## Related
- [[Patterns/2026-08-18 - One canonical watch state (the controls were wired to nothing)]] — the provider and `WatchSelection` this extends. That work made the expiry *canonical*; this made it *correct*. Note the shared lesson: both bugs were a control that appeared to work.
- [[Patterns/2026-08-18 - The watch is an option PAIR (a strike number is not an instrument)]] — why `selectExpiry` must drop both legs AND both tokens on a roll: 24200 of one series is a different contract from 24200 of the next.
- [[Gotchas/2026-08-17 - A boot-once credential plus fault-shaped-like-absence took Sentinel down]] — the sibling failure, and the rule this one inherits: **an absence is a fact about the world, a fault is a fact about us, and they must never share a representation.** Here the third thing is a *stale* value, which must not share a representation with a live one either.
- `ARCHITECTURE.md` — Sentinel is observation/education only; nothing here ranks or recommends a contract, it only decides which series exists.
