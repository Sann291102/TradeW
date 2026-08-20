import type { Instrument, OrderSide } from '@prisma/client';
import { applyFill, computeMargin } from '../sim/order.service';
import { istDayKey } from '../sim/ist-time.util';
import type { BacktestConfig } from './backtest-config';

/**
 * The execution simulator: what a portfolio would have done about a series of
 * strategy signals.
 *
 * ## It does not compute money from scratch
 *
 * `applyFill` and `computeMargin` are imported from `sim/order.service` — the
 * SAME functions the paper engine calls on every real fill. That is deliberate
 * and it is the whole reason this file is in `services/api` rather than next to
 * the strategy replay in `services/sentinel`: a second implementation of
 * average-price maintenance or short-option margin would drift from the paper
 * wallet, and then a backtest and a paper trade of the identical decision would
 * disagree about the identical arithmetic. Both are exported and pure precisely
 * so they can be reused like this.
 *
 * What this file owns is the part the OMS has no opinion about, because the OMS
 * lives in real time: which bar a fill happens on, what a stop does when a bar
 * gaps through it, and when a position is forced flat.
 *
 * ## Cash is modelled the way the paper wallet models it
 *
 * Free cash, blocked margin, and mark-to-market — not "entry price times
 * quantity". A short position's risk is on the underlying, not on the premium
 * received, and a simulator that netted the premium into cash would let a
 * strategy short without limit. `computeMargin` already encodes that lesson
 * (see its own note about under-margining a short option by a factor of 2,175);
 * this reuses the conclusion rather than rediscovering it.
 *
 * ## Where the pessimistic assumption is taken, and why
 *
 * Every ambiguity resolves against the trader:
 *
 *   · A bar whose range spans both the stop and the target is a STOP. Nothing
 *     in an OHLC row says which came first, and assuming the target turns a
 *     losing strategy into a winning one on exactly the most volatile bars.
 *   · A bar that GAPS past the stop fills at the bar's open, not at the stop —
 *     a stop is an instruction, not a guarantee, and the difference is the
 *     entire risk of holding overnight.
 *   · Slippage is charged against the fill on both legs, never in favour.
 *
 * ## No look-ahead
 *
 * Entries use `signal.nextBarIndex`, which the replay set to the bar AFTER the
 * one that produced the detection, and to null when there is no such bar in the
 * same session. Exits examine only bars at or after entry. The simulator never
 * indexes past the bar it is currently on.
 */

export interface SimBar {
  /** Bar open time, epoch ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface SimSignal {
  barIndex: number;
  nextBarIndex: number | null;
  strategyId: string;
  strategyName: string;
  confidence: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  rulesMatched: string[];
  context: Record<string, unknown> | null;
}

export interface SimTrade {
  sequence: number;
  side: OrderSide;
  entryBarIndex: number;
  entryTime: Date;
  entryPrice: number;
  entryQuantity: number;
  exitBarIndex: number;
  exitTime: Date;
  exitPrice: number;
  exitReason: 'TARGET' | 'STOP' | 'TIMEOUT' | 'SESSION_END' | 'SQUARE_OFF' | 'EXPIRY' | 'RUN_END';
  grossPnl: number;
  fees: number;
  slippageCost: number;
  netPnl: number;
  holdingSeconds: number;
  barsHeld: number;
  cashAfter: number;
  stopPrice: number | null;
  targetPrice: number | null;
  strategyId: string;
  strategyName: string;
  confidence: number;
  strategyReason: string[];
  marketContext: Record<string, unknown> | null;
}

export interface SimEquityPoint {
  sequence: number;
  at: Date;
  cash: number;
  portfolioValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  drawdownPct: number;
  openPositions: number;
}

/** A signal that produced no trade, and the reason. Counted, and the reasons
 *  are tallied so "the strategy never fired" and "the wallet refused it every
 *  time" cannot look the same in the result. */
export interface SimSkip {
  barIndex: number;
  kind: 'REJECTED' | 'SKIPPED';
  reason: string;
}

export interface SimResult {
  trades: SimTrade[];
  equity: SimEquityPoint[];
  skips: SimSkip[];
  finalCash: number;
  finalPortfolioValue: number;
  /** Bars during which at least one position was open. */
  exposedBars: number;
  barsWalked: number;
}

interface OpenPosition {
  side: OrderSide;
  quantity: number;
  avgPrice: number;
  margin: number;
  entryBarIndex: number;
  entryFees: number;
  entrySlippage: number;
  stop: number | null;
  target: number | null;
  signal: SimSignal;
}

export function simulate(
  bars: SimBar[],
  signals: SimSignal[],
  cfg: BacktestConfig,
  instrument: Instrument,
): SimResult {
  const signalByBar = new Map<number, SimSignal>();
  for (const s of signals) signalByBar.set(s.barIndex, s);

  const dayKeys = bars.map((b) => istDayKey(new Date(b.t)));
  const minuteOfDay = bars.map((b) => istMinuteOfDay(new Date(b.t)));
  const isSessionLastBar = bars.map((_, i) => i === bars.length - 1 || dayKeys[i + 1] !== dayKeys[i]);

  const lotSize = Math.max(1, instrument.lotSize);

  let cash = cfg.initialCapital;
  let blockedMargin = 0;
  let realizedPnl = 0;
  let peak = cfg.initialCapital;

  const open: OpenPosition[] = [];
  const trades: SimTrade[] = [];
  const equity: SimEquityPoint[] = [];
  const skips: SimSkip[] = [];

  const ordersToday = new Map<string, number>();
  const realizedToday = new Map<string, number>();
  /** Bar index before which no new entry may be taken (cooldown). */
  let armedFrom = 0;
  let exposedBars = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const day = dayKeys[i];

    // ── 1. EXITS FIRST ────────────────────────────────────────────────────
    // Before anything else, because an entry taken on this bar must not be
    // blocked by a position this same bar is about to close, and because the
    // daily-loss gate below must see this bar's realized result.
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p];
      const exit = resolveExit(bar, i, pos, cfg, {
        isSessionLastBar: isSessionLastBar[i],
        minuteOfDay: minuteOfDay[i],
        isLastBar: i === bars.length - 1,
      });
      if (!exit) continue;

