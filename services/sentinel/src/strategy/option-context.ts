import type { MarketSnapshot, OptionChainRead } from '../intelligence/market-intelligence.service';

/**
 * Option-chain context for Side in Focus — Phase 3.
 *
 * The product requirement is that Side in Focus can name the relevant index,
 * the strike, the CE/PE context and the directional market context. The
 * boundary that makes this legal under the Constitution and Master Plan
 * principle 6 is subtle and worth stating exactly:
 *
 *   Naming the instrument a structural read is ABOUT is context.
 *   Telling a trader to transact in it is a directive.
 *
 * "Bullish side in focus; the 24 500 CE is the contract this structure would
 * express itself through, and call writers are unwinding there" describes the
 * market. "Buy the 24 500 CE" instructs. This module produces only the former,
 * and carries no entry price, no target, no stop and no position size —
 * omitted by construction rather than by convention, because there is no field
 * for them.
 *
 * ## Honest degradation
 *
 * `CandleMarketDataProvider.getOptionChain()` currently returns `[]` for every
 * symbol — the Phase 4 ingestion pipeline has not landed. So `optionChain` is
 * usually null, and every function here reports the absence rather than
 * inventing a chain. A fabricated PCR would flow into the confidence engine's
 * option factor and into a trader's read of positioning, which is precisely
 * the failure the provider's no-simulator rule exists to prevent.
 */

export interface OptionContext {
  /** The underlying the chain belongs to. */
  underlying: string;
  /** At-the-money strike, rounded to the instrument's strike interval. */
  atmStrike: number | null;
  /** The strike this structural read would express itself through. */
  focusStrike: number | null;
  side: 'CE' | 'PE';
  /** Put-call OI ratio, when a chain is published. */
  pcr: number | null;
  maxPain: number | null;
  /** Nearest heavy call OI above spot — structural resistance in positioning. */
  callOIWall: number | null;
  /** Nearest heavy put OI below spot — structural support in positioning. */
  putOIWall: number | null;
  /** Readable positioning notes; empty when no chain is published. */
  notes: string[];
  /** True when no option chain was available and the numeric fields are null. */
  unavailable: boolean;
  unavailableReason: string | null;
}

/**
 * Strike intervals for the instruments Sentinel covers.
 *
 * Wrong rounding produces a strike that does not trade, which reads as
 * authoritative and is simply false. Defaults to 50 for unknown symbols, which
 * is the NSE index convention.
 */
const STRIKE_INTERVALS: Record<string, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  FINNIFTY: 50,
  MIDCPNIFTY: 25,
  SENSEX: 100,
};

export function strikeIntervalFor(symbol: string): number {
  return STRIKE_INTERVALS[symbol.toUpperCase()] ?? 50;
}

/** Nearest tradable strike to spot. */
export function atmStrikeFor(symbol: string, spot: number): number | null {
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const interval = strikeIntervalFor(symbol);
  return Math.round(spot / interval) * interval;
}

/**
 * Build the option context for a directional read.
 *
 * `bias` decides the side: a bullish structural read is expressed through
 * calls, a bearish one through puts. That is a statement about which contract
 * the structure concerns, not a recommendation to hold it.
 */
export function buildOptionContext(snapshot: MarketSnapshot, bias: 'bullish' | 'bearish'): OptionContext {
  const side: 'CE' | 'PE' = bias === 'bullish' ? 'CE' : 'PE';
  const atmStrike = atmStrikeFor(snapshot.symbol, snapshot.lastPrice);
  const chain = snapshot.optionChain;

  if (!chain) {
    return {
      underlying: snapshot.symbol,
      atmStrike,
      focusStrike: atmStrike,
      side,
      pcr: null,
      maxPain: null,
      callOIWall: null,
      putOIWall: null,
      notes: [],
      unavailable: true,
      unavailableReason:
        'No option chain is published for this instrument, so positioning context is unavailable. ' +
        'The strike shown is the at-the-money strike derived from spot, not from chain data.',
    };
  }

  return {
    underlying: snapshot.symbol,
    atmStrike,
    focusStrike: atmStrike,
    side,
    pcr: chain.pcr,
    maxPain: chain.maxPain,
    callOIWall: chain.callOIWall,
    putOIWall: chain.putOIWall,
    notes: positioningNotes(chain, snapshot.lastPrice, bias),
    unavailable: false,
    unavailableReason: null,
  };
}

/**
 * What the chain says about positioning, phrased observationally.
 *
 * Each note describes what option writers have done — an observable fact about
 * open interest — never what the reader should do about it.
 */
export function positioningNotes(chain: OptionChainRead, spot: number, bias: 'bullish' | 'bearish'): string[] {
  const notes: string[] = [];

  notes.push(
    `Put-call OI ratio ${chain.pcr.toFixed(2)} across ${chain.strikesAnalysed} front-expiry strikes` +
      (chain.pcr >= 1
        ? ' — put writers dominate, which sits with the upside'
        : ' — call writers dominate, which sits with the downside'),
  );

  if (spot > 0) {
    const pinDistPct = (Math.abs(spot - chain.maxPain) / spot) * 100;
    notes.push(
      `Max pain ${chain.maxPain.toFixed(0)} against spot ${spot.toFixed(1)} (${pinDistPct.toFixed(2)}% away)` +
        (pinDistPct < 0.3 ? ' — spot is pinned, where directional follow-through is historically suppressed' : ''),
    );
  }

  if (bias === 'bullish' && chain.callOIWall !== null && chain.callOIWall > spot) {
    notes.push(`Heaviest call OI overhead at ${chain.callOIWall.toFixed(0)} — the level writers are defending`);
  }
  if (bias === 'bearish' && chain.putOIWall !== null && chain.putOIWall < spot) {
    notes.push(`Heaviest put OI below at ${chain.putOIWall.toFixed(0)} — the level writers are defending`);
  }

  // Positioning that sits against the structural read is the more useful note,
  // because it is the one a trader reading only price would miss.
  if (bias === 'bullish' && chain.pcr < 0.8) {
    notes.push('Positioning is call-weighted against the bullish structural read — the two disagree');
  }
  if (bias === 'bearish' && chain.pcr > 1.2) {
    notes.push('Positioning is put-weighted against the bearish structural read — the two disagree');
  }

  return notes;
}
