import type { Candle } from '@tradew/types';

/**
 * Pure chart geometry — swing structure, levels, zones, gaps and Fibonacci.
 *
 * Dependency-free and deterministic, exactly like `intelligence/indicators.ts`,
 * and for the same reason: this is the layer whose output a trader sees drawn
 * on their chart, so every line has to be reproducible from the bars alone and
 * testable without mounting anything.
 *
 * Nothing here decides *whether* to draw. These functions find structure; the
 * annotation engine decides what is worth showing and attaches the rule and
 * the reasoning. Keeping that seam means the geometry can be unit-tested
 * against known bar sequences without any knowledge-base wiring.
 */

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  kind: 'high' | 'low';
  /** Bars of clearance on the weaker side — how pronounced the pivot is. */
  strength: number;
}

export interface PriceLevel {
  price: number;
  kind: 'support' | 'resistance';
  /** Swing points that formed this level. */
  touches: SwingPoint[];
  /** First and last time price interacted with it. */
  firstTime: number;
  lastTime: number;
  /** 0..1 — touches, recency and tightness of the cluster. */
  strength: number;
}

export interface Zone {
  top: number;
  bottom: number;
  startTime: number;
  endTime: number;
  kind: 'supply' | 'demand';
  /** The impulse move (in %) that left this zone behind. */
  impulsePct: number;
  /** True while price has not traded back through it. */
  unmitigated: boolean;
  startIndex: number;
}

export interface LiquidityPool {
  price: number;
  kind: 'buy-side' | 'sell-side';
  /** The swing points that line up at this level. */
  points: SwingPoint[];
  startTime: number;
  endTime: number;
  /** True once price has traded through the level. */
  swept: boolean;
}

export interface FairValueGap {
  top: number;
  bottom: number;
  time: number;
  index: number;
  direction: 'bullish' | 'bearish';
  /** True while price has not traded back into the gap. */
  unmitigated: boolean;
}

export interface TrendLine {
  from: SwingPoint;
  to: SwingPoint;
  /** Price per millisecond. */
  slope: number;
  kind: 'ascending' | 'descending';
  /** Swing points that also sit on the line, beyond the two that define it. */
  confirmations: number;
  /** Projected price at an arbitrary time. */
  priceAt: (time: number) => number;
}

export interface FibonacciLevels {
  /** Start of the measured leg. */
  from: SwingPoint;
  /** End of the measured leg. */
  to: SwingPoint;
  direction: 'up' | 'down';
  levels: { ratio: number; price: number; label: string }[];
}

/**
 * Fractal swing detection.
 *
 * A pivot high is a bar whose high exceeds the `lookback` bars on both sides.
 * The last `lookback` bars can never qualify — their right side has not formed
 * yet — and including them would repaint every level as new bars arrive, which
 * is the single most common way an indicator lies about its own history.
 */
export function findSwings(candles: Candle[], lookback = 3): SwingPoint[] {
  const out: SwingPoint[] = [];
  if (candles.length < lookback * 2 + 1) return out;

  for (let i = lookback; i < candles.length - lookback; i++) {
    const bar = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= bar.high || candles[i + j].high >= bar.high) isHigh = false;
      if (candles[i - j].low <= bar.low || candles[i + j].low <= bar.low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) {
      out.push({ index: i, time: bar.timestamp.getTime(), price: bar.high, kind: 'high', strength: clearance(candles, i, lookback, 'high') });
    }
    if (isLow) {
      out.push({ index: i, time: bar.timestamp.getTime(), price: bar.low, kind: 'low', strength: clearance(candles, i, lookback, 'low') });
    }
  }
  return out;
}

/** Bars either side that the pivot clears, capped at 10 — a strength proxy. */
function clearance(candles: Candle[], index: number, lookback: number, kind: 'high' | 'low'): number {
  const pivot = kind === 'high' ? candles[index].high : candles[index].low;
  let left = 0;
  let right = 0;
  for (let j = index - 1; j >= 0 && j >= index - 10; j--) {
    const value = kind === 'high' ? candles[j].high : candles[j].low;
    if (kind === 'high' ? value >= pivot : value <= pivot) break;
    left++;
  }
  for (let j = index + 1; j < candles.length && j <= index + 10; j++) {
    const value = kind === 'high' ? candles[j].high : candles[j].low;
    if (kind === 'high' ? value >= pivot : value <= pivot) break;
    right++;
  }
  return Math.min(left, right);
}

