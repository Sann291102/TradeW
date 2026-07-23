# Chapter 11 — Paper Trading Engine

**Status: 🟢 Shipped.** ~950 lines across seven files in `services/api/src/sim/`. This is a real order-management system, not a demo.

---

## 11.1 Why this is built properly

The mission phrase is *"learn before you risk real money."* A paper engine that fills instantly at a made-up price with no margin and no rejection teaches a trader that trading is easy. That is worse than teaching nothing.

So the engine implements the parts that hurt:

| Property | Why it matters pedagogically |
|---|---|
| Fills against **real live prices** | The fill price matches what the user sees on their own chart |
| **Simulated margin that can reject** | "Insufficient margin" is a real experience with real consequences |
| **Resting orders** that may never fill | A limit order that sits unfilled all day is a lesson |
| **DAY validity expiry** at IST session close | Orders do not live forever |
| **Charges on every fill** (3 bps) | Frictionless trading teaches the wrong economics |
| **Close-and-flip** arithmetic | Because it happens, and getting it wrong teaches false P&L |
| **Bid/ask spread** on fills | BUY at ask, SELL at bid — you always cross the spread |

What it deliberately does **not** simulate: real SPAN/exposure margin, a genuine order book with queue position, slippage on size, and exchange holidays. Each omission is documented at the point where it matters, which is the difference between a limitation and a bug.

---

## 11.2 File map

```
services/api/src/sim/
├── sim.controller.ts        141   11 endpoints, class-validator DTOs
├── order.service.ts         428   placement, fills, margin, wallet — the core
├── position.service.ts      138   position DTOs, P&L, session anchoring
├── portfolio.service.ts      56   account rollup (assembles, never recomputes)
├── matching-engine.service.ts 123 3-second poller for resting orders
├── market-price.service.ts  162   live Dhan bridge client + instrument resolution
└── ist-time.util.ts          46   IST session boundaries — one implementation
```

---

## 11.3 The order state machine

```
                    ┌─────────────────────────────────────┐
                    │  POST /sim/orders                   │
                    │  validate → resolve → margin check  │
                    └──────────────┬──────────────────────┘
                                   │
          ┌────────────────────────┼───────────────────────┐
          │                        │                       │
   validation fails         MARKET order            LIMIT / SL / SL_M
   or margin short                │                       │
          │                       ▼                       ▼
          ▼              ┌────────────────┐    ┌──────────────────────┐
    ┌──────────┐         │  PENDING       │    │  LIMIT  →  OPEN      │
    │ REJECTED │         │  (transient)   │    │  SL/SL_M →           │
    │ +reason  │         └────────┬───────┘    │      TRIGGER_PENDING │
    └──────────┘                  │            └──────────┬───────────┘
                        fills in the same                 │
                        transaction                       │ margin blocked
                                  │                       │ expiresAt set
                                  ▼                       ▼
                          ┌───────────────┐    ┌─────────────────────────┐
                          │    FILLED     │    │  MatchingEngineService  │
                          └───────────────┘    │  every 3 seconds        │
                                               └──────────┬──────────────┘
                                                          │
                          ┌───────────────────┬───────────┼──────────────┐
                          ▼                   ▼           ▼              ▼
                   ┌─────────────┐    ┌──────────────┐ ┌────────┐ ┌──────────┐
                   │TRIGGER hit  │    │ limit        │ │expiresAt│ │ user     │
                   │ SL_M → fill │    │ crossable    │ │ passed  │ │ cancels  │
                   │ SL  → OPEN  │    │ → fill       │ │→EXPIRED │ │→CANCELLED│
                   │ (same tick) │    └──────┬───────┘ └────┬────┘ └────┬─────┘
                   └─────────────┘           ▼              │           │
                                    ┌────────────────┐      │           │
                                    │FILLED or       │      └───────────┘
                                    │PARTIALLY_FILLED│      margin released
                                    └────────────────┘
```

### 11.3.1 Status semantics

Documented in the schema itself, which is where they belong:

