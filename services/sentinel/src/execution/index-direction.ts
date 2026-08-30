import type { MarketSnapshot } from '../intelligence/market-intelligence.service';
import { analyseStructure } from '../intelligence/market-structure';

/**
 * Which way is the INDEX going, measured on the index alone.
 *
 * ## Why this exists separately from `sideInFocus`
 *
 * `StrategyAdvisorService.sideInFocus` already produces a CE/PE side, and it
 * is a good read — but it is derived from the leading STRATEGY DETECTION's
 * bias, with the session trend as a fallback. That makes it a statement about
 * a setup, not about the index, and the two can legitimately diverge: a
 * liquidity-sweep detection prints a bullish bias at the exact moment the
 * index is still making lower highs, because sweeping the lows is the setup.
 *
 * For a trader reading a workspace that divergence is information. For an
 * agent about to buy a call it is a coin flip dressed as a signal. So the
 * agent requires TWO independent reads to agree: the strategy's side, and the
 * index's own direction computed here from index-only evidence. Neither
 * overrides the other — a disagreement is a refusal, which is the whole point.
 * `execution-evaluation.service.ts` enforces that, and the intent records both
 * so a post-mortem can ask which of the two was wrong.
 *
 * ## Why a weighted vote and not a score
 *
 * Every input below is a direction with a weight, and the output is the net.
 * That is deliberately coarser than a continuous score: the inputs are five
 * views of the same price series, so they are heavily correlated, and a
 * decimal composed from correlated inputs implies a precision that is not
 * there. What IS meaningful is agreement — how many independent structural
 * reads point the same way — and that is exactly what a vote measures.
 *
 * ## What it never does
 *
 * It does not read the option chain, either leg's premium, or the strategy
 * detections. A call's premium can rise on an index that is falling (vol bid,
 * or simply a wide spread), and inferring index direction from option prices
 * is the specific mistake `knowledge/Gotchas/2026-08-11 - Sentinel feed
 * fabricated a CE direction on signals that had none.md` records. The index
 * is the context; the option is the expression.
 */

export type IndexDirection = 'bullish' | 'bearish' | 'neutral' | 'unclear';

export interface DirectionVote {
  /** Stable id, so a caller can group refusals by which read dissented. */
  id: string;
  label: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  /** Relative influence of this read. Not a probability. */
  weight: number;
  /** The measurement, in the reader's own words and with real numbers. */
  detail: string;
  /** The knowledge-base concept this read is an application of. */
  concept: string;
}

export interface IndexDirectionRead {
  direction: IndexDirection;
  /**
   * 0..1 — the winning side's share of the weight that actually voted
   * (abstentions excluded). 1.0 means every read that had an opinion agreed.
   */
  strength: number;
  /** Every read, including the ones that abstained. */
  votes: DirectionVote[];
  /** The reads that pointed against the winning direction. */
  conflicts: DirectionVote[];
  /** Plain-language summary for the console and the intent record. */
  summary: string;
}

/**
 * Minimum agreement before a direction is called at all.
 *
 * Below this the reads are genuinely split and the honest answer is `unclear`,
 * which the agent treats as "no entry" rather than "pick the bigger half". Set
 * at two-thirds: with five reads it takes four agreeing (or three agreeing
 * with the two heaviest), which is a real majority rather than a 3-2 that
 * would flip on the next bar.
 */
export const MIN_DIRECTION_STRENGTH = 0.66;

/**
 * Minimum weight that must actually vote.
 *
 * A snapshot where four of the five reads abstain (no EMA yet, no VWAP, no
 * prior day) can still produce strength 1.0 off a single opinion. Requiring
 * half the total weight to have voted is what stops "one read, unopposed"
 * from reading as "unanimous".
 */
export const MIN_PARTICIPATING_WEIGHT = 0.5;

/** How far price must sit from a level before the read counts as directional. */
const LEVEL_TOLERANCE_PCT = 0.05;

/**
 * The nominal weight of each read, whether or not it manages to vote.
 *
 * Declared as a constant rather than inlined at each `push` because the
 * participation floor has to be measured against what COULD have voted. An
 * abstention carries weight 0 in the tally (so it cannot dilute agreement),
 * which means summing the actual votes gives a denominator that shrinks to
 * exactly the reads that had an opinion — and "one read, unopposed" then
 * computes as 100% participation, which is the opposite of what the floor is
 * for. Measuring against this fixed total is what makes an abstention count
 * as a missing opinion rather than as no opinion having been possible.
 */
const READ_WEIGHTS = {
  'ema-structure': 1.2,
  'vwap-side': 1.0,
  'session-trend': 1.0,
  'swing-structure': 1.2,
  'opening-range': 0.6,
} as const;

