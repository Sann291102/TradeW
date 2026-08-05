import { Candle } from '@tradew/types';

/**
 * Market structure, liquidity behaviour and continuation/reversal reads.
 *
 * Pure, deterministic, dependency-free — the same shape as `indicators.ts`,
 * and for the same reason: this is the layer that decides what Sentinel
 * *understands* about market behaviour rather than what an indicator prints,
 * and it must be verifiable without a container, a feed or a database.
 *
 * The distinction this module exists to make: an indicator says RSI is 62.
 * Structure says price has made a higher high and a higher low, took out the
 * liquidity resting above the previous swing, and continued — which is a
 * behaviour, not a number. Sentinel's mandate is to explain the second.
 *
 * Every function here returns its evidence alongside its conclusion. Nothing
 * in this module may produce a read that cannot be shown to a trader.
 */

// ---------------------------------------------------------------------------
// Swing points — the primitive everything else is built on.
// ---------------------------------------------------------------------------

export interface SwingPoint {
  index: number;
  price: number;
  timestamp: Date;
  kind: 'high' | 'low';
}

/**
 * Fractal swing detection.
 *
 * A swing high needs `strength` bars on BOTH sides with strictly lower highs.
 * Strictness matters: with `>=` a flat run of identical highs registers every
 * bar as a swing, and the structure sequence downstream becomes noise. This
 * also means the last `strength` bars can never be swings — deliberately, as
 * an unconfirmed swing is a guess about bars that have not printed yet.
 */
export function findSwings(candles: Candle[], strength = 2): SwingPoint[] {
  const out: SwingPoint[] = [];
  if (candles.length < strength * 2 + 1) return out;

  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= strength; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: candles[i].high, timestamp: candles[i].timestamp, kind: 'high' });
    if (isLow) out.push({ index: i, price: candles[i].low, timestamp: candles[i].timestamp, kind: 'low' });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Structure — what the sequence of swings says.
// ---------------------------------------------------------------------------

export type StructureState =
  | 'uptrend' // higher highs and higher lows
  | 'downtrend' // lower highs and lower lows
  | 'range' // neither sequence holds
  | 'undefined'; // not enough confirmed swings to say

/** A break of the prior swing in the direction of trend — continuation. */
export type StructureEventKind = 'break-of-structure' | 'change-of-character' | null;

export interface MarketStructure {
  state: StructureState;
  /** The most recent structural event, when one is present in the window. */
  event: StructureEventKind;
  /** Direction the event implies, if any. */
  eventDirection: 'bullish' | 'bearish' | null;
  lastSwingHigh: SwingPoint | null;
  lastSwingLow: SwingPoint | null;
  evidence: string[];
}

/**
 * Classify structure from confirmed swings.
 *
 * Uses the last two highs and last two lows. Two of each is the minimum that
 * can express a *sequence* — one of each only describes a position, and a
 * position is not a structure.
 *
 * The two events are deliberately distinguished because they mean opposite
 * things despite looking identical on a chart:
 *  - **Break of structure** continues the existing trend (a higher high in an
 *    uptrend).
 *  - **Change of character** breaks it (a higher high while in a *downtrend*),
 *    and is the earliest structural evidence of a reversal.
 * Collapsing them into "a level broke" loses exactly the information a trader
 * needs.
 */
export function analyseStructure(candles: Candle[], strength = 2): MarketStructure {
  const swings = findSwings(candles, strength);
  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');
  const lastSwingHigh = highs[highs.length - 1] ?? null;
  const lastSwingLow = lows[lows.length - 1] ?? null;
  const evidence: string[] = [];

  if (highs.length < 2 || lows.length < 2) {
    return {
      state: 'undefined',
      event: null,
      eventDirection: null,
      lastSwingHigh,
      lastSwingLow,
      evidence: ['Not enough confirmed swing points to describe a structure'],
    };
  }

  const [prevHigh, currHigh] = highs.slice(-2);
  const [prevLow, currLow] = lows.slice(-2);
  const higherHigh = currHigh.price > prevHigh.price;
  const higherLow = currLow.price > prevLow.price;

  let state: StructureState;
  if (higherHigh && higherLow) {
    state = 'uptrend';
    evidence.push(
      `Higher high ${currHigh.price.toFixed(1)} over ${prevHigh.price.toFixed(1)}, higher low ${currLow.price.toFixed(1)} over ${prevLow.price.toFixed(1)}`,
    );
  } else if (!higherHigh && !higherLow) {
    state = 'downtrend';
    evidence.push(
      `Lower high ${currHigh.price.toFixed(1)} under ${prevHigh.price.toFixed(1)}, lower low ${currLow.price.toFixed(1)} under ${prevLow.price.toFixed(1)}`,
    );
  } else {
    state = 'range';
    evidence.push(
      `Mixed sequence — ${higherHigh ? 'higher high' : 'lower high'} with a ${higherLow ? 'higher low' : 'lower low'}; no directional structure`,
    );
  }

  // A structural event is judged from where price is now relative to the last
  // confirmed swing, not from the swing sequence alone.
  const last = candles[candles.length - 1];
  let event: StructureEventKind = null;
  let eventDirection: 'bullish' | 'bearish' | null = null;

  if (lastSwingHigh && last.close > lastSwingHigh.price) {
    event = state === 'downtrend' ? 'change-of-character' : 'break-of-structure';
    eventDirection = 'bullish';
    evidence.push(
      event === 'change-of-character'
        ? `Close ${last.close.toFixed(1)} broke above swing high ${lastSwingHigh.price.toFixed(1)} while in a downtrend — character change`
        : `Close ${last.close.toFixed(1)} broke above swing high ${lastSwingHigh.price.toFixed(1)} — structure continuing`,
    );
  } else if (lastSwingLow && last.close < lastSwingLow.price) {
    event = state === 'uptrend' ? 'change-of-character' : 'break-of-structure';
    eventDirection = 'bearish';
    evidence.push(
      event === 'change-of-character'
        ? `Close ${last.close.toFixed(1)} broke below swing low ${lastSwingLow.price.toFixed(1)} while in an uptrend — character change`
        : `Close ${last.close.toFixed(1)} broke below swing low ${lastSwingLow.price.toFixed(1)} — structure continuing`,
    );
  }

  return { state, event, eventDirection, lastSwingHigh, lastSwingLow, evidence };
}