/**
 * Cluster swing points into horizontal levels.
 *
 * `tolerancePct` is a *percentage* of price, not an absolute figure: 20 points
 * is a tight cluster on BANKNIFTY and an enormous one on a ₹200 stock, and a
 * fixed tolerance would produce useless levels on one or the other.
 */
export function findLevels(swings: SwingPoint[], tolerancePct = 0.15, minTouches = 2): PriceLevel[] {
  const levels: PriceLevel[] = [];

  for (const kind of ['high', 'low'] as const) {
    const points = swings.filter((s) => s.kind === kind).sort((a, b) => a.price - b.price);
    let cluster: SwingPoint[] = [];

    const flush = () => {
      if (cluster.length < minTouches) {
        cluster = [];
        return;
      }
      const prices = cluster.map((c) => c.price);
      const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
      const times = cluster.map((c) => c.time);
      const spreadPct = mean > 0 ? ((Math.max(...prices) - Math.min(...prices)) / mean) * 100 : 0;

      levels.push({
        price: mean,
        kind: kind === 'high' ? 'resistance' : 'support',
        touches: [...cluster],
        firstTime: Math.min(...times),
        lastTime: Math.max(...times),
        // Touch count dominates, tightness of the cluster refines. A level
        // touched four times is materially stronger than one touched twice.
        strength: Math.min(
          1,
          (Math.min(cluster.length, 5) / 5) * 0.7 + (1 - Math.min(1, spreadPct / tolerancePct)) * 0.3,
        ),
      });
      cluster = [];
    };

    for (const point of points) {
      if (cluster.length === 0) {
        cluster.push(point);
        continue;
      }
      const anchor = cluster[0].price;
      if (anchor > 0 && (Math.abs(point.price - anchor) / anchor) * 100 <= tolerancePct) {
        cluster.push(point);
      } else {
        flush();
        cluster.push(point);
      }
    }
    flush();
  }

  return levels.sort((a, b) => b.strength - a.strength);
}

/**
 * Supply and demand zones: the consolidation a large move originated from.
 *
 * The zone is the base — the tight bars immediately preceding an impulse — not
 * the impulse itself. That is the whole idea: the base is where unfilled orders
 * were left behind when price left in a hurry, which is why price often reacts
 * on the return.
 */
export function findZones(
  candles: Candle[],
  opts: { impulseThresholdPct?: number; maxBaseBars?: number; lookback?: number } = {},
): Zone[] {
  const impulseThresholdPct = opts.impulseThresholdPct ?? 0.6;
  const maxBaseBars = opts.maxBaseBars ?? 3;
  const lookback = opts.lookback ?? 120;

  const zones: Zone[] = [];
  const start = Math.max(1, candles.length - lookback);

  for (let i = start; i < candles.length; i++) {
    const bar = candles[i];
    if (bar.open === 0) continue;
    const movePct = ((bar.close - bar.open) / bar.open) * 100;
    if (Math.abs(movePct) < impulseThresholdPct) continue;

    // Walk back over the base: bars materially smaller than the impulse.
    const impulseRange = Math.abs(bar.high - bar.low);
    const baseBars: Candle[] = [];
    for (let j = i - 1; j >= 0 && baseBars.length < maxBaseBars; j--) {
      const candidate = candles[j];
      if (Math.abs(candidate.high - candidate.low) > impulseRange * 0.6) break;
      baseBars.unshift(candidate);
    }
    if (baseBars.length === 0) continue;

    const top = Math.max(...baseBars.map((c) => c.high));
    const bottom = Math.min(...baseBars.map((c) => c.low));
    const kind = movePct > 0 ? 'demand' : 'supply';

    // Mitigation: has price traded back into the zone since it formed?
    const after = candles.slice(i + 1);
    const unmitigated = !after.some((c) => c.low <= top && c.high >= bottom);

    zones.push({
      top,
      bottom,
      startTime: baseBars[0].timestamp.getTime(),
      endTime: bar.timestamp.getTime(),
      kind,
      impulsePct: movePct,
      unmitigated,
      startIndex: i - baseBars.length,
    });
  }

  // Unmitigated zones first, then by impulse size — an untouched zone from a
  // violent move is the one most likely to still matter.
  return zones
    .sort((a, b) => Number(b.unmitigated) - Number(a.unmitigated) || Math.abs(b.impulsePct) - Math.abs(a.impulsePct))
    .slice(0, 6);
}

