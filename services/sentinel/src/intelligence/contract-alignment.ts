import type { Candle } from '@tradew/types';

/**
 * Contract alignment — reading the CE and PE legs, not just the index.
 *
 * ## The state this exists to fix
 *
 * The Sentinel workspace has drawn three charts since 2026-08-05: the index,
 * a CALL and a PUT. Only one of them was ever read. `MarketIntelligenceService`
 * snapshots the underlying and every rule in `strategy-rules.ts` is a pure
 * function of that snapshot, so the two contract panels were decoration — a
 * screen that looked like multi-instrument intelligence over a single-series
 * engine. That is the same class of mismatch as the CE-fabrication gotcha
 * (2026-08-11): the UI asserting something about the engine that was not true.
 *
 * This module is the arithmetic for the other two panels. It is pure and takes
 * candles, so it can be tested without a bridge, a Nest context or a market.
 *
 * ## Why the premium series, and not an inference from the index
 *
 * It is tempting to derive a leg's behaviour from the underlying — calls rise
 * when the index rises. They frequently do not. A call premium can fall on a
 * rising index (IV collapsing faster than delta pays, or theta into the
 * afternoon), and BOTH legs can rise together when the market is bidding
 * volatility ahead of an event. Those divergences are not noise to be smoothed
 * away; they ARE the observation, and only the traded premium series carries
 * them.
 *
 * ## What this is NOT
 *
 * It reads ONE strike — the at-the-money pair — and says so. It does not rank
 * strikes, does not score contracts against each other, and produces no
 * "best" anything. Naming which of two legs is tracking the index is a
 * description of what the tape did; ranking a ladder of strikes by
 * attractiveness is a recommendation wearing a table, and Rule 2 of the
 * workspace constitution puts that off-limits regardless of how it is worded.
 * Every string this module emits describes observed movement in the past
 * tense.
 */

export type SeriesDirection = 'rising' | 'falling' | 'flat';

/**
 * How far a series must move before it is called directional rather than flat.
 *
 * Two different bands on purpose, and the difference is large. An index moving
 * 0.05% is a real drift (12 points on a 24,350 NIFTY); an option premium
 * moving 0.05% is nothing — an at-the-money weekly premium routinely travels
 * several percent inside one 15-minute bar. Using one band for both would
 * report every leg as "rising" all day and make the alignment read meaningless.
 */
export const INDEX_FLAT_BAND_PCT = 0.05;
export const PREMIUM_FLAT_BAND_PCT = 1.0;

export interface SeriesRead {
  /** How many bars were actually read — the sample behind everything below. */
  bars: number;
  /** First open of the session window read. */
  open: number;
  /** Most recent close. */
  last: number;
  changePct: number;
  direction: SeriesDirection;
}

export interface LegRead {
  side: 'CE' | 'PE';
  strike: number;
  /** Null when the leg could not be read; never a zeroed stand-in. */
  series: SeriesRead | null;
  /**
   * Why the leg could not be read. `null` with a non-null `series` is a
   * successful read; a leg that read cleanly and did not move is
   * `direction: 'flat'`, which is a reading — "could not read" and "read
   * nothing" are different sentences and never share a field.
   */
  unavailableReason: string | null;
}

/**
 * How the two legs behaved relative to the index over the same bars.
 *
 * `null` whenever either leg is unreadable: an alignment computed from one leg
 * is not an alignment, and reporting one would be the strongest claim on the
 * panel resting on the weakest evidence.
 */
export type AlignmentRead =
  | 'call-side-tracking'
  | 'put-side-tracking'
  | 'both-sides-bid'
  | 'both-sides-decaying'
  | 'index-flat'
  | 'mixed';

export interface ContractAlignment {
  underlying: string;
  expiry: string | null;
  strike: number | null;
  /** The interval every series here was read on — the engine's own bars. */
  interval: string;
  index: SeriesRead | null;
  ce: LegRead | null;
  pe: LegRead | null;
  alignment: AlignmentRead | null;
  /** Plain-language observations. Empty when there was nothing to compare. */
  notes: string[];
  /**
   * True when the provider cannot read contract series at all (no bridge, or a
   * provider without the optional capability). Distinct from a leg that was
   * requested and failed — this one means the feature is off, not broken.
   */
  contractsReadable: boolean;
}

/** Reduce a candle series to its session move. Null on an empty series. */
export function readSeries(candles: Candle[] | null | undefined, flatBandPct: number): SeriesRead | null {
  if (!candles || candles.length === 0) return null;

  const open = candles[0].open;
  const last = candles[candles.length - 1].close;
  if (!Number.isFinite(open) || !Number.isFinite(last) || open <= 0) return null;

  const changePct = ((last - open) / open) * 100;
  const direction: SeriesDirection =
    Math.abs(changePct) < flatBandPct ? 'flat' : changePct > 0 ? 'rising' : 'falling';

  return { bars: candles.length, open, last, changePct, direction };
}

