import { Injectable } from '@nestjs/common';

/**
 * Educational strategy registry — the Learning Engine's catalogue of
 * professionally-documented starter strategies.
 *
 * These are ORIGINAL educational specifications generalised from widely-taught
 * trading methodologies. No book text is reproduced; each entry is a
 * from-scratch description of a public methodology, written for education.
 *
 * The registry is DATA, not a second strategy engine. `detectionStrategyId`
 * points at an existing rule-based strategy in
 * `intelligence/strategy-engine.service.ts` when one exists, so detection and
 * confidence keep running through the single StrategyEngineService. A null
 * `detectionStrategyId` means the strategy is educational context only — the
 * Brain reasons with it, but there is no mechanical detector yet, which is
 * stated honestly rather than faked.
 *
 * `exposed` gates what the UI dropdown shows today; flipping it to true adds a
 * strategy with no frontend change. Ordering is explicit so the first N are
 * deterministic.
 */
export interface EducationalStrategy {
  id: string;
  name: string;
  /** id in StrategyEngineService, or null when detection is not yet built */
  detectionStrategyId: string | null;
  /** shown in the UI dropdown when true */
  exposed: boolean;
  order: number;
  purpose: string;
  marketConditions: string[];
  timeframes: string[];
  requiredIndicators: string[];
  /** rule names this strategy leans on (from strategy-rules.ts where mapped) */
  ruleMapping: string[];
  riskConsiderations: string[];
  confidenceFactors: string[];
  whenNotToUse: string[];
  educational: string;
  /** canonical regimes this strategy suits (see reasoning/types.ts REGIMES) */
  regimes: string[];
}