| Status | Meaning |
|---|---|
| `PENDING` | Accepted, not yet queued. Transient — a MARKET order occupies it for microseconds inside its transaction. |
| `OPEN` | Resting and working the market (a LIMIT before fill). |
| `TRIGGER_PENDING` | SL/SL_M before its trigger price is hit. |
| `PARTIALLY_FILLED` | `filledQuantity` < `quantity`. |
| `FILLED` | `filledQuantity` == `quantity`. |
| `CANCELLED` | User- or validity-cancelled before full fill. |
| `REJECTED` | Never accepted — bad lot size, insufficient margin, unresolvable instrument. |
| `EXPIRED` | DAY-validity order still open at session close. |

---

## 11.4 Order placement

### 11.4.1 The validation ladder

Three tiers, each failing differently, and the ordering is deliberate:

```
   TIER 1  DTO validation (class-validator, at the controller)
           → 400 before the service is ever called
           quantity: @IsInt @Min(1)
           price/triggerPrice: @IsNumber @Min(0.01)
           side/type/validity/productType: @IsEnum

   TIER 2  Business validation (OrderService, throws)
           → 400 BadRequestException, no Order row created
           • quantity is a positive integer
           • LIMIT/SL require a positive price
           • SL/SL_M require a positive triggerPrice
           • quantity % instrument.lotSize === 0

   TIER 3  Margin validation (OrderService, RECORDS)
           → an Order row with status REJECTED and a rejectReason
```

**Tier 3 creates a row; Tiers 1 and 2 do not.** That asymmetry is correct and is worth understanding:

- A malformed request is a *client bug*. Persisting it pollutes the order book.
- An insufficient-margin rejection is a *trading event*. The user tried to do something and the account said no. It belongs in the order book, it belongs in their history, and — for Sentinel — it is behavioural evidence.

### 11.4.2 Lot size — a real constraint, not decoration

```ts
if (input.quantity % instrument.lotSize !== 0) {
  throw new BadRequestException(`Quantity must be a multiple of lot size ${instrument.lotSize}`);
}
```

NIFTY options trade in lots of 50 (subject to exchange revision). You cannot buy 30. A paper engine that permits 30 teaches a trader something that will be rejected the first time they trade real money.

### 11.4.3 MARKET orders — the immediate path

```ts
const price     = await this.marketPrice.getPrice(instrument);
const fillPrice = input.side === 'BUY' ? price.ask : price.bid;
const margin    = computeMargin(instrument, input.side, productType, fillPrice, input.quantity);

if (margin > Number(wallet.cashBalance)) return this.rejectNewOrder(…, 'Insufficient margin');

return this.prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ …, status: 'PENDING' });
  return this.executeFill(tx, order, instrument, fillPrice, input.quantity, price.ltp);
});
```

**BUY fills at ask, SELL fills at bid.** You always cross the spread — as you do in reality. An engine filling both sides at LTP quietly gifts the user half a spread on every round trip, which compounds into a materially false picture of their edge.

Creation and fill are in **one transaction**. There is no window in which a MARKET order exists unfilled.

### 11.4.4 Resting orders — LIMIT / SL / SL_M

```ts
const referencePrice = input.type === 'LIMIT' ? input.price! : input.triggerPrice!;
const margin = computeMargin(instrument, input.side, productType, referencePrice, input.quantity);
if (margin > Number(wallet.cashBalance)) return this.rejectNewOrder(…, 'Insufficient margin');

return this.prisma.$transaction(async (tx) => {
  const order = await tx.order.create({
    …,
    status: input.type === 'LIMIT' ? 'OPEN' : 'TRIGGER_PENDING',
    marginBlocked: margin,
    expiresAt: validity === 'DAY' ? todayIstSessionEnd() : null,
  });
  await tx.paperWallet.update({
    where: { userId },
    data: { marginUsed: { increment: margin }, cashBalance: { decrement: margin } },
  });
  return order;
});
```

**Margin is blocked at placement, not at fill.** This is what makes "available balance" mean something: a user with ₹1,00,000 who places five resting orders each needing ₹30,000 gets four accepted and the fifth rejected — exactly as a real account behaves.

The reference price differs by type: a LIMIT's margin is computed at its limit price; an SL's at its trigger price. Neither is exactly what will be blocked at fill, and both are the best available estimate at placement time.