// ---------------------------------------------------------------------------
// Liquidity behaviour.
// ---------------------------------------------------------------------------

export interface LiquidityPool {
  price: number;
  side: 'above' | 'below';
  /** How many swing points cluster at this level. */
  touches: number;
  /** True once price has traded through it and closed back on the origin side. */
  swept: boolean;
}

export interface LiquidityRead {
  pools: LiquidityPool[];
  /** A sweep that has just occurred — the stop-hunt signature. */
  recentSweep: { side: 'above' | 'below'; price: number; reclaimed: boolean } | null;
  evidence: string[];
}

/**
 * Equal highs/lows are where stops rest, and where price goes to find them.
 *
 * `tolerancePct` clusters swings that are "the same level" to a trader's eye.
 * Expressed as a percentage rather than points so it holds across a 24 000
 * index and a 400 stock — an absolute tolerance would treat every NIFTY swing
 * as equal and no stock swing as equal.
 */
export function analyseLiquidity(candles: Candle[], tolerancePct = 0.05, strength = 2): LiquidityRead {
  const swings = findSwings(candles, strength);
  const evidence: string[] = [];
  if (swings.length === 0 || candles.length === 0) {
    return { pools: [], recentSweep: null, evidence: ['No confirmed swings from which to read liquidity'] };
  }

  const last = candles[candles.length - 1];
  const pools: LiquidityPool[] = [];

  for (const side of ['high', 'low'] as const) {
    const points = swings.filter((s) => s.kind === side);
    const used = new Set<number>();
    for (let i = 0; i < points.length; i++) {
      if (used.has(i)) continue;
      const cluster = [points[i]];
      used.add(i);
      for (let j = i + 1; j < points.length; j++) {
        if (used.has(j)) continue;
        const diffPct = (Math.abs(points[j].price - points[i].price) / points[i].price) * 100;
        if (diffPct <= tolerancePct) {
          cluster.push(points[j]);
          used.add(j);
        }
      }
      // A single swing is a level, not a pool. Stops cluster where price has
      // turned more than once at the same place.
      if (cluster.length < 2) continue;
      const price = cluster.reduce((s, p) => s + p.price, 0) / cluster.length;
      const swept = side === 'high' ? last.high > price : last.low < price;
      pools.push({ price, side: side === 'high' ? 'above' : 'below', touches: cluster.length, swept });
    }
  }

  pools.sort((a, b) => b.touches - a.touches);
  for (const pool of pools.slice(0, 3)) {
    evidence.push(
      `${pool.touches} swings clustered at ${pool.price.toFixed(1)} (${pool.side} price) — resting liquidity${pool.swept ? ', already swept' : ''}`,
    );
  }

  const recentSweep = detectSweep(candles);
  if (recentSweep) {
    evidence.push(
      recentSweep.reclaimed
        ? `Price swept ${recentSweep.side === 'above' ? 'above' : 'below'} ${recentSweep.price.toFixed(1)} and closed back inside — liquidity taken, level reclaimed`
        : `Price traded ${recentSweep.side === 'above' ? 'above' : 'below'} ${recentSweep.price.toFixed(1)} and held beyond it — acceptance, not a sweep`,
    );
  }

  return { pools, recentSweep, evidence };
}

