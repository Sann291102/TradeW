---
type: api
date: 2026-08-11
tags: [api, dhan, algo, strategies, execution, trading-engine]
source: https://dhanhq.co/docs/v2/
---

# Dhan Algo Strategies — what the API actually exposes

**Read before building anything that automates order placement against Dhan, and before
assuming a "strategy" can be fetched from Dhan.**

## The headline finding

**There is no DhanHQ endpoint that returns algo trading strategies.** This was the first
thing checked and it is worth stating plainly, because the product surface implies
otherwise: [algos.dhan.co](https://algos.dhan.co/) advertises ~79 live algos with names
like *Expiry Short Strangle*, *Single Kurtosis Straddle*, *SkewHunter* and *Index Sniper*.
Those are a **marketplace product, not an API resource**:

- They are authored by third-party providers (every strategy listed at the time of writing
  is managed by **STRATZY**), who must be **SEBI-registered** and whose algos must be
  **exchange-approved**.
- Discovery, subscription, funding and deployment all happen in Dhan's own UI. There is no
  documented `GET /strategies`, no subscribe endpoint, and no way to enumerate or deploy
  them programmatically.
- Their internal logic is not published. You cannot read a marketplace algo's rules through
  the API, only the marketing description.

So the honest translation of "fetch algo strategies from the Dhan API" is: **fetch the
vocabulary Dhan's API can express, and enumerate the strategies that vocabulary supports.**
That is what the rest of this note is.

**Reference implementation: `scripts/dhan_algo_strategies.py`** — every endpoint family
below, the 14-strategy catalog as composable builders, and a CLI
(`python scripts/dhan_algo_strategies.py list-strategies`). Stdlib only; the pinned
`dhanhq` 2.3.0rc1 SDK predates Conditional Triggers and does not cover them. Dry-run by
default, and leaving dry-run requires two independent switches.

## Three tiers, only two of them programmable

| Tier | What it is | API access |
|---|---|---|
| **1. Marketplace algos** (`algos.dhan.co`) | Pre-built, exchange-approved strategies from registered providers | ❌ none — UI only |
| **2. Conditional Trigger Orders** (`/v2/alerts/orders`) | Dhan-hosted rule engine: *condition → orders*, evaluated on Dhan's side | ✅ full CRUD |
| **3. Execution primitives** (`/v2/orders`, `/v2/super/orders`, `/v2/forever/orders`) | Order types you compose a strategy out of, with your own logic holding the loop | ✅ full CRUD |

Tier 2 is the only place a *strategy* lives server-side. Tier 3 is where every real algo
lives — the decision logic runs on your infrastructure and Dhan just executes.

---

## Tier 2 — Conditional Trigger Orders: the one native rule engine

`/v2/alerts/orders` is the closest thing DhanHQ has to "a strategy you upload". Shipped in
**Version 2.5 (Feb 09, 2026)**. A trigger is one *condition* plus an *array of orders* fired
when it is satisfied.

### Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/v2/alerts/orders` | Create a trigger |
| PUT | `/v2/alerts/orders/{alertId}` | Modify |
| DELETE | `/v2/alerts/orders/{alertId}` | Cancel |
| GET | `/v2/alerts/orders/{alertId}` | Read one |
| GET | `/v2/alerts/orders` | Read all |

`alertStatus`: `ACTIVE` | `TRIGGERED` | `CANCELLED` | `EXPIRED`.

### The hard constraint that shapes everything

> **Conditional Triggers are supported only for Equities and Indices** —
> `exchangeSegment` accepts `NSE_EQ`, `BSE_EQ`, `IDX_I` and nothing else.

**No F&O.** Every options and futures strategy — which is the entire premise of the
marketplace algos above, and of `services/trading-engine` — must be built in Tier 3, with
the rule loop running on our side. This single line is the reason a Dhan-hosted strategy
engine cannot be the foundation for TradeW's execution layer.

### The complete expressible vocabulary

This is the actual answer to "what strategies can you get from the Dhan API" — the
cross-product of these three lists is the entire native strategy space.

**`comparisonType`** (per Annexure, authoritative):
`TECHNICAL_WITH_VALUE` · `TECHNICAL_WITH_INDICATOR` · `TECHNICAL_WITH_CLOSE` · `PRICE_WITH_VALUE`

> ⚠️ The Conditional Trigger endpoint page lists `TECHNICAL_WITH_TECHNICAL` where the
> Annexure lists `TECHNICAL_WITH_INDICATOR`. The two pages disagree. Treat the Annexure as
> authoritative and verify against a live 400 response before shipping.

**`indicatorName`** — 21 values, fixed periods, no custom parameters:

| Family | Values |
|---|---|
| SMA | `SMA_5` `SMA_10` `SMA_20` `SMA_50` `SMA_100` `SMA_200` |
| EMA | `EMA_5` `EMA_10` `EMA_20` `EMA_50` `EMA_100` `EMA_200` |
| Bands | `BB_UPPER` `BB_LOWER` |
| Oscillators | `RSI_14` `STOCHASTIC` `STOCHRSI_14` |
| Volatility | `ATR_14` |
| MACD | `MACD_12` `MACD_26` `MACD_HIST` |

**`operator`** — 9 values:
`CROSSING_UP` · `CROSSING_DOWN` · `CROSSING_ANY_SIDE` · `GREATER_THAN` · `LESS_THAN` ·
`GREATER_THAN_EQUAL` · `LESS_THAN_EQUAL` · `EQUAL` · `NOT_EQUAL`

**`timeFrame`**: `DATE` (daily) · `ONE_MIN` · `FIVE_MIN` · `FIFTEEN_MIN`
**`frequency`**: `ONCE` — a trigger fires once and is done. There is no repeating trigger.
**`expDate`**: defaults to 1 year.

### Other condition fields

`securityId`, `comparingValue` (numeric threshold), `comparingIndicatorName` (for
indicator-vs-indicator), `userNote` (free text).

### The orders array

Each entry carries `transactionType` (`BUY`/`SELL`), `orderType`
(`LIMIT`/`MARKET`/`STOP_LOSS`/`STOP_LOSS_MARKET`), `productType`
(`CNC`/`INTRADAY`/`MARGIN`/`MTF`), `quantity`, `validity` (`DAY`/`IOC`), `price`,
`triggerPrice` (required for stop-loss types), `discQuantity` (min 30% of total).

**Multiple orders can fire from one condition** — that is what makes it a strategy rather
than an alert. A single trigger can enter a position and arm its exits in one shot.

### Strategies this vocabulary can actually express

Everything below is buildable today with one POST, no polling, no infrastructure:

| Strategy | Condition | Note |
|---|---|---|
| **Golden / Death Cross** | `TECHNICAL_WITH_INDICATOR`, `SMA_50` `CROSSING_UP`/`CROSSING_DOWN` `SMA_200`, `timeFrame: DATE` | The textbook long-term trend flip |
| **EMA crossover trend entry** | `EMA_20` `CROSSING_UP` `EMA_50` | Directly comparable to `backtest-ema-cross.ts` — see below |
| **Price/MA reclaim** | `TECHNICAL_WITH_CLOSE`, close `CROSSING_UP` `EMA_200` | Classic regime filter |
| **RSI oversold reversal** | `TECHNICAL_WITH_VALUE`, `RSI_14` `CROSSING_UP` `30` | Mean reversion entry |
| **RSI overbought exit** | `RSI_14` `CROSSING_DOWN` `70` | Pairs with the above |
| **Bollinger breakout** | close `CROSSING_UP` `BB_UPPER` | Volatility expansion |
| **Bollinger mean reversion** | close `CROSSING_DOWN` `BB_LOWER` | Band fade |
| **MACD signal-line cross** | `MACD_12` `CROSSING_UP` `MACD_26`, or `MACD_HIST` `CROSSING_UP` `0` | Momentum turn |
| **Stochastic / StochRSI turn** | `STOCHRSI_14` `CROSSING_UP` `20` | Faster oscillator variant |
| **Volatility-gated entry** | `ATR_14` `GREATER_THAN` <value> | Only the *gate* — see limitation below |
| **Breakout above level** | `PRICE_WITH_VALUE`, price `CROSSING_UP` <level> | Manual S/R, ORB level, prior-day high |
| **Index-driven basket** | condition on `IDX_I`, orders on `NSE_EQ` names | The condition instrument and the order instrument need not match |

### What it structurally cannot express

These are hard walls, not gaps to work around:

- **One condition per trigger.** No `AND`/`OR`. "RSI < 30 **and** price > EMA_200" is not
  expressible — you get one comparison. ATR can gate nothing by itself for this reason.
- **`frequency: ONCE`.** No continuously-armed rule; every fire needs a fresh POST.
- **Fixed indicator periods.** No `EMA_9`, no `RSI_2`, no configurable Bollinger σ.
- **No F&O.** Equities and indices only.
- **No volume, OI, IV, or Greeks** in the condition vocabulary.
- **Coarsest intraday resolution is 1 minute**, finest timeframe set is 4 options.

Anything past those walls is Tier 3.

---

## Tier 3 — the execution primitives you compose algos from

### `/v2/orders` — the base order

| Method | Endpoint |
|---|---|
| POST | `/v2/orders` |
| PUT | `/v2/orders/{order-id}` |
| DELETE | `/v2/orders/{order-id}` |
| POST | `/v2/orders/slicing` |
| GET | `/v2/orders` · `/v2/orders/{order-id}` · `/v2/orders/external/{correlation-id}` |
| GET | `/v2/trades` · `/v2/trades/{order-id}` |

- `productType`: `CNC` `INTRADAY` `MARGIN` `MTF` `CO` `BO`
- `orderType`: `LIMIT` `MARKET` `STOP_LOSS` `STOP_LOSS_MARKET`
- `validity`: `DAY` `IOC`
- `amoTime`: `PRE_OPEN` `OPEN` `OPEN_30` `OPEN_60` — after-market scheduling, useful for
  gap-open strategies without an always-on process
- `boProfitValue` / `boStopLossValue` for bracket orders
- **`correlationId`** (max 30 chars) — your own idempotency/tracing handle, echoed back and
  queryable via `/orders/external/{correlation-id}`. Use it to tie a fill to the strategy
  instance that caused it.
- **`/orders/slicing`** splits an order that exceeds the exchange freeze limit into legs.
  Non-optional for any index-options algo trading meaningful size.
- **`algoId`** appears in order book responses, documented as *"Exchange Algo ID for Dhan"*.
  It is a **read-only attribution field stamped by Dhan**, not a strategy identifier you
  supply, and not a way to register your own algo.

### `/v2/super/orders` — entry + target + stop + trailing, in one call

The single most useful primitive for an algo, because the exit management runs on Dhan's
side after your process has moved on.

| Method | Endpoint |
|---|---|
| POST | `/v2/super/orders` |
| PUT | `/v2/super/orders/{order-id}` |
| DELETE | `/v2/super/orders/{order-id}/{order-leg}` |
| GET | `/v2/super/orders` |

Required on create: `transactionType`, `exchangeSegment`, `productType`
(`CNC`/`INTRADAY`/`MARGIN`/`MTF`), `orderType` (**`LIMIT` or `MARKET` only**), `securityId`,
`quantity`, `price`, `targetPrice`, `stopLossPrice`, `trailingJump`.

Legs: `ENTRY_LEG` · `TARGET_LEG` · `STOP_LOSS_LEG`.

Rules that bite:
- Entry leg is modifiable only while `PENDING` or `PART_TRADED`. Once `TRADED`, only target
  price, stop-loss price and trailing jump remain modifiable.
- **`trailingJump: 0` cancels the trail.** Omitting it is not "leave it alone" — a
  round-trip modify that drops the field silently disarms trailing.
- Cancelling the parent cancels all legs; a cancelled leg cannot be re-added.
- `orderStatus: CLOSED` means entry **and** one exit filled the full quantity;
  `TRIGGERED` tells you which exit fired.

### `/v2/forever/orders` — GTT / OCO

"Good Till Triggered." `orderFlag` is `SINGLE` or `OCO`; OCO carries a second leg via
`price1` / `triggerPrice1` / `quantity1`. `productType` is **`CNC` or `MTF` only** — no
intraday. Segments: `NSE_EQ` `NSE_FNO` `BSE_EQ` `MCX_COMM`.

This is the swing/positional primitive: arm a level today, let it sit for weeks with no
process running.

### Mapping archetype → primitive

| Strategy archetype | Right primitive |
|---|---|
| Intraday scalp / momentum with fixed R:R | Super Order |
| Trailing-stop trend follow | Super Order + `trailingJump` |
| Positional breakout, no daemon running | Forever Order (`SINGLE`) |
| Swing entry with target + stop, weeks out | Forever Order (`OCO`) |
| Indicator-driven equity/index entry | Conditional Trigger |
| Options spreads, straddles, strangles | `/v2/orders` (+ `/orders/slicing`), own logic |
| Gap-open reaction | `/v2/orders` with `afterMarketOrder` + `amoTime` |

---

## The risk layer — Trader's Control

Not optional for an unattended algo.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/v2/killswitch?killSwitchStatus=ACTIVATE\|DEACTIVATE` | Disable trading for the day |
| GET | `/v2/killswitch` | Read state |
| POST | `/v2/pnlExit` | Auto-exit on P&L thresholds |
| GET | `/v2/pnlExit` | Read config |
| DELETE | `/v2/pnlExit` | Disable |

`pnlExit` fields: `profitValue`, `lossValue`, `productType` (array of `INTRADAY` /
`DELIVERY`), `enableKillSwitch` (bool). Status: `ACTIVE` | `INACTIVE` | `DISABLED`.

**This is a broker-side circuit breaker that survives our process dying** — the thing an
in-app risk check cannot give you. Arm it before any live-capital run.

Kill switch requires all positions closed and no pending orders before it will activate.

> ⚠️ The **v2.5 release notes claim an "Exit All API"** for closing all positions at once,
> but no such endpoint appears on the Trader's Control page. **Unverified — confirm against
> a live account before designing a flatten-everything path around it.**

---

## Data for building and backtesting strategies

`POST /v2/charts/historical` (daily) and `POST /v2/charts/intraday`.

- Request: `securityId`, `exchangeSegment`, `instrument`, `fromDate`, `toDate`
  (**non-inclusive**), optional `expiryCode` (derivatives) and `oi` (bool).
- **Intraday `interval`: `1`, `5`, `15`, `25`, `60` minutes only.** No 3m, no 30m, no 4h.
- Response is **parallel arrays**, not row objects: `open[]`, `high[]`, `low[]`, `close[]`,
  `volume[]`, `timestamp[]`, `open_interest[]`, index-aligned.
- Lookback: daily back to inception; intraday **max 90 days per request**, ~5 years
  available.

> Measured in this repo on 2026-07-27 and recorded in `live-feed-server.ts:1173` —
> `/charts/historical` returns roughly the **same ~1 year** for a 730- or 1825-day range,
> and `/charts/intraday` **HTTP-errors** past its window. The documented limits are more
> generous than observed behaviour. Budget for that.

Related, already documented elsewhere in this vault — do not re-derive:
[[Patterns/2026-07-23 - Candle table + Dhan backfill (Sentinel on real data)]] has the
verified request/response shapes and the epoch-seconds-UTC gotcha.

Also available: **Expired Options Data** (for options backtests that need dead contracts),
**Option Chain** (`POST /v2/optionchain`, `/v2/optionchain/expirylist` — OI, Greeks, IV,
bid/ask across all strikes in one call, REST-only, **not on the WebSocket feed**).

---

## The event loop — knowing your algo's orders filled

- **Live Order Update WebSocket**: `wss://api-order-update.dhan.co`. Auth frame is
  `{ MsgCode: 42, ClientId, Token, UserType: "SELF" }` (partners send `UserType: "PARTNER"`
  and `Secret` instead of `Token`). Messages arrive as `{ Type: "order_alert", Data: {...} }`
  carrying `OrderNo`, `ExchOrderNo`, status, `TradedQty`, `TradedPrice`, `AvgTradedPrice`,
  `RemainingQuantity`, and timestamps.
- **Postback**: HTTP callbacks to your endpoint on order events.

Neither replaces reconciliation polling. `services/trading-engine`'s `order_poller.py` is
described in its README as *"a safety net, not a stopgap"* — that judgement holds against
this API surface, since the docs specify **no reconnection policy or delivery guarantee**
for the order-update socket.

---

## Hard constraints every algo design must absorb

### Static IP is mandatory (SEBI algo regulation)

Introduced in **v2.4 (Sep 22, 2025)**, *"in line with the changes in SEBI guidelines on
Retail Participation in Algorithmic Trading"*:

- **Static IP whitelisting is required for all Order APIs** — placing, modifying and
  cancelling normal, super and forever orders alike. Data APIs are unaffected.
- Set primary and secondary IPs via `/v2/ip/setIP`. IPv4 and IPv6 both accepted.
- **Once set, an IP cannot be changed for 7 days.**
- Each individual needs a unique static IP.

**This is a deployment-architecture constraint, not a config detail.** Ephemeral container
IPs, autoscaling groups and most managed platforms will break order placement. It has to be
resolved against `infra/terraform/` — a NAT gateway with an Elastic IP, or an egress proxy —
before any live-order path is deployed. See
[[Plans/2026-08-10 - Production readiness audit (security, scale, infra)]].

### Access tokens expire in 24 hours

Also v2.4, same regulatory driver. Generate at web.dhan.co, or programmatically via
`https://auth.dhan.co/app/generateAccessToken` (**requires TOTP enabled**) with client ID +
PIN + TOTP. Extend via `https://api.dhan.co/v2/RenewToken`.

Headers on every call: `access-token`, `client-id` (`dhanClientId`).

This repo already lives with the consequence — the note at
[[Patterns/2026-07-24 - Sentinel live data across the full universe]] records the token
expiring around 15:21 IST daily. An unattended algo needs the TOTP renewal path, not a
pasted token.

### Rate limits

| Category | /second | /minute | /hour | /day |
|---|---|---|---|---|
| **Order APIs** | 10 | 250 | 1,000 | 7,000 |
| **Data APIs** | 5 | — | — | 100,000 |
| **Quote APIs** | 1 | — | — | — |
| **Non-Trading APIs** | 20 | — | — | — |

- **Max 25 modifications per order.** A tight trailing-stop loop that re-modifies on every
  tick will exhaust this on a single position.
- v2.2 removed Data API minute/hour caps and raised the daily ceiling to 100,000.
- v2.3 pinned order placement at 10/sec *"per regulatory requirements"*.
- The **1 req/sec Quote cap** is why `services/api` stopped generating quotes and
  `services/market-data` became the sole writer — see
  [[Patterns/2026-07-21 - Market data Phase 1 (ingestion runtime, pure reads)]]. The option
  chain calls in `live-feed-server.ts` are serialized behind a FIFO queue with a 2.5s floor
  gap for the same reason.
- Broker feed WebSockets are capped at **5 connections per account**, and the oldest is
  evicted with code 805 — a standing risk for this repo, recorded in
  [[Patterns/2026-08-04 - SentinelIntelligence continuous market watch (polling, not a sixth WebSocket)]].

### Registration

There is **no algo registration or approval step for building your own automation** against
the API — every Dhan user gets Trading APIs free (Data APIs are charged). Exchange approval
and SEBI registration apply to **publishing an algo on the marketplace for others**, not to
trading your own account. Partner/white-label access uses a separate three-step OAuth flow
(`/partner/generate-consent` → `/consent-login` → `/partner/consume-consent`) and requires
contacting Dhan.

---

## What this means for TradeW

### The boundary that does not move

Per [Rule 2](../../CLAUDE.md), **AI services never place trades.** Everything in this note
belongs to the **execution layer** (`services/trading-engine`), never to Sentinel or
TradeW-AI. Sentinel is observation and education only — no Buy/Sell/Entry/Target
recommendation, and never a gate in the order flow. Conditional Triggers are especially
tempting to wire into Sentinel's detections; that would be a direct violation. A Sentinel
detection may *inform a human*; it may not create an alert-order.

### What we already consume

Only the **data** half. Per `REPOSITORY_INVENTORY.md` and `live-feed-server.ts`:
`wss://api-feed.dhan.co`, `/v2/charts/historical`, `/v2/charts/intraday`, `/v2/optionchain`,
`/v2/optionchain/expirylist`, plus `images.dhan.co` scrip masters. **Zero order endpoints
are called anywhere in the repo today.** Credentials exist in `.env.example`
(`DHAN_ACCESS_TOKEN`, `DHAN_CLIENT_ID`, `DHAN_APP_ID`/`SECRET`, `DHAN_API_KEY`/`SECRET`), and
the OAuth consent flow lands in `BrokerCredential` — see
[[Patterns/2026-07-29 - Broker OAuth ownership and third-party content boundaries]].

### Where the existing strategy work lands

- `services/trading-engine` is a **README-only stub awaiting execution approval**. Its
  designed intake is TradingView webhook JSON from `strategies/orb_final.pine` — an
  **Opening Range Breakout**. Against this API that is a Tier-3 strategy: ORB levels are not
  expressible as a Conditional Trigger (the level is computed intraday from the first N
  minutes, and F&O is excluded anyway), so the rule loop stays ours and Dhan supplies
  `/v2/orders` + `/orders/slicing`.
- `services/sentinel/scripts/backtest-ema-cross.ts` already backtests an EMA cross on real
  Dhan candles — the **one** archetype in the table above that Dhan could also host natively
  as a Conditional Trigger, and only for equities/indices. Findings from that backtest
  (the bare EMA rule is breakeven-to-losing; the fresh-cross filter flips indices positive
  but not stocks) are recorded in
  [[Patterns/2026-07-24 - EMA-cross backtest engine (Sentinel, real Dhan data)]] and apply
  directly to any Conditional Trigger built on `EMA_x CROSSING_UP EMA_y`. **The marketplace
  algos are not evidence that these primitives are profitable; our own backtest is evidence
  that the simplest one is not.**

### Open questions before any live-order work

1. **Static IP** — unresolved against `infra/terraform/`. Blocking for any deployed order
   path, and the 7-day change lock means it cannot be sorted out at deploy time.
2. **Exit All API** — release notes claim it, docs do not show it. Verify.
3. **`comparisonType` enum discrepancy** — Annexure vs endpoint page disagree.
4. **Whose credentials** — the partner track question in
   `docs/product-architecture/DHAN-MARKET-DATA-INTEGRATION.md` (may a partner serve data to
   end users, or must each user auth their own account) applies with more force to *orders*.
5. **TOTP renewal** — an unattended algo cannot run on a hand-pasted 24-hour token.

### Not investigated here

DhanHQ also ships an **MCP server** and an **agent skill pack** (12 categories, including
"backtesting" and "ScanX"). Both are listed on `docs.dhanhq.co` with no published endpoint
detail — the backtesting and ScanX categories are named but not specified. If a Dhan-hosted
backtest or screener API turns out to exist behind those, it would change the picture for
strategy validation; worth a follow-up.

---

## Sources

- [DhanHQ v2 API docs](https://dhanhq.co/docs/v2/) — [Orders](https://dhanhq.co/docs/v2/orders/) ·
  [Super Order](https://dhanhq.co/docs/v2/super-order/) ·
  [Forever Order](https://dhanhq.co/docs/v2/forever/) ·
  [Conditional Trigger](https://dhanhq.co/docs/v2/conditional-trigger/) ·
  [Trader's Control](https://dhanhq.co/docs/v2/traders-control/) ·
  [Historical Data](https://dhanhq.co/docs/v2/historical-data/) ·
  [Live Order Update](https://dhanhq.co/docs/v2/order-update/) ·
  [Authentication](https://dhanhq.co/docs/v2/authentication/) ·
  [Annexure](https://dhanhq.co/docs/v2/annexure/) ·
  [Releases](https://dhanhq.co/docs/v2/releases/)
- [docs.dhanhq.co](https://docs.dhanhq.co/) — skill pack / MCP server
- [Dhan Algos marketplace](https://algos.dhan.co/)
- [Dhan support — API rate limits](https://dhan.co/support/platforms/dhanhq-api/what-are-the-api-rate-limits-for-dhan/)
- [DhanHQ Trading APIs / partner track](https://dhanhq.co/trading-apis)

Retrieved 2026-08-11. Dhan ships breaking changes with release versions — re-check
`/docs/v2/releases/` before relying on any enum above.
