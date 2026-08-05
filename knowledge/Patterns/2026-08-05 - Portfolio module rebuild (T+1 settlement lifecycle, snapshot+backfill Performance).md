---
type: pattern
date: 2026-08-05
tags: [portfolio, oms, settlement, holdings, performance, trade-history]
---

# Portfolio module rebuild — T+1 settlement lifecycle, snapshot+backfill Performance

**Read before touching `services/api/src/sim/{settlement,holdings,trade-history,performance}.service.ts`, `Position.settlesAt`/`closeReason`, or `apps/web/src/components/portfolio/`.**

Rebuilt `/portfolio` from a 2-tab (Positions + a hand-written Performance summary) page into the full broker spec: Summary, Holdings, Positions, Orders (5 status tabs), Trade History (filters + CSV), Performance (charts + a Performance Diary), Position Management (Convert/Add Qty/Partial/Full Exit). All on the existing paper OMS (`OrderService`/`PositionService`/`PortfolioService`, `/sim/*`) — no mock data, no new trading logic beyond what's documented here.

## Holdings — real T+1 settlement, not a filtered view

Every open position previously lived in one `Position` row regardless of product type. Real brokers only call delivered equity a "holding" once T+1 settlement clears; until then it's still a Position. Built properly per explicit request, not a shortcut:

- `Position` gained `settlesAt DateTime?` (only ever set for CNC — MIS/NRML structurally can never reach Holding) and `closeReason PositionCloseReason?` (`FLATTENED` = a real closing trade, `SETTLED` = transferred to a Holding, `CONVERTED` = product-type conversion — three different reasons a Position hits zero, never conflated).
- New models `Holding` (settled equity, weighted-avg `avgCost`, its own `realizedPnl`) and `HoldingSettlement` (audit trail of each transfer — `positionId` deliberately NOT an FK, see that field's schema comment).
- `SettlementService.settleUser` does the transfer: merges a matured CNC position's quantity into a Holding (weighted-average merge, `mergeHoldingLot` — pure, tested), zeroes the Position, no `Trade` row (a transfer, not a fill). Called two ways: a `setInterval` sweep (5 min — settlement is date-granular, coarser than `MatchingEngineService`'s 3s tick) and lazily at the top of every `PositionService.list()`/`HoldingsService.list()` for the requesting user, so a user's own view is never stale between sweep ticks — same "plain interval, not `@nestjs/schedule`" precedent `MatchingEngineService` set.
- **Documented simplification**: settlement is position-level, not per-lot — a same-day top-up of an already-unsettled CNC position joins the existing cohort's date rather than tracking each lot's own T+1. Fine for a paper platform with no tax-lot reporting need; would need revisiting for anything resembling real cost-basis/tax reporting.
- `market-calendar.ts` gained `nextTradingDay`/`istMidnightUtc` (exported, IST-day-key arithmetic, no DST since IST has none) — reused by `PerformanceService` too, not re-derived.
- Selling a *settled* Holding is `HoldingsService.sell`, not a Position mutation — creates a real `Order`+`Trade` (a holdings sale is a broker order, so Orders/Trade History see it) and credits the wallet exactly like `executeFill` does. Buying more of a holding needs no new backend — `productType: 'CNC'` through the existing `placeOrder` already feeds the same settlement lifecycle.

## Trade History — a real bug found and fixed, not FIFO simulation

The spec wants paired Entry/Exit rows; `Trade` stores one row per fill, not per round-trip. `Trade.realizedPnl` is already correct per closing trade (`applyFill`), so entry price is **algebraically recoverable** — invert `realizedPnlDelta = closingQty * (fillPrice - entryPrice) * sign(existingQty)` — no lot simulation needed (`deriveEntryPrice` in `trade-history.service.ts`).