      const closed = closePosition(pos, exit.price, exit.reason, i, bars, cfg, trades.length + 1);
      open.splice(p, 1);

      // Release the margin, book the P&L, pay the exit costs. Mirrors the paper
      // wallet's own `cashBalance` movement: margin back, realized in, charges
      // out. Across the round trip the margin nets to zero, so the account moves
      // by exactly `netPnl` — which is the identity `cashAfter` lets a reader
      // check against the trade table without trusting this comment.
      cash += pos.margin + closed.realizedGross - closed.exitFees - closed.exitSlippage;
      blockedMargin -= pos.margin;
      realizedPnl += closed.trade.netPnl;
      realizedToday.set(day, (realizedToday.get(day) ?? 0) + closed.trade.netPnl);
      closed.trade.cashAfter = round2(cash);
      trades.push(closed.trade);
      armedFrom = i + 1 + cfg.cooldownBars;
    }

    // ── 2. ENTRY ──────────────────────────────────────────────────────────
    // The signal that fires an entry on THIS bar is the one detected on the
    // PREVIOUS bar — `nextBarIndex === i`. Reading `signalByBar.get(i)` and
    // filling at this bar's open would be filling on the signal bar itself.
    const firing = signalByBar.get(i - 1);
    if (firing && firing.nextBarIndex === i) {
      const refusal = mayEnter(firing, {
        i,
        armedFrom,
        openCount: open.length,
        ordersToday: ordersToday.get(day) ?? 0,
        realizedToday: realizedToday.get(day) ?? 0,
        minuteOfDay: minuteOfDay[i],
        isSessionLastBar: isSessionLastBar[i],
        cfg,
      });
      if (refusal) {
        skips.push({ barIndex: i, kind: refusal.kind, reason: refusal.reason });
      } else {
        const side: OrderSide = firing.bias === 'bullish' ? 'BUY' : 'SELL';
        // The bar's own opening print. Slippage is modelled as a COST against
        // this price rather than folded into it, so the trade's entry/exit
        // columns keep showing what the market actually printed and the cost of
        // getting filled stays a line a reader can see and question.
        const entryPrice = bar.o;
        const stop = computeStop(bars, i, side, entryPrice, cfg);
        const quantity = sizePosition({
          cfg,
          equityNow: cash + blockedMargin + unrealized(open, bar.c),
          price: entryPrice,
          stop,
          lotSize,
        });

        if (quantity <= 0) {
          skips.push({ barIndex: i, kind: 'SKIPPED', reason: 'Position size rounded to zero at this price.' });
        } else {
          const margin = safeMargin(instrument, side, cfg, entryPrice, quantity);
          const fees = round2(entryPrice * quantity * cfg.feeRate);
          const slippage = round2(entryPrice * quantity * cfg.slippageRate);
          if (margin === null) {
            skips.push({ barIndex: i, kind: 'REJECTED', reason: 'Margin is not computable for this contract.' });
          } else if (margin + fees + slippage > cash) {
            skips.push({
              barIndex: i,
              kind: 'REJECTED',
              reason: `Insufficient funds: ${fmt(margin + fees + slippage)} required against ${fmt(cash)} free.`,
            });
          } else {
            cash -= margin + fees + slippage;
            blockedMargin += margin;
            ordersToday.set(day, (ordersToday.get(day) ?? 0) + 1);
            open.push({
              side,
              quantity,
              avgPrice: entryPrice,
              margin,
              entryBarIndex: i,
              entryFees: fees,
              entrySlippage: slippage,
              stop,
              target: stop === null ? null : entryPrice + (entryPrice - stop) * cfg.rewardRisk,
              signal: firing,
            });
          }
        }
      }
    }

    // ── 3. MARK TO MARKET ─────────────────────────────────────────────────
    if (open.length) exposedBars++;
    const unreal = unrealized(open, bar.c);
    const portfolioValue = cash + blockedMargin + unreal;
    peak = Math.max(peak, portfolioValue);
    equity.push({
      sequence: i,
      at: new Date(bar.t),
      cash: round2(cash),
      portfolioValue: round2(portfolioValue),
      realizedPnl: round2(realizedPnl),
      unrealizedPnl: round2(unreal),
      drawdownPct: peak > 0 ? round4(((peak - portfolioValue) / peak) * 100) : 0,
      openPositions: open.length,
    });
  }

  return {
    trades,
    equity,
    skips,
    finalCash: round2(cash),
    finalPortfolioValue: equity.length ? equity[equity.length - 1].portfolioValue : cfg.initialCapital,
    exposedBars,
    barsWalked: bars.length,
  };
}