---

## 11.5 The margin model

```ts
function computeMargin(instrument, side, productType, price, quantity): number {
  const notional = price * quantity;
  if (instrument.type === 'OPTION' && side === 'BUY') return notional;              // full premium
  if (productType === 'CNC')                          return notional;              // cash delivery
  if (instrument.type === 'FUTURE' ||
      (instrument.type === 'OPTION' && side === 'SELL')) return notional * 0.15;    // ~SPAN+exposure
  return notional * 0.2;                                                            // MIS ~5× leverage
}
```

| Case | Margin | Effective leverage | Correct because |
|---|---|---|---|
| Option BUY | 100% of premium | 1× | You pay the premium in full. Max loss = premium. |
| CNC (delivery) | 100% of notional | 1× | Cash-and-carry. No leverage. |
| Option SELL | 15% of notional | ~6.7× | Approximates SPAN + exposure. Real short-option margin is dynamic. |
| FUTURE | 15% of notional | ~6.7× | Same approximation. |
| MIS intraday | 20% of notional | 5× | Typical Indian intraday equity leverage. |

### 11.5.1 The honesty of the docstring

```
/**
 * Simplified simulated margin — NOT real SPAN/exposure margin. A paper
 * engine needs *some* number to block so "available balance" is meaningful
 * and "insufficient margin" can genuinely reject an order, without
 * reimplementing an exchange's actual margin engine. Documented here rather
 * than silently presented as authoritative.
 */
```

Real SPAN margin is a portfolio-level risk computation involving scenario arrays published by the exchange, recomputed intraday, with cross-margining benefits across correlated positions. Implementing it faithfully is a project, not a function.

The decision — approximate, and **say so in the code** — is the right one. The failure mode to avoid is not "the margin is approximate"; it is "the margin is approximate and a future engineer assumes it isn't."

🔵 **Planned:** surface a note in the UI when a margin figure materially diverges from what a real broker would block, so the approximation is visible to the user too, not only to the engineer reading the source.

---

## 11.6 The matching engine

**Code:** `matching-engine.service.ts` (123 lines)

### 11.6.1 Why a poller

There is no real order book to rest on. There is no exchange to send the order to. So "matching" means: *periodically check whether the live price now satisfies each resting order.*

```ts
const POLL_MS = 3_000;

onModuleInit()    { this.timer = setInterval(() => void this.tick(), POLL_MS); }
onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
```

Plain `setInterval` via Nest lifecycle hooks rather than `@nestjs/schedule`, with the reasoning stated in the file:

> *"this service needs nothing that package provides beyond 'run every N seconds,' so it isn't a new dependency for one line of behavior."*

That is a good instinct and it generalises: a dependency added for one line of behaviour is a dependency you will still be upgrading in three years.

### 11.6.2 The cost model that makes polling viable

```ts
private async tick(): Promise<void> {
  const resting = await this.prisma.order.findMany({
    where: { status: { in: ['OPEN', 'TRIGGER_PENDING'] } },
    include: { instrument: true },
  });
  if (resting.length === 0) return;
  for (const order of resting) {
    try { await this.evaluate(order); }
    catch (err) { this.logger.error(`tick: failed to evaluate order ${order.id}`, err); }
  }
}
```

**One `/quotes` snapshot per tick covers every resting order regardless of count** — because `MarketPriceService` caches the snapshot for 2 s and the tick is 3 s. So the cost per tick is:

```
   1 database query  +  1 bridge call  +  N in-memory comparisons
```

Polling cost does not scale with order volume. That is the property that makes this design correct rather than lazy, and it is stated in the file's own docstring.

### 11.6.3 Per-order error isolation

```ts
// One order's evaluation failing (e.g. its instrument's live price is
// momentarily unreachable) must never stop the rest of the book from
// being evaluated this tick.
```

An unpriceable instrument leaves *its* order resting for the next tick and does not touch anyone else's. Principle 8 at the loop level.

### 11.6.4 Trigger semantics

```ts
const triggered = order.side === 'BUY' ? price.ltp >= trigger : price.ltp <= trigger;
```

