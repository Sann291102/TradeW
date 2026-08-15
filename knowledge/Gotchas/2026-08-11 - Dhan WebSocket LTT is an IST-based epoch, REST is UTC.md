---
type: gotcha
date: 2026-08-11
tags: [gotcha, dhan, market-data, timezone, websocket, parser]
status: resolved
---

# Dhan's WebSocket LTT is an IST-based epoch — its REST timestamps are not

**Dhan's two market-data surfaces use different epoch conventions, and the docs label both
just "EPOCH".** Anything that shares one conversion helper between them is wrong for one of
them.

| Surface | Field | Convention | Correct decode |
|---|---|---|---|
| WebSocket binary feed | LTT (Ticker/Quote/Full) | Seconds counted as though **IST wall clock were UTC** | `new Date(s*1000 - 5h30m)` |
| REST `/v2/charts/historical`, `/intraday` | `timestamp[]` | Genuine **UTC** epoch seconds | `new Date(s*1000)` |

The REST half was already verified in
[[Patterns/2026-07-23 - Candle table + Dhan backfill (Sentinel on real data)]] — "09:15 IST
open lands at `03:45:00Z`". The WS half was assumed to match it, and did not.

## The bug

`packages/market-data/src/providers/dhan/dhan-binary-parser.ts` decoded LTT as a UTC epoch,
so **every tick carrying a real trade time was stamped 5h30m in the future**. Called from
the TICKER, QUOTE and FULL branches. PREV_CLOSE and OI packets were unaffected because they
take the `now` fallback instead — which is why only *some* rows looked wrong, and why
indices (LTT=0 → fallback) looked perfectly healthy while commodities did not.

## How it was confirmed — the docs cannot settle this, the session boundary can

DhanHQ's v2 "Live Market Feed" page says only "Last Trade Time (EPOCH)". No mention of UTC,
IST or timezone anywhere. **Do not expect the docs to answer this.**

What settles it is that a session close is a known instant. Measured against the running
live-feed bridge on `:4600`:

- GOLD's final tick decoded to `23:29:59Z`. As UTC that is 04:59:59 IST — hours after MCX
  shuts. As IST it is 23:29:59, exactly the 23:30 IST close. Only one reading is possible.
- NSE rows land on their own close the same way (`360ONE` → `15:59:51Z`); past-dated, so
  they never *looked* wrong. The commodities exposed it only because MCX's later session
  pushed the same offset past wall clock into the visibly-absurd future.

**The official `DhanHQ-py` client agrees, in a way that hides the problem.** It does
`datetime.fromtimestamp(epoch, timezone.utc).strftime('%H:%M:%S')` — no IST offset applied —
and then prints only `hh:mm:ss`. Formatting an IST-based epoch as UTC recovers the IST wall
clock, so the string reads correctly to an Indian user and the error never surfaces. It is
right about the digits and silent about the instant. Reading that code as "Dhan says UTC" is
the trap; it discards the date and the offset, so it never makes a claim about the instant
at all.

## Why a fixed offset is the right fix here

IST is UTC+05:30 with **no daylight saving, ever**. A constant is genuinely correct, unlike
most zones where it would be a bug waiting for a DST boundary. Worth stating in the code,
because "hardcoded offset" otherwise reads as a smell to the next reviewer.

## Blast radius (smaller than it looks — check before assuming)

- The only consumer of `MarketTick.at` is `live-feed-server.ts`'s `updatedAt` JSON field.
- **No persisted data was affected.** `Quote.updatedAt` is Prisma `@updatedAt` (DB wall
  clock) and `TickPipelineService.toQuoteData` never writes `tick.at`. **No backfill was
  needed** — verify this the same way before assuming a timezone bug reached the database.
- No staleness guard compared it to `Date.now()`, so nothing was defeated *yet*. That was
  luck, not design: a future-stamped quote defeats an "is this stale?" check completely,
  because it is always newer than now.

## The test that encoded the bug

`packages/market-data/scripts/verify-parser.ts` asserted the epoch round-tripped *unchanged*
— a round-trip test cannot see a convention error, because it re-applies the same wrong
assumption on both sides. Now updated, with a regression guard written as the **invariant**
rather than the arithmetic: the raw epoch rendered as a UTC wall clock must equal the decoded
instant rendered as an IST wall clock. Asserting `- 19800` instead would pass under either
implementation and guard nothing. Verified to fail against the old code before being kept.

## Related

- [[Patterns/2026-07-23 - Candle table + Dhan backfill (Sentinel on real data)]] — the REST/UTC half
- [[Patterns/2026-07-21 - Market data Phase 1 (ingestion runtime, pure reads)]] — parser's role
- [[Patterns/2026-08-03 - Test infrastructure pass (runners made discoverable, money math covered)]] — `npm run verify` reachability