// ─────────────────────────────────────────────────────────────── exit rules

function resolveExit(
  bar: SimBar,
  i: number,
  pos: OpenPosition,
  cfg: BacktestConfig,
  ctx: { isSessionLastBar: boolean; minuteOfDay: number; isLastBar: boolean },
): { price: number; reason: SimTrade['exitReason'] } | null {
  const long = pos.side === 'BUY';

  // Square-off is TIME-based and therefore known before the bar prints, so it
  // acts at the open. Checked first: a position the clock has already closed
  // must not be credited with a target the rest of that bar happened to reach.
  if (cfg.intradayOnly && ctx.minuteOfDay >= cfg.squareOffMinute && i > pos.entryBarIndex) {
    return { price: bar.o, reason: 'SQUARE_OFF' };
  }

  if (pos.stop !== null) {
    // A gap through the stop fills at the open, not at the stop. This is the
    // difference between a modelled stop and a real one.
    if (long && bar.o <= pos.stop) return { price: bar.o, reason: 'STOP' };
    if (!long && bar.o >= pos.stop) return { price: bar.o, reason: 'STOP' };
    // Stop before target within the same bar — the pessimistic reading.
    if (long && bar.l <= pos.stop) return { price: pos.stop, reason: 'STOP' };
    if (!long && bar.h >= pos.stop) return { price: pos.stop, reason: 'STOP' };
  }
  if (pos.target !== null) {
    if (long && bar.o >= pos.target) return { price: bar.o, reason: 'TARGET' };
    if (!long && bar.o <= pos.target) return { price: bar.o, reason: 'TARGET' };
    if (long && bar.h >= pos.target) return { price: pos.target, reason: 'TARGET' };
    if (!long && bar.l <= pos.target) return { price: pos.target, reason: 'TARGET' };
  }

  if (cfg.timeoutBars > 0 && i - pos.entryBarIndex >= cfg.timeoutBars) {
    return { price: bar.c, reason: 'TIMEOUT' };
  }
  if (cfg.intradayOnly && ctx.isSessionLastBar) return { price: bar.c, reason: 'SESSION_END' };
  // The window ended with the position still open. Marked out at the last close
  // and labelled as such, rather than left out of the trade list — an unclosed
  // position that never appears is P&L the result silently omits.
  if (ctx.isLastBar) return { price: bar.c, reason: 'RUN_END' };
  return null;
}