Standard stop-order semantics, and the comment explains the direction, which is the part people get backwards:

> *SL/SL_M BUY protects a short (or enters a breakout) — triggers when price rises to the trigger. SELL protects a long — triggers when price falls to it.*

### 11.6.5 The same-tick re-check

```ts
// SL -> now a resting LIMIT at `order.price`. Re-check in the same
// tick (not next tick) in case the trigger and the limit are both
// satisfied by the same price move.
await this.prisma.order.update({ where: { id: order.id }, data: { status: 'OPEN' } });
order = { ...order, status: 'OPEN' };
```

A fast move can satisfy both the trigger and the limit within one 3-second window. Waiting for the next tick would delay the fill by up to 3 seconds for no reason and would make SL orders behave subtly worse than SL_M ones. Six lines to avoid an artefact of the implementation leaking into the product's behaviour.

### 11.6.6 Fill price — never worse than asked

```ts
const fillable  = order.side === 'BUY' ? price.ask <= limitPrice : price.bid >= limitPrice;
if (!fillable) return;
// Fill at the limit price or better — the market can gap through a
// limit, but the user is never filled worse than what they asked for.
const fillPrice = order.side === 'BUY' ? Math.min(limitPrice, price.ask)
                                       : Math.max(limitPrice, price.bid);
```

If price gaps below a BUY limit, the user fills at the *better* price. Correct: a limit order is a price ceiling for a buy, a floor for a sell.

---

## 11.7 Fill execution and position mathematics

### 11.7.1 `applyFill` — the arithmetic that must be right

```ts
function applyFill(existingQty, existingAvgPrice, side, fillQty, fillPrice) {
  const delta       = side === 'BUY' ? fillQty : -fillQty;
  const newQuantity = existingQty + delta;

  // CASE 1 — opening or adding in the same direction
  if (existingQty === 0 || Math.sign(existingQty) === Math.sign(delta)) {
    const newAvgPrice = existingQty === 0
      ? fillPrice
      : (Math.abs(existingQty) * existingAvgPrice + Math.abs(delta) * fillPrice)
        / Math.abs(newQuantity);
    return { newQuantity, newAvgPrice, realizedPnlDelta: 0 };
  }

  // CASES 2–4 — reducing, closing, or flipping
  const closingQty      = Math.min(Math.abs(existingQty), Math.abs(delta));
  const realizedPnlDelta= closingQty * (fillPrice - existingAvgPrice) * Math.sign(existingQty);

  // CASE 2 — partial close: remainder keeps its cost basis
  if (Math.abs(delta) < Math.abs(existingQty)) {
    return { newQuantity, newAvgPrice: existingAvgPrice, realizedPnlDelta };
  }

  // CASES 3–4 — full close (avg price irrelevant), or flip (new basis = fillPrice)
  return { newQuantity,
           newAvgPrice: newQuantity === 0 ? existingAvgPrice : fillPrice,
           realizedPnlDelta };
}
```

### 11.7.2 The four cases, worked

```
   CASE 1 — ADD                    long 100 @ 500, BUY 50 @ 520
   ─────────────────────────────────────────────────────────────
   qty      100 → 150
   avg      (100×500 + 50×520) / 150 = 506.67
   realized 0

   CASE 2 — PARTIAL CLOSE          long 100 @ 500, SELL 40 @ 520
   ─────────────────────────────────────────────────────────────
   qty      100 → 60
   avg      500  (UNCHANGED — the remainder keeps its cost basis)
   realized 40 × (520 − 500) × sign(+100) = +800

   CASE 3 — FULL CLOSE             long 100 @ 500, SELL 100 @ 520
   ─────────────────────────────────────────────────────────────
   qty      100 → 0
   avg      500  (retained; irrelevant at zero quantity)
   realized 100 × (520 − 500) = +2,000

   CASE 4 — CLOSE AND FLIP         long 100 @ 500, SELL 150 @ 520
   ─────────────────────────────────────────────────────────────
   closingQty = min(100, 150) = 100
   realized   = 100 × (520 − 500) × sign(+100) = +2,000
   qty        100 → −50   (now SHORT 50)
   avg        520         (new basis — the flip half opens fresh)
```

