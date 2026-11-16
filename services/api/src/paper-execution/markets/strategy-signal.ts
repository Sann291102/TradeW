/**
 * The market-neutral strategy signal.
 *
 * ## The problem this solves
 *
 * `ExecutionIntent` is not a trade intent. It is an NSE index-option order:
 * `optionType` ('CE'|'PE'), `strike`, `expiry` and `contractSymbol` are all
 * required columns, `quantity` is an `Int`, and `underlyingSpot` is
 * `Decimal(12,2)`. `ExecutionJournal` repeats the same required option fields.
 * Sentinel's `sideInFocus` returns a CE/PE side.
 *
 * A BTC spot position has no strike, no expiry and no option type, and its size
 * is fractional. A gold future has an expiry but no strike and no CE/PE. Neither
 * is representable in that model, and neither should be — the model is right
 * about what it holds. What is wrong is that it sits where a *generic* trade
 * decision belongs.
 *
 * ## The split
 *
 *     Strategy  →  StrategySignal  →  ExecutionAdapter  →  venue order
 *                  (this file)        (materialiser)
 *
 * The strategy engine already produces something market-neutral: a direction,
 * a confidence, the evidence behind it, and the levels it would act on. The
 * CE/PE choice, the strike selection and the expiry are NOT strategy output —
 * they are how a bullish read on NIFTY gets *expressed* on a venue that offers
 * options. On Binance the same read is expressed by buying the coin; on MCX by
 * buying the future.
 *
 * Naming that step "materialisation" and giving it a port is the whole design.
 * It means:
 *
 *   · The existing option path is untouched. It becomes one implementation of
 *     the port, not a special case inside a widened model.
 *   · No strategy learns which market it is on. Every rule in
 *     `strategy-rules.ts` already reads only a `MarketSnapshot`; nothing here
 *     changes that.
 *   · A new venue is a new adapter, not a new branch in the execution service.
 *
 * ## Why levels are in the ANALYSED instrument's price space
 *
 * `entryReference`, `stopLoss` and `target` are quoted in the price space of
 * the instrument the strategy READ — the NIFTY index, the BTC pair, the gold
 * contract — not of whatever gets traded. For spot and futures those are the
 * same instrument and the values pass straight through. For options they are
 * not, and the adapter must translate: `ExecutionProfile.trailStepPoints`
 * already records this distinction ("deliberately not index points: the
 * position is in the option, the P&L is in the option, and a trail measured on
 * a different instrument than the one being protected is not a trail").
 *
 * Keeping the signal in the analysed space and making translation the adapter's
 * job is what stops that subtlety from leaking into strategy code.
 */

import type { ExperimentMarket, ExecutionStyle } from '@tradew/market-data';

/** The direction the evidence supports. `neutral` never becomes a trade. */
export type SignalBias = 'bullish' | 'bearish' | 'neutral';

/**
 * One piece of the "why" — carried through to the chart and the journal.
 *
 * Mirrors Sentinel's `EvidenceDto.items` rather than inventing a second
 * vocabulary, so a signal can be built from an evaluation without a lossy
 * translation and the chart's rejection tooltip can cite the same words the
 * journal does.
 */
export interface SignalEvidence {
  id: string;
  label: string;
  /** The knowledge-base concept this comes from, when the strategy declared one. */
  concept: string;
  detail: string;
  stance: 'supports' | 'opposes' | 'neutral';
  weight: number;
}

export interface StrategySignal {
  /** The instrument the strategy ANALYSED. Not necessarily the one traded. */
  symbol: string;
  market: ExperimentMarket;
  /** How this signal must be expressed on its venue. From `TradableSpec`. */
  executionStyle: ExecutionStyle;

  bias: SignalBias;
  /** 0-100, Sentinel's own. The policy layer applies floors; this only reports. */
  confidence: number;

  /** Which strategy produced it, and at which version. */
  strategyId: string | null;
  strategyName: string | null;
  strategyVersion: string | null;
  /** MarketProfile regime at decision time — the calibration bucket key. */
  regime: string | null;

  /**
   * Last traded price of the ANALYSED instrument when the read was taken.
   *
   * Named `referencePrice` rather than `spot` because "spot" means something
   * specific and different in each of the three markets, and the option path
   * already uses `underlyingSpot` for the index level. This is simply the
   * number the levels below are relative to.
   */
  referencePrice: number;

  /**
   * The levels the strategy would act on, in the ANALYSED instrument's price
   * space. Null when the strategy declined to state one — which is a real
   * outcome and must not be defaulted to a number, because a fabricated stop
   * is indistinguishable from a chosen one once it is written to a journal.
   */
  entryReference: number | null;
  stopLoss: number | null;
  target: number | null;

  /** The bar the signal fired on. Drives the chart's signal-candle marker. */
  signalBarAt: Date | null;

  /** Why — the strategy's own material evidence, and what opposed it. */
  evidence: SignalEvidence[];
  rationale: string[];

  /** When the decision was taken. Bucketed by the idempotency layer. */
  decidedAt: Date;
}

/**
 * Whether a signal is directional enough to attempt an order at all.
 *
 * A neutral bias is not a weak buy. `sideInFocus` records that this exact
 * defaulting — treating neutral as bullish — once "manufactured a CE out of the
 * precise case where the evidence declined to pick a direction". The same trap
 * exists for spot, so the check lives here rather than in each adapter.
 */
export function isActionable(signal: StrategySignal): boolean {
  return signal.bias === 'bullish' || signal.bias === 'bearish';
}

/**
 * The order side a bias implies for a directly-traded instrument.
 *
 * Only meaningful for `spot` and `futures`. The option path does NOT use this:
 * there, a bearish read is a BUY of a PE, so bias and side deliberately do not
 * correspond — which is exactly why this function refuses to answer for it
 * rather than returning something that would type-check and be wrong.
 */
export function directSideFor(signal: StrategySignal): 'BUY' | 'SELL' | null {
  if (signal.executionStyle === 'long-option') return null;
  if (signal.bias === 'bullish') return 'BUY';
  if (signal.bias === 'bearish') return 'SELL';
  return null;
}