function closePosition(
  pos: OpenPosition,
  exitPrice: number,
  reason: SimTrade['exitReason'],
  exitBarIndex: number,
  bars: SimBar[],
  cfg: BacktestConfig,
  sequence: number,
): { trade: SimTrade; realizedGross: number; exitFees: number; exitSlippage: number } {
  const closingSide: OrderSide = pos.side === 'BUY' ? 'SELL' : 'BUY';

  // The SAME average-price/realized-P&L arithmetic the paper engine books on
  // every real fill — imported, not reimplemented. Signed quantity carries the
  // direction, which is why a short's gross comes out negative when price rises.
  const { realizedPnlDelta } = applyFill(
    pos.side === 'BUY' ? pos.quantity : -pos.quantity,
    pos.avgPrice,
    closingSide,
    pos.quantity,
    exitPrice,
  );

  const exitFees = round2(exitPrice * pos.quantity * cfg.feeRate);
  const exitSlippage = round2(exitPrice * pos.quantity * cfg.slippageRate);
  const fees = round2(pos.entryFees + exitFees);
  const slippageCost = round2(pos.entrySlippage + exitSlippage);

  const entryBar = bars[pos.entryBarIndex];
  const exitBar = bars[exitBarIndex];

  return {
    realizedGross: realizedPnlDelta,
    exitFees,
    exitSlippage,
    trade: {
      sequence,
      side: pos.side,
      entryBarIndex: pos.entryBarIndex,
      entryTime: new Date(entryBar.t),
      entryPrice: round2(pos.avgPrice),
      entryQuantity: pos.quantity,
      exitBarIndex,
      exitTime: new Date(exitBar.t),
      exitPrice: round2(exitPrice),
      exitReason: reason,
      // Gross is measured at the prices the market printed, so it reconciles
      // with the entry/exit columns beside it. Execution friction is then
      // subtracted explicitly.
      grossPnl: round2(realizedPnlDelta),
      fees,
      slippageCost,
      // THE IDENTITY: gross - fees - slippage = net, exactly, for every trade.
      // Pinned in the unit tests. A P&L that subtracts (exit - entry) and waves
      // at costs afterwards is the single easiest way to make a losing strategy
      // look profitable, so the arithmetic is stated once and asserted.
      netPnl: round2(realizedPnlDelta - fees - slippageCost),
      holdingSeconds: Math.round((exitBar.t - entryBar.t) / 1000),
      barsHeld: exitBarIndex - pos.entryBarIndex,
      cashAfter: 0, // set by the caller once the wallet has moved
      stopPrice: pos.stop === null ? null : round2(pos.stop),
      targetPrice: pos.target === null ? null : round2(pos.target),
      strategyId: pos.signal.strategyId,
      strategyName: pos.signal.strategyName,
      confidence: pos.signal.confidence,
      strategyReason: pos.signal.rulesMatched,
      marketContext: pos.signal.context,
    },
  };
}

// ────────────────────────────────────────────────────────────── entry gates

/**
 * The same shape `evaluatePolicy` has in the paper loop: every check can only
 * subtract, and the first refusal is the reason. Kept as its own function so a
 * gate can be asserted without running a whole simulation.
 */