That surfaced a real, previously-invisible bug: on a **close-and-flip** fill (one order both closes an existing position and opens the opposite direction, e.g. closing a 10-long with a 15-SELL), `applyFill`'s `closingQty` (10) is strictly less than the fill's full `quantity` (15) — but `Trade.quantity` always stored the full 15. Dividing `realizedPnl` by the full fill quantity instead of the actual closing quantity silently mispriced the entry. Fixed with `Trade.closedQuantity Int?` (nullable, additive migration `20260805010000_trade_closed_quantity`), populated by `executeFill` (mirrors `applyFill`'s own `closingQty` calc) and by `HoldingsService.sell` (always equals `quantity` there — a holdings sale can never flip). `trade-history.spec.ts` has a test that demonstrates the wrong-vs-right math side by side. This bug was latent in the data model before this change (nothing previously read `realizedPnl` divided by quantity) but would have shipped wrong the moment Trade History did.

## Performance — hybrid EOD snapshot + on-read backfill, "Today" always live

Per explicit request (rejecting the lighter "derive everything from Trade log" option): new `PortfolioSnapshot` model, captured once daily after session close by `PerformanceService`'s sweep (same interval-poller precedent). Two things this hybrid can and can't do:

- A **captured** day's `unrealizedPnl`/`closingValue` are live numbers frozen at/near that day's real close.
- A **derived** day (no snapshot row — before this feature existed, or a gap) can only reconstruct the *realized* side from the Trade log — there is no historical price data anywhere in this platform, so a derived day's `unrealizedPnl` is always 0. `DiaryEntry.source: 'snapshot' | 'derived'` tells the UI which kind of day it's looking at rather than silently blending an approximation into a real number.
- **`today()` never reads a snapshot** — always live from `PortfolioService.summary()`, so the current trading day is never a day behind its own numbers.
- **No `1D` endpoint.** No intraday tick storage exists (`PortfolioSnapshot` is EOD-only) and building one is real new-infra scope, not "add the missing API for this page." The frontend's 1D range is a client-side live-building buffer from the page's own poll — it will not reconstruct this morning's shape after a reload. Stated in `PerformanceController`'s docstring, not hidden.
- **No fabricated Diary narrative.** The reference screenshot the user sent shows generated prose per diary entry ("Strong recovery... led by BANKNIFTY & IT"). That's synthesized text, out of scope per "no mock data" / "don't add AI/Sentinel to this page" — the Diary renders only factual computed fields (best/worst mover by real symbol+P&L, real trade counts), no invented commentary.
- `PortfolioService.summary()` was extended (`investedAmount`, `currentValue`, `overallPnl`, `availableMargin`, Holdings folded into `netWorth`) ahead of the original phase plan — Performance genuinely needed those numbers and building Performance against stale ones would've meant redoing it. `netWorth` had to change: `SettlementService` releases a position's margin on transfer, so without adding `holdingsValue` back into the formula, an account's total value would visibly drop the instant a position settled even though nothing was lost — verified by hand-tracing a buy→settle→appreciate sequence in the design phase.

## Position Management — Convert/Add/Partial/Full Exit, SL/Target deliberately absent

`PositionService.convert()` moves a position's whole quantity to a different product type (merges into a same-direction existing position at that type via `mergePositionForConversion` — pure, tested; **refuses** an opposite-direction target rather than netting it, since netting-through-zero is what a real closing trade does and blurring "closed by conversion" into "closed by trade" serves nothing). Add Quantity / Partial Exit / Full Exit are thin wrappers over existing `placeOrder`/`exitPosition` — no new order logic. Stop-Loss/Target/Trailing are explicitly not built (no bracket-order support in the engine) but nothing about the `Position` model or this API shape would need to change to add them later — that was a stated design constraint, not an incidental gap.

## What's NOT verified live in this session

A full order→Position→Holdings-settlement→Trade-History→Performance walkthrough against real market data could **not** be completed: the Dhan live-feed bridge (`services/market-data`'s `live-feed-server.ts`, port 4600) was stuck in a 429/reconnect loop and then died outright — almost certainly multiple concurrent sessions (this one plus the `.claude/worktrees/ai-reasoning` worktree, each running their own bridge instance) competing for Dhan's 5-connection-per-account cap, the same constraint [[Patterns/2026-08-04 - SentinelIntelligence continuous market watch (polling, not a sixth WebSocket)]] already documents. What *was* verified: all 6 sections render correctly against real (zeroed, fresh-account) API responses in-browser, 240 backend unit tests pass (settlement math, the flip-trade bug fix, conversion math, pctReturn), and both `services/api` and `apps/web` build clean. Re-run a live order-flow walkthrough once only one bridge instance is running.

## Links

- [[Decisions/2026-07-17 - Obsidian Knowledge Layer adopted]] — this vault's scope
- [[Patterns/2026-08-04 - SentinelIntelligence continuous market watch (polling, not a sixth WebSocket)]] — the Dhan 5-connection-cap constraint that blocked live verification here
- `_INDEX.md`'s Gotchas section (`prisma migrate dev` non-interactive) — same hand-authored-SQL-plus-`migrate deploy` workflow used for all three new migrations this change shipped (`20260805000000_portfolio_holdings_settlement_snapshots`, `20260805010000_trade_closed_quantity`, `20260805020000_position_close_reason_converted`)