/**
 * Liquidity pools — equal highs/lows where resting stops accumulate.
 *
 * Buy-side liquidity sits above equal highs (where short stops rest);
 * sell-side sits below equal lows. Naming follows the ICT convention, in which
 * the side names the orders that would be *triggered*, not the direction price
 * moves to reach them.
 */
export function findLiquidityPools(
  candles: Candle[],
  swings: SwingPoint[],
  tolerancePct = 0.08,
): LiquidityPool[] {
  const pools: LiquidityPool[] = [];
  const lastPrice = candles[candles.length - 1]?.close ?? 0;

  for (const kind of ['high', 'low'] as const) {
    const points = swings.filter((s) => s.kind === kind).sort((a, b) => a.price - b.price);

    let cluster: SwingPoint[] = [];
    const flush = () => {
      // Two aligned pivots is the minimum that constitutes "equal" highs/lows;
      // a single pivot is just a swing, with no accumulated resting orders.
      if (cluster.length >= 2) {
        const price = cluster.reduce((s, c) => s + c.price, 0) / cluster.length;
        const times = cluster.map((c) => c.time);
        const lastIndex = Math.max(...cluster.map((c) => c.index));
        const after = candles.slice(lastIndex + 1);
        const swept =
          kind === 'high' ? after.some((c) => c.high > price) : after.some((c) => c.low < price);

        pools.push({
          price,
          kind: kind === 'high' ? 'buy-side' : 'sell-side',
          points: [...cluster],
          startTime: Math.min(...times),
          endTime: Math.max(...times),
          swept,
        });
      }
      cluster = [];
    };

    for (const point of points) {
      if (cluster.length === 0) {
        cluster.push(point);
        continue;
      }
      const anchor = cluster[0].price;
      if (anchor > 0 && (Math.abs(point.price - anchor) / anchor) * 100 <= tolerancePct) {
        cluster.push(point);
      } else {
        flush();
        cluster.push(point);
      }
    }
    flush();
  }

  // Unswept pools nearest current price are the ones that still matter.
  return pools
    .sort(
      (a, b) =>
        Number(a.swept) - Number(b.swept) ||
        Math.abs(a.price - lastPrice) - Math.abs(b.price - lastPrice),
    )
    .slice(0, 6);
}

/**
 * Fair value gaps — a three-bar imbalance where the middle bar's move left a
 * range untraded by its neighbours' wicks.
 */
export function findFairValueGaps(candles: Candle[], lookback = 60): FairValueGap[] {
  const gaps: FairValueGap[] = [];
  const start = Math.max(2, candles.length - lookback);

  for (let i = start; i < candles.length; i++) {
    const first = candles[i - 2];
    const third = candles[i];

    if (first.high < third.low) {
      gaps.push({
        bottom: first.high,
        top: third.low,
        time: candles[i - 1].timestamp.getTime(),
        index: i - 1,
        direction: 'bullish',
        unmitigated: !candles.slice(i + 1).some((c) => c.low <= first.high),
      });
    } else if (first.low > third.high) {
      gaps.push({
        bottom: third.high,
        top: first.low,
        time: candles[i - 1].timestamp.getTime(),
        index: i - 1,
        direction: 'bearish',
        unmitigated: !candles.slice(i + 1).some((c) => c.high >= first.low),
      });
    }
  }

  return gaps.filter((g) => g.unmitigated).slice(-4);
}

/**
 * Fit trend lines through swing pivots.
 *
 * A line is kept only if no *body* closes materially beyond it between its two
 * anchors — wicks are allowed to pierce, closes are not. That mirrors how the
 * line is actually used: a wick through a trendline is a test, a close through
 * it is a break, and a fitter that rejected wick violations would find almost
 * no lines on real data.
 */