export function mayEnter(
  signal: SimSignal,
  ctx: {
    i: number;
    armedFrom: number;
    openCount: number;
    ordersToday: number;
    realizedToday: number;
    minuteOfDay: number;
    isSessionLastBar: boolean;
    cfg: BacktestConfig;
  },
): { kind: SimSkip['kind']; reason: string } | null {
  const { cfg } = ctx;
  if (signal.bias === 'neutral') return { kind: 'SKIPPED', reason: 'No directional bias.' };
  if (signal.bias === 'bearish' && !cfg.allowShort) {
    return { kind: 'SKIPPED', reason: 'Bearish signal, and short entries are disabled.' };
  }
  if (ctx.i < ctx.armedFrom) return { kind: 'SKIPPED', reason: 'Within the post-trade cooldown.' };
  if (ctx.openCount >= cfg.maxOpenPositions) {
    return { kind: 'REJECTED', reason: `Already holding ${ctx.openCount} of ${cfg.maxOpenPositions} allowed positions.` };
  }
  if (ctx.ordersToday >= cfg.maxOrdersPerDay) {
    return { kind: 'REJECTED', reason: `Daily order cap of ${cfg.maxOrdersPerDay} reached.` };
  }
  if (ctx.realizedToday <= -Math.abs(cfg.maxLossPerDay)) {
    return { kind: 'REJECTED', reason: `Daily loss limit of ${fmt(cfg.maxLossPerDay)} reached.` };
  }
  if (cfg.intradayOnly && ctx.minuteOfDay >= cfg.squareOffMinute) {
    return { kind: 'SKIPPED', reason: 'At or past the square-off minute; entries are closed for the day.' };
  }
  // Entering on the last bar of a session opens something the very next rule
  // closes at the same price, booking two sets of charges to learn nothing.
  if (cfg.intradayOnly && ctx.isSessionLastBar) {
    return { kind: 'SKIPPED', reason: 'Last bar of the session — no time to hold the position.' };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────── sizing

export function sizePosition(input: {
  cfg: BacktestConfig;
  equityNow: number;
  price: number;
  stop: number | null;
  lotSize: number;
}): number {
  const { cfg, equityNow, price, stop, lotSize } = input;
  if (!(price > 0)) return 0;

  let raw: number;
  switch (cfg.sizingMode) {
    case 'FIXED_QUANTITY':
      raw = cfg.sizingValue;
      break;
    case 'FIXED_LOTS':
      raw = cfg.sizingValue * lotSize;
      break;
    case 'CAPITAL_PCT':
      // Compounding: sized off equity as it stands, not off the opening
      // balance. A strategy that halves the account must start trading smaller,
      // or the drawdown it reports is not one it could have survived.
      raw = ((equityNow * cfg.sizingValue) / 100) / price;
      break;
    case 'RISK_PCT': {
      if (stop === null) return 0; // risk-based sizing needs a defined risk
      const perUnit = Math.abs(price - stop);
      if (!(perUnit > 0)) return 0;
      raw = ((equityNow * cfg.sizingValue) / 100) / perUnit;
      break;
    }
    default:
      return 0;
  }
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // Whole lots only. A fractional lot is not an order any exchange would take.
  return Math.floor(raw / lotSize) * lotSize;
}

export function computeStop(
  bars: SimBar[],
  entryBarIndex: number,
  side: OrderSide,
  entryPrice: number,
  cfg: BacktestConfig,
): number | null {
  if (cfg.stopMode === 'NONE') return null;
  if (cfg.stopMode === 'PERCENT') {
    return side === 'BUY' ? entryPrice * (1 - cfg.stopPct) : entryPrice * (1 + cfg.stopPct);
  }
  // SIGNAL_BAR: the extreme of the bar that produced the signal — the bar
  // BEFORE the entry bar. Using the entry bar's own low would be a stop set
  // from a bar that is still forming when the fill happens.
  const signalBar = bars[entryBarIndex - 1];
  if (!signalBar) return null;
  const level = side === 'BUY' ? signalBar.l : signalBar.h;
  // A stop on the wrong side of the fill (the bar gapped past it) is not a
  // stop. Refusing to invent one means the trade is skipped by the sizer.
  if (side === 'BUY' && level >= entryPrice) return null;
  if (side === 'SELL' && level <= entryPrice) return null;
  return level;
}

// ──────────────────────────────────────────────────────────────── utilities

/**
 * Slippage cost for one leg, in rupees.
 *
 * Always a positive cost, never a signed adjustment: a buy pays more and a sell
 * receives less, and both are the same subtraction from the result. Modelling it
 * as a cost rather than a shifted fill price is what keeps the trade table's
 * entry and exit columns showing prices a reader can look up on the chart.
 */
export function slippageCost(price: number, quantity: number, rate: number): number {
  return round2(price * quantity * rate);
}

function unrealized(open: OpenPosition[], mark: number): number {
  let total = 0;
  for (const p of open) {
    const direction = p.side === 'BUY' ? 1 : -1;
    total += (mark - p.avgPrice) * p.quantity * direction;
  }
  return total;
}

/**
 * `computeMargin` throws when it cannot value a short option's underlying —
 * deliberately, because the alternative is under-margining by orders of
 * magnitude. Here that is a rejected signal, not a failed backtest.
 */
function safeMargin(
  instrument: Instrument,
  side: OrderSide,
  cfg: BacktestConfig,
  price: number,
  quantity: number,
): number | null {
  try {
    return round2(computeMargin(instrument, side, cfg.productType, price, quantity));
  } catch {
    return null;
  }
}

/** IST minute-of-day. IST is UTC+5:30 with no daylight saving, ever. */
export function istMinuteOfDay(at: Date): number {
  const ist = new Date(at.getTime() + 5.5 * 3_600_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}
function fmt(n: number): string {
  return `₹${round2(n).toLocaleString('en-IN')}`;
}