/** A leg that was requested and could not be read. */
export function unreadableLeg(side: 'CE' | 'PE', strike: number, reason: string): LegRead {
  return { side, strike, series: null, unavailableReason: reason };
}

/** A leg that was read. */
export function readLeg(side: 'CE' | 'PE', strike: number, candles: Candle[] | null): LegRead {
  const series = readSeries(candles, PREMIUM_FLAT_BAND_PCT);
  return {
    side,
    strike,
    series,
    unavailableReason: series ? null : 'No traded candles were returned for this contract.',
  };
}

/**
 * Classify how the two legs moved against the index.
 *
 * Deliberately a small closed set rather than a score. A number invites
 * ranking, ranking invites "which is best", and "best" is the word this
 * module's docstring refuses.
 */
export function classifyAlignment(
  index: SeriesRead | null,
  ce: SeriesRead | null,
  pe: SeriesRead | null,
): AlignmentRead | null {
  if (!index || !ce || !pe) return null;
  if (index.direction === 'flat') return 'index-flat';

  if (ce.direction === 'rising' && pe.direction === 'rising') return 'both-sides-bid';
  if (ce.direction === 'falling' && pe.direction === 'falling') return 'both-sides-decaying';

  // Tracking means the leg that should gain on this move did, AND its opposite
  // did not also gain. Requiring both halves is what keeps a volatility bid
  // from being reported as directional confirmation.
  if (index.direction === 'rising' && ce.direction === 'rising' && pe.direction !== 'rising') {
    return 'call-side-tracking';
  }
  if (index.direction === 'falling' && pe.direction === 'rising' && ce.direction !== 'rising') {
    return 'put-side-tracking';
  }
  return 'mixed';
}

const pct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

/**
 * Readable observations for the alignment.
 *
 * Past tense, describing movement that has already happened on bars that have
 * already closed. No note names an action, a level to act at, or a preference
 * between the two contracts as things to hold.
 */
export function alignmentNotes(a: {
  index: SeriesRead | null;
  ce: LegRead | null;
  pe: LegRead | null;
  alignment: AlignmentRead | null;
  strike: number | null;
  interval: string;
}): string[] {
  const notes: string[] = [];
  const { index, ce, pe, alignment, strike, interval } = a;

  if (index) {
    notes.push(`The underlying moved ${pct(index.changePct)} across ${index.bars} ${interval} bars read.`);
  }

  for (const leg of [ce, pe]) {
    if (!leg) continue;
    const label = leg.side === 'CE' ? 'Call' : 'Put';
    if (!leg.series) {
      // Named, not dropped: a leg Sentinel could not read must not look the
      // same as a leg that did not move.
      notes.push(`${label} premium at ${leg.strike} could not be read. ${leg.unavailableReason}`);
      continue;
    }
    notes.push(`${label} premium at ${leg.strike} moved ${pct(leg.series.changePct)} over the same bars.`);
  }

  switch (alignment) {
    case 'call-side-tracking':
      notes.push(
        `Of the two legs read at ${strike}, the call side is the one that moved with the underlying; the put side did not.`,
      );
      break;
    case 'put-side-tracking':
      notes.push(
        `Of the two legs read at ${strike}, the put side is the one that moved with the underlying; the call side did not.`,
      );
      break;
    case 'both-sides-bid':
      notes.push(
        'Both legs gained together. That is a volatility reading rather than a directional one — premium is being bid on both sides of the strike.',
      );
      break;
    case 'both-sides-decaying':
      notes.push(
        'Both legs lost premium together. Time decay and falling implied volatility affect both sides of a strike at once, and neither leg is tracking direction here.',
      );
      break;
    case 'index-flat':
      notes.push(
        'The underlying has not established a direction over these bars, so neither leg can be said to be tracking one.',
      );
      break;
    case 'mixed':
      notes.push('The two legs did not move in a way that tracks the underlying over these bars.');
      break;
    case null:
      break;
  }

  return notes;
}

/**
 * Compose the whole read. `interval` is the series the ENGINE received, which
 * is not always the one it asked for — the market-data bridge substitutes 5m
 * for any interval it does not carry. Passing it through means the panel can
 * caption the bars that were actually read.
 */
export function alignContracts(input: {
  underlying: string;
  expiry: string | null;
  strike: number | null;
  interval: string;
  indexCandles: Candle[] | null;
  ce: LegRead | null;
  pe: LegRead | null;
  contractsReadable: boolean;
}): ContractAlignment {
  const index = readSeries(input.indexCandles, INDEX_FLAT_BAND_PCT);
  const alignment = classifyAlignment(index, input.ce?.series ?? null, input.pe?.series ?? null);

  return {
    underlying: input.underlying,
    expiry: input.expiry,
    strike: input.strike,
    interval: input.interval,
    index,
    ce: input.ce,
    pe: input.pe,
    alignment,
    notes: alignmentNotes({
      index,
      ce: input.ce,
      pe: input.pe,
      alignment,
      strike: input.strike,
      interval: input.interval,
    }),
    contractsReadable: input.contractsReadable,
  };
}