/**
 * The stop-hunt signature: a wick beyond a prior extreme that closes back
 * inside.
 *
 * `reclaimed` is the whole distinction. Trading beyond a level and *closing*
 * beyond it is acceptance — the market genuinely revalued. Trading beyond and
 * closing back inside is a sweep — the move existed only to reach stops. The
 * two look identical until the bar closes, which is why this reads closes and
 * never intrabar highs alone.
 */
export function detectSweep(
  candles: Candle[],
  lookback = 20,
): { side: 'above' | 'below'; price: number; reclaimed: boolean } | null {
  if (candles.length < 5) return null;
  const last = candles[candles.length - 1];
  const window = candles.slice(-(lookback + 1), -1);
  if (window.length < 3) return null;

  const priorHigh = Math.max(...window.map((c) => c.high));
  const priorLow = Math.min(...window.map((c) => c.low));

  if (last.high > priorHigh) {
    return { side: 'above', price: priorHigh, reclaimed: last.close < priorHigh };
  }
  if (last.low < priorLow) {
    return { side: 'below', price: priorLow, reclaimed: last.close > priorLow };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Continuation vs reversal.
// ---------------------------------------------------------------------------

export type BehaviourRead = 'continuation' | 'reversal-risk' | 'indecision' | 'undefined';

export interface MarketBehaviour {
  read: BehaviourRead;
  direction: 'bullish' | 'bearish' | 'neutral';
  /** 0..1 — how strongly the evidence supports this read. Never a prediction. */
  strength: number;
  evidence: string[];
}

/**
 * Synthesise structure, liquidity and participation into a behaviour read.
 *
 * Explicitly NOT a forecast. `read` describes what the market is currently
 * doing — continuing, showing reversal risk, or undecided — which is an
 * observation about present evidence. Master Plan principle 2 forbids
 * predicting where price will be; naming the current behaviour is not that,
 * and the vocabulary here is chosen to stay on the correct side of it
 * ("reversal-risk", never "will reverse").
 */
export function readBehaviour(
  structure: MarketStructure,
  liquidity: LiquidityRead,
  opts: { volumeVsAvg: number | null; momentumScore: number | null },
): MarketBehaviour {
  const evidence: string[] = [...structure.evidence];
  let score = 0;
  let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';

  if (structure.state === 'undefined') {
    return { read: 'undefined', direction: 'neutral', strength: 0, evidence };
  }

  // Structural event dominates: a change of character is the single most
  // informative thing in this module.
  if (structure.event === 'change-of-character' && structure.eventDirection) {
    direction = structure.eventDirection;
    score += 0.45;
    evidence.push('Change of character is the earliest structural evidence that the prior trend is failing');
  } else if (structure.event === 'break-of-structure' && structure.eventDirection) {
    direction = structure.eventDirection;
    score += 0.35;
  } else if (structure.state === 'uptrend') {
    direction = 'bullish';
    score += 0.2;
  } else if (structure.state === 'downtrend') {
    direction = 'bearish';
    score += 0.2;
  }

  // A reclaimed sweep against the structural direction is the classic
  // reversal-risk signature; in the same direction it is fuel for continuation.
  const sweep = liquidity.recentSweep;
  if (sweep?.reclaimed) {
    const sweepImplies = sweep.side === 'above' ? 'bearish' : 'bullish';
    if (direction !== 'neutral' && sweepImplies !== direction) {
      score += 0.15;
      evidence.push(`Reclaimed sweep ${sweep.side} ${sweep.price.toFixed(1)} runs against the structural read — participation is being trapped`);
    } else {
      score += 0.1;
      evidence.push(`Reclaimed sweep ${sweep.side} ${sweep.price.toFixed(1)} cleared resting liquidity ahead of the structural direction`);
    }
  }

  if (opts.volumeVsAvg !== null) {
    if (opts.volumeVsAvg >= 1.3) {
      score += 0.2;
      evidence.push(`Volume at ${(opts.volumeVsAvg * 100).toFixed(0)}% of the 20-bar average — participation is confirming the move`);
    } else if (opts.volumeVsAvg < 0.7) {
      score -= 0.15;
      evidence.push(`Volume at ${(opts.volumeVsAvg * 100).toFixed(0)}% of the 20-bar average — the move is not being participated in`);
    }
  }

  if (opts.momentumScore !== null) {
    if (opts.momentumScore >= 0.65) score += 0.15;
    else if (opts.momentumScore <= 0.35) score -= 0.1;
    evidence.push(`Directional persistence ${(opts.momentumScore * 100).toFixed(0)}%`);
  }

  const strength = Math.max(0, Math.min(1, score));

  let read: BehaviourRead;
  if (structure.state === 'range' && !structure.event) {
    read = 'indecision';
    direction = 'neutral';
  } else if (structure.event === 'change-of-character') {
    read = 'reversal-risk';
  } else if (strength < 0.35) {
    read = 'indecision';
  } else {
    read = 'continuation';
  }

  return { read, direction, strength: Number(strength.toFixed(3)), evidence };
}