**Case 2's unchanged average price is the one people get wrong.** Selling part of a position does not change what the remaining shares cost you. Recomputing the average on a partial close would corrupt every subsequent P&L calculation on that position.

**Case 4 is the one demos skip.** `Math.sign(existingQty)` is what makes it work for shorts as well as longs: closing a short at a *lower* price is a profit, and the sign flip handles it without a branch.

### 11.7.3 Wallet mutation on fill

Every fill, inside the transaction:

```
   PaperWallet
     cashBalance  += released margin
     cashBalance  −= new margin required
     cashBalance  += realizedPnlDelta
     cashBalance  −= charges
     marginUsed    = recomputed for the resulting position
     realizedPnl  += realizedPnlDelta

   Order
     filledQuantity += fillQty
     avgFillPrice    = quantity-weighted across this order's trades
     status          = FILLED | PARTIALLY_FILLED

   Trade  (created)
     fillPrice, quantity, charges, realizedPnl (null unless closing)

   Position  (upserted)
     quantity, avgPrice, realizedPnl, marginUsed
```

**Incremental, not derived.** The wallet is maintained on every fill rather than recomputed from trade history on read. The schema comment states the reason:

> *"Maintained incrementally, not derived per-request, so it stays correct even if trade history is pruned later."*

This is also why `PortfolioService` is 56 lines: it assembles numbers that are already correct.

### 11.7.4 Charges

```ts
const CHARGES_RATE = 0.0003;   // 3 bps of gross trade value
```

A single blended rate standing in for brokerage + STT + exchange charges + GST + stamp duty + SEBI turnover fee. Not accurate per-segment — Indian charges differ substantially between intraday equity, delivery, and options — but non-zero, which is the pedagogically important part.

🔵 **Planned:** per-segment charge modelling, because for a high-frequency intraday trader charges are frequently the entire difference between a profitable and an unprofitable strategy, and a blended 3 bps understates that for options.

---

## 11.8 IST session handling

**Code:** `ist-time.util.ts` (46 lines)

### 11.8.1 One implementation, three consumers

> *"One place for the `toLocaleString`-based IST conversion trick so it isn't reimplemented three slightly-differently each time."*

Used by `OrderService` (DAY expiry), `MatchingEngineService` (expiry checks), and `PositionService` (daily P&L boundaries). Three slightly-different timezone implementations is a classic source of a bug that only appears near midnight, only in one code path, and only for some users.

### 11.8.2 The conversion technique

```ts
function istOffsetMs(now: Date): { istAsLocal: Date; offsetMs: number } {
  const istAsLocal = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return { istAsLocal, offsetMs: now.getTime() - istAsLocal.getTime() };
}
```

Reinterprets `now` as though its wall-clock reading were already IST, and returns the offset needed to convert an IST-local `Date` back to a real UTC instant. Not elegant — but correct, dependency-free, and confined to one file behind three named functions.

### 11.8.3 The session-end rollforward

```ts
export function todayIstSessionEnd(): Date {
  const { istAsLocal, offsetMs } = istOffsetMs(new Date());
  const cutoff = new Date(istAsLocal);
  cutoff.setHours(15, 30, 0, 0);
  if (istAsLocal.getTime() > cutoff.getTime()) cutoff.setDate(cutoff.getDate() + 1);
  while (cutoff.getDay() === 0 || cutoff.getDay() === 6) cutoff.setDate(cutoff.getDate() + 1);
  return new Date(cutoff.getTime() + offsetMs);
}
```

The two loops matter, and the docstring explains why:

> *"Placing an order after today's close (or on a weekend) rolls forward to the next weekday's close instead of returning an already-past instant, which would expire the order within one matching-engine tick of being created."*

An order placed at 16:00 on Friday would otherwise be created with `expiresAt` three hours in the past, and would be `EXPIRED` within three seconds. The user would place an order and watch it die instantly.

> ⚠️ **Known gap, documented in the code:** no exchange holiday calendar. An order placed on the eve of a holiday expires at a session close that will not happen. The same gap affects `isMarketOpen` elsewhere. 🔵 Tracked as TD-7.