const REGISTRY: EducationalStrategy[] = [
  {
    id: 'orb-retest',
    name: 'ORB Retest',
    detectionStrategyId: 'orb-retest',
    exposed: true,
    order: 1,
    purpose:
      'Study how price behaves when it breaks the opening range and then returns to test the broken level as support or resistance.',
    marketConditions: ['Clear opening-range formation', 'Directional session bias', 'Participation confirming the break'],
    timeframes: ['1m', '3m', '5m', '15m'],
    requiredIndicators: ['Opening range high/low', 'Volume'],
    ruleMapping: ['orb_breakout', 'orb_retest', 'orb_retest_volume_lower'],
    riskConsiderations: [
      'A failed retest that re-enters the range invalidates the read',
      'First 15 minutes can be noisy on high-VIX days',
    ],
    confidenceFactors: ['Retest holds with lower volume', 'Break aligned with session structure'],
    whenNotToUse: ['Inside days with no range break', 'When the retest re-enters the opening range on rising volume'],
    educational:
      'The opening range frames the session. A break that is retested and holds shows the level has changed roles; a break that fails the retest often marks a trap. Sentinel narrates which is happening, never what to do about it.',
    regimes: ['breakout', 'trending'],
  },
  {
    id: 'ict-liquidity-sweep',
    name: 'ICT Liquidity Sweep',
    detectionStrategyId: 'liquidity-sweep',
    exposed: true,
    order: 2,
    purpose:
      'Study the pattern where price runs a prior swing point to take resting liquidity, then reverses back through it.',
    marketConditions: ['Obvious prior high or low with clustered stops', 'Reversal candle reclaiming the swept level'],
    timeframes: ['1m', '5m', '15m'],
    requiredIndicators: ['Prior swing highs/lows', 'Volume spike'],
    ruleMapping: ['liquidity_sweep', 'sweep_volume_spike'],
    riskConsiderations: [
      'A sweep that is not reclaimed is continuation, not reversal',
      'Requires a clean level; ambiguous structure produces false reads',
    ],
    confidenceFactors: ['Volume spike on the sweep', 'Fast reclaim of the swept level'],
    whenNotToUse: ['Strong trend days where liquidity runs simply continue', 'When no clear prior swing exists'],
    educational:
      'Large participants need liquidity to fill size; obvious stop clusters are where it sits. A sweep-and-reclaim is the observable footprint. This is behavioural observation, not a signal to act.',
    regimes: ['ranging', 'accumulation', 'distribution'],
  },
  {
    id: 'vwap-reversal',
    name: 'VWAP Reversal',
    detectionStrategyId: 'vwap-pullback',
    exposed: true,
    order: 3,
    purpose: 'Study price reactions at the volume-weighted average price as a mean-reversion or trend-rejoin reference.',
    marketConditions: ['Price extended from VWAP', 'Declining momentum into the test'],
    timeframes: ['5m', '15m'],
    requiredIndicators: ['VWAP', 'Volume'],
    ruleMapping: ['price_above_vwap', 'vwap_pullback_touch', 'pullback_volume_lower'],
    riskConsiderations: ['A VWAP loss on rising volume flips the read', 'Choppy ranges produce repeated false touches'],
    confidenceFactors: ['Pullback on lower volume', 'VWAP defended repeatedly intraday'],
    whenNotToUse: ['Trend days that walk away from VWAP', 'Illiquid names where VWAP is unreliable'],
    educational:
      'VWAP is where the average participant is positioned. Reactions there reveal whether control is holding or shifting. Sentinel describes the reaction; it never tells you to fade or follow it.',
    regimes: ['mean-reversion', 'ranging', 'trending'],
  },
  {
    id: 'trend-pullback',
    name: 'Trend Pullback',
    detectionStrategyId: 'ema-cross-bounce',
    exposed: true,
    order: 4,
    purpose: 'Study shallow retracements into moving-average confluence within an established trend.',
    marketConditions: ['Established directional trend', 'Orderly pullback into support', 'Momentum intact'],
    timeframes: ['5m', '15m', '1h'],
    requiredIndicators: ['EMA 20', 'EMA 50', 'Volume'],
    ruleMapping: ['ema_fast_above_slow', 'price_at_ema_confluence', 'volume_supports_move'],
    riskConsiderations: ['A deep pullback that breaks the trend structure invalidates it', 'Late-trend pullbacks fail more often'],
    confidenceFactors: ['Pullback holds the moving-average confluence', 'Trend structure of higher highs/lows intact'],
    whenNotToUse: ['Ranging markets with no trend', 'After a clear trend-structure break'],
    educational:
      'Trends move in waves; pullbacks into confluence are where continuation is decided. Sentinel observes whether the pullback holds or breaks — an educational read, not a trade instruction.',
    regimes: ['trending'],
  },
  {
    id: 'breakout-confirmation',
    name: 'Breakout Confirmation',
    detectionStrategyId: 'fake-breakout',
    exposed: true,
    order: 5,
    purpose: 'Study whether a breakout of a key level is confirmed by participation, or fails as a trap.',
    marketConditions: ['Well-defined range or level', 'Break attempt in progress'],
    timeframes: ['5m', '15m'],
    requiredIndicators: ['Key support/resistance', 'Volume'],
    ruleMapping: ['broke_key_level', 'breakout_failed', 'breakout_volume_fading'],
    riskConsiderations: ['Breakouts without volume frequently fail', 'Late breakouts near session close carry pin risk'],
    confidenceFactors: ['Break sustained with expanding volume', 'No immediate re-entry back inside the level'],
    whenNotToUse: ['Low-volume compression with no participation', 'Directly into a strong opposing OI wall'],
    educational:
      'A breakout is a hypothesis until participation confirms it. Sentinel watches for the confirmation or the failure and narrates which is unfolding, never issuing a buy or sell.',
    regimes: ['breakout', 'volatile'],
  },
  // --- documented, not yet exposed (registry supports expansion to 10–15) ---
  {
    id: 'cpr-breakout',
    name: 'CPR Breakout / Bounce',
    detectionStrategyId: 'cpr-breakout-bounce',
    exposed: false,
    order: 6,
    purpose: 'Study price interaction with the central pivot range as a session bias and reaction zone.',
    marketConditions: ['Price approaching or breaking the CPR', 'Volume confirming the move'],
    timeframes: ['5m', '15m'],
    requiredIndicators: ['CPR (pivot, TC, BC)', 'Volume'],
    ruleMapping: ['cpr_level_interaction', 'volume_supports_move'],
    riskConsiderations: ['Wide CPR days are range-bound and produce false breaks'],
    confidenceFactors: ['Narrow CPR aligning with a trend break'],
    whenNotToUse: ['Wide-CPR range days'],
    educational: 'The central pivot range summarises the prior session. Reactions there frame the current bias — an observation, not advice.',
    regimes: ['breakout', 'trending', 'ranging'],
  },
  {
    id: 'order-block-confirmation',
    name: 'Order Block Confirmation',
    detectionStrategyId: 'ict-smart-money',
    exposed: false,
    order: 7,
    purpose: 'Study reactions at the last opposing candle before an impulsive move (an order block).',
    marketConditions: ['Clean impulsive move away from a base', 'Price returning to the origin block'],
    timeframes: ['5m', '15m'],
    requiredIndicators: ['Market structure', 'Order block zone'],
    ruleMapping: ['market_structure_shift', 'fair_value_gap', 'order_block_mitigated'],
    riskConsiderations: ['A block that fails to hold signals structure has shifted against it'],
    confidenceFactors: ['Structure shift preceding the block', 'Fair value gap left by the impulse'],
    whenNotToUse: ['Ranging chop with no clear impulse'],
    educational: 'An order block marks where an imbalance began. Sentinel observes whether it holds on the retest, without prescribing an action.',
    regimes: ['accumulation', 'distribution', 'trending'],
  },
  {
    id: 'market-structure-shift',
    name: 'Market Structure Shift',
    detectionStrategyId: 'ict-smart-money',
    exposed: false,
    order: 8,
    purpose: 'Study the first break of an opposing swing point that signals a potential change of trend.',
    marketConditions: ['Established swing sequence', 'A decisive break of the last counter-swing'],
    timeframes: ['5m', '15m', '1h'],
    requiredIndicators: ['Swing highs/lows'],
    ruleMapping: ['market_structure_shift'],
    riskConsiderations: ['A single break can be noise; confirmation matters'],
    confidenceFactors: ['Break with displacement and volume'],
    whenNotToUse: ['Tight ranges where swings are ambiguous'],
    educational: 'A structure shift is the earliest observable hint of a trend change. Sentinel narrates it as an observation, never a call.',
    regimes: ['trending', 'breakout'],
  },
  {
    id: 'mean-reversion',
    name: 'Mean Reversion',
    detectionStrategyId: null,
    exposed: false,
    order: 9,
    purpose: 'Study extended moves that stretch far from a mean and show exhaustion before snapping back.',
    marketConditions: ['Price statistically extended from VWAP or a moving average', 'Momentum diverging'],
    timeframes: ['5m', '15m'],
    requiredIndicators: ['VWAP or moving average', 'RSI'],
    ruleMapping: [],
    riskConsiderations: ['Mean reversion fails badly in strong trends', 'Requires a genuine range regime'],
    confidenceFactors: ['Range regime confirmed', 'Momentum divergence at the extreme'],
    whenNotToUse: ['Trend days', 'Breakout regimes'],
    educational: 'In balanced markets, extremes tend to revert. Sentinel observes the stretch and the exhaustion; it does not tell you to fade it.',
    regimes: ['mean-reversion', 'ranging'],
  },
  {
    id: 'multi-timeframe-confluence',
    name: 'Multi-Timeframe Confluence',
    detectionStrategyId: null,
    exposed: false,
    order: 10,
    purpose: 'Study setups where a lower-timeframe trigger aligns with a higher-timeframe bias and level.',
    marketConditions: ['Higher-timeframe level in play', 'Lower-timeframe trigger forming at it'],
    timeframes: ['5m', '15m', '1h', '1d'],
    requiredIndicators: ['Multi-timeframe structure', 'Key levels'],
    ruleMapping: [],
    riskConsiderations: ['Conflicting timeframes reduce reliability', 'Higher-timeframe context can override a clean trigger'],
    confidenceFactors: ['Higher- and lower-timeframe bias agree', 'Trigger at a higher-timeframe level'],
    whenNotToUse: ['When timeframes conflict'],
    educational: 'Confluence across timeframes strengthens a read. Sentinel checks whether the timeframes agree and narrates the alignment — educational only.',
    regimes: ['trending', 'breakout'],
  },
  {
    id: 'wyckoff-accumulation',
    name: 'Wyckoff Accumulation',
    detectionStrategyId: 'wyckoff-spring-upthrust',
    exposed: false,
    order: 11,
    purpose: 'Study the range-bound sequence where supply is absorbed before a markup phase.',
    marketConditions: ['Range-bound context after a decline', 'Spring or shakeout on the lows'],
    timeframes: ['15m', '1h', '1d'],
    requiredIndicators: ['Range boundaries', 'Volume'],
    ruleMapping: ['wyckoff_spring_or_upthrust', 'range_bound_context'],
    riskConsiderations: ['A range break to the downside invalidates accumulation'],
    confidenceFactors: ['Spring on climactic volume', 'Sign of strength off the lows'],
    whenNotToUse: ['Clear downtrends with no basing'],
    educational: 'Accumulation is absorption inside a range. Sentinel observes the schematic markers; it never states that markup will follow.',
    regimes: ['accumulation', 'ranging'],
  },
  {
    id: 'gap-and-go',
    name: 'Gap & Go',
    detectionStrategyId: null,
    exposed: false,
    order: 12,
    purpose: 'Study strong opening gaps that continue in the gap direction without filling.',
    marketConditions: ['Significant opening gap', 'Strong first-candle continuation'],
    timeframes: ['1m', '5m'],
    requiredIndicators: ['Prior close', 'Opening range', 'Volume'],
    ruleMapping: [],
    riskConsiderations: ['A gap that fills early flips the read', 'News-driven gaps carry outsized risk'],
    confidenceFactors: ['Gap holds above the opening range on volume'],
    whenNotToUse: ['Weak gaps that fill immediately'],
    educational: 'A gap that holds and extends shows conviction. Sentinel observes whether it goes or fills — an educational read, not a directive.',
    regimes: ['breakout', 'trending'],
  },
];

@Injectable()
export class StrategyRegistryService {
  private readonly byId = new Map(REGISTRY.map((s) => [s.id, s]));

  /** All registry entries, ordered. Optionally only the exposed ones. */
  list(opts: { exposedOnly?: boolean } = {}): EducationalStrategy[] {
    const all = [...REGISTRY].sort((a, b) => a.order - b.order);
    return opts.exposedOnly ? all.filter((s) => s.exposed) : all;
  }

  get(id: string): EducationalStrategy | null {
    return this.byId.get(id) ?? null;
  }

  /** Reverse lookup: the registry entry whose detector produced this detection id. */
  byDetectionId(detectionStrategyId: string): EducationalStrategy | null {
    return REGISTRY.find((s) => s.detectionStrategyId === detectionStrategyId) ?? null;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }
}