/** Sum of every read's nominal weight — the participation denominator. */
export const NOMINAL_TOTAL_WEIGHT = Object.values(READ_WEIGHTS).reduce((a, b) => a + b, 0);

export function readIndexDirection(snapshot: MarketSnapshot): IndexDirectionRead {
  const votes: DirectionVote[] = [];
  const price = snapshot.lastPrice;
  const priceOk = Number.isFinite(price) && price > 0;

  // ---- 1. EMA structure ---------------------------------------------------
  // The heaviest read: two moving averages plus price is three points on the
  // same curve, and their ordering is the textbook statement of trend.
  if (priceOk && snapshot.ema20 != null && snapshot.ema50 != null) {
    const fastAbove = snapshot.ema20 > snapshot.ema50;
    const priceAboveFast = price > snapshot.ema20;
    const aligned = fastAbove === priceAboveFast;
    votes.push({
      id: 'ema-structure',
      label: 'EMA structure',
      // Full alignment (price above a rising stack, or below a falling one) is
      // directional. A price on the wrong side of its own fast EMA while the
      // stack points the other way is a pullback, which is not a direction.
      direction: !aligned ? 'neutral' : fastAbove ? 'bullish' : 'bearish',
      weight: READ_WEIGHTS['ema-structure'],
      detail: aligned
        ? `Price ${price.toFixed(2)} ${priceAboveFast ? 'above' : 'below'} EMA20 ${snapshot.ema20.toFixed(2)}, which is ${fastAbove ? 'above' : 'below'} EMA50 ${snapshot.ema50.toFixed(2)}.`
        : `Price ${price.toFixed(2)} sits against the EMA stack (EMA20 ${snapshot.ema20.toFixed(2)}, EMA50 ${snapshot.ema50.toFixed(2)}) — a pullback, not a direction.`,
      concept: 'moving-average',
    });
  } else {
    votes.push(abstain('ema-structure', 'EMA structure', 'EMA20/EMA50 not yet available on this history.', 'moving-average'));
  }

  // ---- 2. VWAP ------------------------------------------------------------
  if (priceOk && snapshot.vwap != null && snapshot.vwap > 0) {
    const distancePct = ((price - snapshot.vwap) / snapshot.vwap) * 100;
    const decisive = Math.abs(distancePct) >= LEVEL_TOLERANCE_PCT;
    votes.push({
      id: 'vwap-side',
      label: 'VWAP side',
      direction: !decisive ? 'neutral' : distancePct > 0 ? 'bullish' : 'bearish',
      weight: READ_WEIGHTS['vwap-side'],
      detail: decisive
        ? `Price is ${distancePct >= 0 ? '+' : ''}${distancePct.toFixed(2)}% against VWAP ${snapshot.vwap.toFixed(2)}.`
        : `Price is within ${LEVEL_TOLERANCE_PCT}% of VWAP ${snapshot.vwap.toFixed(2)} — sitting on it, not either side of it.`,
      concept: 'vwap',
    });
  } else {
    votes.push(abstain('vwap-side', 'VWAP side', 'No VWAP on this history.', 'vwap'));
  }

  // ---- 3. Session trend ---------------------------------------------------
  // The one read that is about the session's own travel rather than a level.
  const trend = snapshot.trendAnalysis;
  if (trend) {
    // Momentum below a third means the session has moved, but not in a way
    // that held. Reported as neutral rather than as a weak direction, because
    // a weak direction still votes and this genuinely should not.
    const decisive = trend.momentumScore >= 0.33 && trend.direction !== 'neutral';
    votes.push({
      id: 'session-trend',
      label: 'Session trend',
      direction: decisive ? trend.direction : 'neutral',
      weight: READ_WEIGHTS['session-trend'],
      detail: `Session ${trend.sessionChangePct >= 0 ? '+' : ''}${trend.sessionChangePct.toFixed(2)}% with momentum ${trend.momentumScore.toFixed(2)}${decisive ? '' : ' — too indecisive to count as a direction'}.`,
      concept: 'trend',
    });
  } else {
    votes.push(abstain('session-trend', 'Session trend', 'No session bars to measure travel from.', 'trend'));
  }

  // ---- 4. Swing structure -------------------------------------------------
  // The Smart-Money read, and the only one here that is about swing points
  // rather than about price against a line. `analyseStructure` is the existing
  // engine — this does not reimplement it, it votes with it.
  const structure = snapshot.candles.length >= 10 ? analyseStructure(snapshot.candles) : null;
  if (structure && structure.state !== 'undefined') {
    const dir =
      structure.state === 'uptrend' ? 'bullish' : structure.state === 'downtrend' ? 'bearish' : 'neutral';
    votes.push({
      id: 'swing-structure',
      label: 'Swing structure',
      direction: dir,
      weight: READ_WEIGHTS['swing-structure'],
      detail:
        `Swing structure reads ${structure.state}` +
        (structure.event ? ` with a ${structure.event} in the ${structure.eventDirection ?? 'unstated'} direction.` : '.'),
      concept: 'swing-point',
    });
  } else {
    votes.push(abstain('swing-structure', 'Swing structure', 'Too few bars to resolve swing points.', 'swing-point'));
  }

  // ---- 5. Opening range ---------------------------------------------------
  // Lightest, because it is only meaningful for part of the session — but a
  // session trading cleanly outside its own opening range is a real statement.
  if (priceOk && snapshot.openingRange) {
    const { high, low } = snapshot.openingRange;
    const above = price > high;
    const below = price < low;
    votes.push({
      id: 'opening-range',
      label: 'Opening range',
      direction: above ? 'bullish' : below ? 'bearish' : 'neutral',
      weight: READ_WEIGHTS['opening-range'],
      detail: above
        ? `Price ${price.toFixed(2)} is above the opening range high ${high.toFixed(2)}.`
        : below
          ? `Price ${price.toFixed(2)} is below the opening range low ${low.toFixed(2)}.`
          : `Price ${price.toFixed(2)} is inside the opening range ${low.toFixed(2)}–${high.toFixed(2)}.`,
      concept: 'range-expansion',
    });
  } else {
    votes.push(abstain('opening-range', 'Opening range', 'No opening range established yet.', 'range-expansion'));
  }

  // ---- Tally --------------------------------------------------------------
  // NOT `votes.reduce(...)` — see READ_WEIGHTS. An abstention weighs 0, so
  // summing the votes would make the participation floor unreachable.
  const totalWeight = NOMINAL_TOTAL_WEIGHT;
  const bullish = votes.filter((v) => v.direction === 'bullish').reduce((s, v) => s + v.weight, 0);
  const bearish = votes.filter((v) => v.direction === 'bearish').reduce((s, v) => s + v.weight, 0);
  const participating = bullish + bearish;

  if (participating <= 0 || participating / totalWeight < MIN_PARTICIPATING_WEIGHT) {
    return {
      direction: 'unclear',
      strength: 0,
      votes,
      conflicts: [],
      summary:
        participating <= 0
          ? 'No index read produced a direction — every structural check abstained or read neutral.'
          : `Only ${(participating / totalWeight).toFixed(2)} of the index reads had an opinion, below the ${MIN_PARTICIPATING_WEIGHT} participation floor.`,
    };
  }

  const leading: 'bullish' | 'bearish' = bullish > bearish ? 'bullish' : 'bearish';
  const strength = Math.max(bullish, bearish) / participating;
  const conflicts = votes.filter((v) => v.direction !== 'neutral' && v.direction !== leading);

  if (bullish === bearish) {
    return {
      direction: 'neutral',
      strength: 0.5,
      votes,
      conflicts: votes.filter((v) => v.direction !== 'neutral'),
      summary: `The index reads are exactly split (${bullish.toFixed(1)} bullish against ${bearish.toFixed(1)} bearish). No direction.`,
    };
  }

  if (strength < MIN_DIRECTION_STRENGTH) {
    return {
      direction: 'unclear',
      strength,
      votes,
      conflicts,
      summary:
        `The index leans ${leading} at ${(strength * 100).toFixed(0)}% agreement, below the ` +
        `${(MIN_DIRECTION_STRENGTH * 100).toFixed(0)}% floor. ${conflicts.length} read(s) point the other way: ` +
        conflicts.map((c) => c.label).join(', ') + '.',
    };
  }

  return {
    direction: leading,
    strength,
    votes,
    conflicts,
    summary:
      `The index reads ${leading} at ${(strength * 100).toFixed(0)}% agreement across ` +
      `${votes.filter((v) => v.direction === leading).length} of ${votes.length} structural checks` +
      (conflicts.length ? `, against ${conflicts.map((c) => c.label).join(' and ')}.` : ' with nothing dissenting.'),
  };
}

/** The option side an index direction permits. Null when it permits none. */
export function alignedOptionSide(direction: IndexDirection): 'CE' | 'PE' | null {
  if (direction === 'bullish') return 'CE';
  if (direction === 'bearish') return 'PE';
  return null;
}

function abstain(id: string, label: string, detail: string, concept: string): DirectionVote {
  // Weight 0, not a small weight: an abstention must not dilute the strength
  // denominator, or a snapshot with four missing reads would report a lower
  // agreement than the one opinion it actually has.
  return { id, label, direction: 'neutral', weight: 0, detail: `Abstained — ${detail}`, concept };
}