### 11.8.4 `en-CA` for the day key

```ts
export function istDayKey(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // en-CA gives YYYY-MM-DD
}
```

A small, genuinely useful trick: the `en-CA` locale formats dates as `YYYY-MM-DD` natively, giving a sortable ISO-style day key without string surgery.

---

## 11.9 P&L computation

### 11.9.1 The four numbers, and what each means

| Number | Definition | Source |
|---|---|---|
| **Realised P&L** | Locked in by closing trades | `PaperWallet.realizedPnl` (incremental) |
| **Unrealised P&L** | Open positions marked to current price | computed per read |
| **Daily P&L** | Change since the IST session-open anchor | `Position.sessionOpen*` |
| **MTM** | Mark-to-market — same as unrealised | separate field, trader terminology |

### 11.9.2 The session anchor

The subtlest design in the module:

```prisma
sessionOpenQty         Int      @default(0)
sessionOpenAvgPrice    Decimal?
sessionOpenMarketPrice Decimal?
sessionAnchorAt        DateTime?
```

> *"Session-open snapshot (IST calendar day), refreshed once per day on first touch. Distinguishes 'today's P&L' from lifetime unrealized/realized without a separate time-series table."*

**Refreshed lazily, on first touch of a new IST day.** No cron job, no nightly batch, no backfill problem.

The alternative — a `PositionSnapshot` table written by a scheduled job at 09:15 IST — would need: a scheduler, leader election so it runs once across replicas, monitoring so a silent failure is noticed, a backfill path for the days it missed, and a decision about what to do for positions opened intraday. Four columns and a lazy check replace all of it, and nobody queries historical position snapshots anyway.

### 11.9.3 The `mtm` duplication

```ts
/** Mark-to-market — the open position's P&L at the current price. Same
 *  number as unrealizedPnl; kept as a separate field because "MTM" is the
 *  term traders expect on a positions screen. */
mtm: number;
```

Redundant data, deliberately. Renaming a domain term to save a field would make the API cleaner and the product worse. Indian traders read "MTM" on every broker screen they have used.

### 11.9.4 `priceStatus` — degradation at the row level

```ts
/** 'stale' when the live bridge couldn't price this symbol just now — the
 *  row still renders (using avgPrice as a placeholder) rather than
 *  disappearing or erroring the whole list. */
priceStatus: 'live' | 'stale';
```

Three ways to handle an unpriceable position, and only one is right:

| Option | Result |
|---|---|
| Throw | The whole positions screen 500s because one symbol is unavailable |
| Omit the row | The user's position silently vanishes — the worst possible outcome |
| **Render with `avgPrice` and flag stale** | The position is visible; its P&L reads 0; the UI can show a marker |

---

## 11.10 The price source

**Code:** `market-price.service.ts` (162 lines)

### 11.10.1 The decision, and its docstring

```
 * All live pricing and instrument metadata for the paper-trading OMS comes
 * from the standalone Dhan live-feed bridge — the exact same real price
 * source already driving the dashboard, charts and option chain.
 *
 * Deliberately NOT `MarketDataService` / Postgres `Quote`: that table is
 * written by a *different* process, which defaults to a simulated
 * random-walk feed. Filling paper orders against that would silently
 * diverge from the real price the user is looking at on screen —
 * confusing at best, wrong at worst.
```

```
   ┌──────────────────────┐         ┌──────────────────────────┐
   │ services/market-data │  writes │  Postgres Quote          │
   │ (NestJS ingestor)    │ ──────► │  source: 'simulated'     │
   │ defaults to OU sim   │         │  (dev default)           │
   └──────────────────────┘         └──────────────────────────┘
                                             ▲
                                             │ read by /market-data/*
                                             │ (informational reads)
   ┌──────────────────────┐
   │ live-feed bridge     │  ← MarketPriceService reads THIS
   │ :4600 /quotes        │    the same source the UI shows
   │ real Dhan prices     │
   └──────────────────────┘
```

Two pipelines exist for good reasons (Chapter 12). The OMS bridges to the live one *specifically* so that a fill price and a chart price can never disagree.

### 11.10.2 The 2-second snapshot cache

