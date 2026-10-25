---
type: pattern
date: 2026-09-09
tags: [pattern, autonomous-engine, strategy-core, market-data, api]
---

# Autonomous scanner and the market-data port

**Read before adding a market to the autonomous engine, or before putting any
`if (market === …)` into a decision path.**

Phase 2 of the autonomous-engine work. The bot now finds its own setups on
India, BTC and Gold, through one decision core, with Sentinel absent.

## The one thing allowed to differ per market

`services/api/src/autonomous/market-data.port.ts`. Everything above it reads a
`MarketSnapshot` and cannot tell which source produced it:

| Market | Source | Why |
|---|---|---|
| INDIA, GOLD | `DhanBridgeSource` (`:4600`) | Same transport, same two endpoints. They differ in session hours and in how a signal is *expressed* — neither is this file's business. |
| CRYPTO | `BinanceSource` | The bridge has no Binance integration at all: `GET :4600/candles?symbol=BTCUSDT` returns `{"candles":[],"source":"none"}`. The working client is `@tradew/market-data`'s `binance.client`. |

A `if (market === 'CRYPTO')` inside the scanner is the thing to avoid: it
starts as a data detail and, one bug fix at a time, becomes a second decision
path — which is the split `strategy-core` was created to close.

## Absence and fault must not share a representation

`MarketDataUnavailable` means **we could not find out**. An empty `candles`
array on a *successful* read means the venue genuinely has no history. The
scanner reports these differently (`data-unavailable` vs `scanned` with zero
candidates), because the first is an outage and the second is a market to skip.

This is the 2026-08-17 failure restated as a type. The bridge's own trap is
live: it answers **HTTP 200 with `source: "error"`** when Dhan refuses it, so a
source that reads `body.candles` and stops will report a dead credential as a
quiet market. `DhanBridgeSource` checks `source === 'error'` first.

## Two defects this phase found against the running system

**Quotes are bucketed by asset class.** `/quotes` returns `indices`, `stocks`,
`etfs`, `commodities` — and a source reading only `indices` gets `null` for
GOLD, which is **indistinguishable from "the bridge has no quote"**. Gold ran
with no freshness signal at all until this was found. Fixed by searching every
array-valued key, so a bucket added later cannot do it again.

**The candle parameter is `interval`, not `timeframe`.** An unrecognised
parameter is silently ignored and you are served the 5m default — which looks
exactly like "every timeframe returns the same bars".

## Venue clocks, not one calendar

`isVenueOpen(spec.venue, now)` and `venueMinuteOfDay` per instrument. Crypto
passes a **null** session minute, so a setup's `idealSession` window simply does
not apply — a window like `09:30-12:00` is a claim about a session, and a market
that has none must not have its setups refused for being outside one.

## How "off" is guaranteed

Three independent things must change before this code can affect an order:

1. `AUTONOMOUS_ENGINE_ENABLED` must be exactly `'true'` (absent = off, and
   `'1'`/`'yes'`/`'TRUE'` are all off — asserted).
2. `AutonomousModule` is **not registered in any Nest module**. It is reachable
   only from `verify:autonomous-scan`.
3. The scanner has no order path at all in this phase.

The flag is read **per scan**, not at construction, so turning it off does not
need an API restart.

## Sentinel independence is structural, not conventional

`setup-scanner.spec.ts` reads every `.ts` in the module and asserts no import
path matches `/sentinel/i`. A behavioural test would pass while someone
gradually reintroduced the dependency; this cannot.

## Proof (2026-09-09 14:06 IST, live)

`npm run verify:autonomous-scan -w @tradew/api` — **3/3 markets reached the
shared decision layer**, with a real structurally-derived plan on BTC:

```
CRYPTO BTCUSDT  ACCEPTED  EMA Cross Continuation
  entry 79701.79  stop 79353.25  target 80747.41
  (risk 348.54 = 1.86 ATR, reward 1045.62, 3R)
  anchor: Signal bar low at 79400
```

and refusals that name their numbers — `risk-exceeds-volatility-budget:
Risk 976.54 is 5.22 ATR, over the 2.5 ceiling`, and
`setup-not-validated: The bullish order block at 79182.6–79292.0 is unmitigated`.

NIFTY and GOLD accepted nothing, which is the designed resting state.

Related: [[Decisions/2026-09-08 - Autonomous decision core extracted to strategy-core (Sentinel no longer authorises trades)]],
[[Gotchas/2026-09-09 - Every index read 0.00 because the feed reset its own backoff]].