export function findTrendLines(candles: Candle[], swings: SwingPoint[], maxLines = 2): TrendLine[] {
  const lines: TrendLine[] = [];

  for (const kind of ['low', 'high'] as const) {
    const points = swings.filter((s) => s.kind === kind).sort((a, b) => a.index - b.index);
    if (points.length < 2) continue;

    // Prefer recent anchors: the most recent pivot paired with each earlier one.
    const anchor = points[points.length - 1];
    let best: TrendLine | null = null;

    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i];
      if (anchor.time === from.time) continue;

      const slope = (anchor.price - from.price) / (anchor.time - from.time);
      const priceAt = (time: number) => from.price + slope * (time - from.time);

      // Validate: no close beyond the line between the anchors.
      let valid = true;
      let confirmations = 0;
      for (let j = from.index; j <= anchor.index; j++) {
        const bar = candles[j];
        const lineValue = priceAt(bar.timestamp.getTime());
        if (lineValue <= 0) continue;
        const deviationPct = ((bar.close - lineValue) / lineValue) * 100;
        // 0.1% tolerance absorbs ordinary noise without letting a real break through.
        if (kind === 'low' ? deviationPct < -0.1 : deviationPct > 0.1) {
          valid = false;
          break;
        }
        if (Math.abs(deviationPct) < 0.05) confirmations++;
      }
      if (!valid) continue;

      const line: TrendLine = {
        from,
        to: anchor,
        slope,
        kind: slope >= 0 ? 'ascending' : 'descending',
        confirmations,
        priceAt,
      };
      // Longer lines with more touches are more meaningful than short ones.
      const score = (anchor.index - from.index) + confirmations * 3;
      const bestScore = best ? best.to.index - best.from.index + best.confirmations * 3 : -1;
      if (score > bestScore) best = line;
    }

    if (best) lines.push(best);
  }

  return lines.slice(0, maxLines);
}

/** Standard retracement and extension ratios. */
const FIB_RATIOS: { ratio: number; label: string }[] = [
  { ratio: 0, label: '0%' },
  { ratio: 0.236, label: '23.6%' },
  { ratio: 0.382, label: '38.2%' },
  { ratio: 0.5, label: '50%' },
  { ratio: 0.618, label: '61.8%' },
  { ratio: 0.786, label: '78.6%' },
  { ratio: 1, label: '100%' },
  { ratio: 1.272, label: '127.2%' },
  { ratio: 1.618, label: '161.8%' },
];

/**
 * Fibonacci levels over the most recent significant swing leg.
 *
 * The leg is chosen as the largest move between two opposite-kind pivots in
 * the recent window — drawing fib from an arbitrary pair produces levels that
 * mean nothing, and the choice of leg is the entire content of the tool.
 */
export function findFibonacci(swings: SwingPoint[], lookbackPoints = 12): FibonacciLevels | null {
  const recent = swings.slice(-lookbackPoints);
  if (recent.length < 2) return null;

  let best: { from: SwingPoint; to: SwingPoint; size: number } | null = null;
  for (let i = 0; i < recent.length - 1; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      if (recent[i].kind === recent[j].kind) continue;
      const size = Math.abs(recent[j].price - recent[i].price);
      if (!best || size > best.size) best = { from: recent[i], to: recent[j], size };
    }
  }
  if (!best || best.size <= 0) return null;

  const direction = best.to.price > best.from.price ? 'up' : 'down';
  const span = best.to.price - best.from.price;

  return {
    from: best.from,
    to: best.to,
    direction,
    // Measured from the END of the leg back toward its start, which is what a
    // retracement is — 0% at the extreme, 100% at the origin.
    levels: FIB_RATIOS.map(({ ratio, label }) => ({
      ratio,
      label,
      price: best!.to.price - span * ratio,
    })),
  };
}

/** Linear regression slope over closes — a scalar trend read for annotations. */
export function regressionSlope(candles: Candle[]): number {
  const n = candles.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = candles.reduce((s, c) => s + c.close, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - meanX) * (candles[i].close - meanY);
    denominator += (i - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}