```ts
const QUOTES_CACHE_TTL_MS = 2_000;
```

The OMS may need a price for several orders within one request or one matching tick. One bridge call covers all of them. With `POLL_MS = 3_000`, each tick makes at most one bridge call regardless of how many orders are resting.

### 11.10.3 Lazy instrument resolution

```ts
async resolveInstrument(symbol: string): Promise<Instrument> {
  const existing = await this.prisma.instrument.findUnique({ where: { symbol: key } });
  if (existing && existing.active) return existing;
  // …fetch from the bridge, then:
  return this.prisma.instrument.upsert({ where: { symbol: key }, create: {…}, update: data });
}
```

Instruments materialise into Postgres on first use. `Order`/`Trade`/`Position` need a real FK target, so the row must exist — but pre-importing the entire NSE universe is unnecessary for a user who trades six symbols.

Note `existing && existing.active` — a soft-deleted instrument is re-resolved from the bridge rather than returned as-is, which is how a re-listed instrument recovers.

### 11.10.4 The synthetic spread — a real-world workaround

```ts
// Dhan's quote-mode ticks frequently carry bid=ask=0 (no depth in this
// mode, especially after hours) — fall back to a small synthetic
// spread around LTP so LIMIT/SL fill logic always has something
// sensible to compare against, rather than treating 0 as a real,
// crossable price.
bid: quote.bid > 0 ? quote.bid : quote.ltp * 0.9995,
ask: quote.ask > 0 ? quote.ask : quote.ltp * 1.0005,
```

Without this, `price.ask <= limitPrice` would be `0 <= anything` — **every resting BUY limit fills instantly at zero.** A catastrophic, silent, data-dependent bug, caught and fixed with a five-basis-point synthetic spread and a comment explaining exactly what it prevents.

This is the single best example in the codebase of why "comment the why" matters: without the comment, a future engineer removes the fallback as unnecessary defensive code.

### 11.10.5 Option orders reject cleanly

```ts
if (instrument.type === 'OPTION') {
  // Option-contract pricing needs the bridge's /optionchain endpoint,
  // keyed by (underlying, expiry, strike, type) rather than a flat
  // symbol lookup — deliberately not wired in this phase. Reject
  // cleanly rather than silently mispricing a real order against nothing.
  throw new NotFoundException('Option contract order placement is not available yet — underlyings only in this phase');
}
```

An explicit, informative rejection rather than a wrong price. The scope limit is a documented decision, not a gap someone forgot.

---

## 11.11 API surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sim/orders` | Place |
| `GET` | `/sim/orders` | Order book (filterable by status) |
| `PATCH` | `/sim/orders/:id` | Modify quantity / price / trigger |
| `DELETE` | `/sim/orders/:id` | Cancel; releases margin |
| `GET` | `/sim/trades` | Trade book |
| `GET` | `/sim/positions` | Open positions |
| `GET` | `/sim/positions/closed` | Last 100 flattened positions |
| `POST` | `/sim/positions/:instrumentId/exit` | Exit one |
| `POST` | `/sim/positions/exit-all` | Exit all |
| `GET` | `/sim/portfolio` | Account rollup |

All behind `AuthGuard`. `userId` comes from the JWT, never from the request body — a user cannot trade another user's account by changing a payload field.

---

## 11.12 Failure recovery

| Failure | Behaviour | Recovery |
|---|---|---|
| Bridge unreachable during placement | `NotFoundException` — *"Market data is temporarily unavailable"* | User retries |
| Bridge unreachable during a tick | That order's `evaluate` throws, caught per-order | Order stays resting, retried in 3 s |
| API restarts with orders resting | `setInterval` restarts on `onModuleInit`; state is in Postgres | Automatic |
| Transaction fails mid-fill | Prisma rolls back entirely | No partial state |
| Unknown symbol | `NotFoundException` — *"Unknown instrument"* | — |
| Insufficient margin | `REJECTED` row with `rejectReason` | Visible in the order book |
| DAY order past `expiresAt` | `EXPIRED` on the next tick; margin released | Automatic |

### 11.12.1 Transaction boundaries

Every state mutation is in a `$transaction`:

- **Placement + fill** (MARKET) — one transaction
- **Placement + margin block** (resting) — one transaction
- **Fill** (matching engine) — one transaction
- **Expiry + margin release** — one transaction

There is no path that debits margin without creating an order, or creates a trade without updating the wallet.

### 11.12.2 The gap: crash recovery is by design, not by reconciliation

The engine has no reconciliation pass. If a process dies mid-transaction, Postgres rolls back and the state is consistent. If it dies *between* transactions, there is no half-state to reconcile because every operation is atomic.

That is genuinely sufficient for a paper engine with one writer. 🔵 It is **not** sufficient for real money, where `order_poller.py`'s polling-based reconciliation exists precisely because a broker can fill an order whose confirmation never arrives. `ARCHITECTURE.md` §3 says to keep that poller exactly as it is — Chapter 5 §5.9.

---

## 11.13 What is not built 🔵

| Gap | Requirement | Notes |
|---|---|---|
| Option-contract orders | FR-SIM-16 | Bridge `/optionchain` pricing by (underlying, expiry, strike, type) |
| Bracket / cover orders | FR-SIM-17 | `Order.parentOrderId` exists, unpopulated |
| Slippage model | FR-SIM-18 | `Order.slippage` exists, unpopulated |
| Partial fills from size | — | Currently fills are all-or-nothing per evaluation |
| Per-segment charges | — | 3 bps blended; understates options costs |
| Exchange holiday calendar | TD-7 | Affects DAY expiry and `isMarketOpen` |
| GTT / GTC validity | — | Only DAY and IOC |
| Position-level SL/target linkage | — | Depends on bracket orders |

### 11.13.1 The slippage design, when it is built 🔵

```
   slippage = f(order size vs. average bar volume, spread, volatility)

   MARKET order:  fill = ask + slippage(BUY) | bid − slippage(SELL)
   Order.slippage records the difference from the reference LTP
```

Worth building, because zero-slippage MARKET fills teach a trader that size is free — and size is the single thing that stops being free fastest when they move to real money.

---

## 11.14 Testing this module 🔴

**No tests exist.** The priority order, because this module handles money-shaped numbers:

### Tier 1 — `applyFill`, exhaustively

A pure function. Every branch, every sign, every boundary:

```ts
describe('applyFill', () => {
  it('opens from flat',                     …);
  it('adds to a long, weighting the average',…);
  it('adds to a short',                      …);
  it('partially closes a long, KEEPING the cost basis', …);
  it('partially closes a short',             …);
  it('fully closes a long, realizing correctly',        …);
  it('fully closes a short, realizing correctly',       …);
  it('flips long → short with correct split realized P&L and new basis', …);
  it('flips short → long',                   …);
  it('handles a zero-quantity edge case',    …);
});
```

Ten tests. Perhaps sixty lines. They protect the arithmetic every number in the product depends on.

### Tier 2 — margin

```ts
it('blocks full premium on an option BUY',        …);
it('blocks full notional on CNC',                 …);
it('blocks 15% on an option SELL',                …);
it('blocks 20% on MIS equity',                    …);
it('rejects when margin exceeds cash balance',    …);
it('releases margin exactly on cancel',           …);
it('releases margin exactly on expiry',           …);
```

### Tier 3 — the state machine

```ts
it('MARKET fills within its own transaction',                    …);
it('LIMIT rests as OPEN',                                        …);
it('SL rests as TRIGGER_PENDING, becomes OPEN on trigger',       …);
it('SL_M fills at market on trigger',                            …);
it('SL trigger and limit satisfied by one move fill in ONE tick',…);
it('never fills worse than the limit price',                     …);
it('EXPIREs a DAY order past IST session close and releases margin', …);
```

### Tier 4 — IST boundaries ⭐

The highest bug-density area in the module:

```ts
it('rolls session end forward when placed after 15:30 IST',  …);
it('rolls forward over a weekend',                            …);
it('never returns an already-past expiry',                    …);   // ← the Friday-16:00 bug
it('gives a stable day key across a UTC midnight',            …);
```

---

*Next: [Chapter 12 — Market Data](12-market-data.md)*
