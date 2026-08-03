import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Candle, CandleInterval, MarketDataProvider, OptionChainEntry } from '@tradew/types';
import { MARKET_DATA } from '../../intelligence/market-intelligence.service';
import { SentinelIntelligenceService } from '../sentinel-intelligence.service';
import { AnnotationEngineService } from './annotation-engine.service';
import { buildChartContext, type ChartContext } from './chart-context';
import { TradingViewRuleService, type RuleMatch } from './tradingview-rule.service';
import {
  serializeCandle,
  type OptionContextPanel,
  type OptionContextRow,
  type ReasonRequest,
  type ReasoningRun,
  type Timeframe,
  type WorkspaceView,
} from '../types';

/** Extra detail the workspace returns beyond the three panels. */
export interface WorkspacePayload extends WorkspaceView {
  /** Learned strategies evaluated this run, matched or not — the audit trail. */
  ruleMatches: {
    id: string;
    name: string;
    matched: boolean;
    score: number;
    met: string[];
    unmet: string[];
  }[];
}

/** How many bars each timeframe pulls for the chart. */
const BARS_BY_TIMEFRAME: Record<Timeframe, { interval: CandleInterval; days: number }> = {
  '1m': { interval: '1m', days: 2 },
  '3m': { interval: '5m', days: 3 },
  '5m': { interval: '5m', days: 5 },
  '15m': { interval: '15m', days: 10 },
  '30m': { interval: '15m', days: 20 },
  '1h': { interval: '1h', days: 40 },
  '1d': { interval: '1d', days: 400 },
};

/**
 * Assembles the three synchronized panels of the visual strategy workspace.
 *
 *  Panel 1 — the live market chart (candles).
 *  Panel 2 — the option-chain context around the strike in focus.
 *  Panel 3 — the AI strategy visualization (annotations + the reasoning run).
 *
 * "Synchronized" is a data property here, not a UI trick: all three panels are
 * derived from ONE reasoning run against ONE candle series in a single
 * response. There is no way for the chart to show one moment, the chain
 * another, and the annotations a third — which is exactly what happens when
 * three panels each fetch their own data on their own timer.
 */
@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    @Inject(MARKET_DATA) private readonly marketData: MarketDataProvider,
    private readonly engine: SentinelIntelligenceService,
    private readonly annotations: AnnotationEngineService,
    private readonly rules: TradingViewRuleService,
  ) {}

  async build(request: ReasonRequest): Promise<WorkspacePayload> {
    // The reasoning run happens first: the annotations are a *visualization of
    // the reasoning*, not a separate analysis that might disagree with it.
    const run = await this.engine.reason({ ...request, query: request.query ?? 'draw the strategy workspace' });
    const understood = run.understood;
    const symbol = understood.market.symbol;

    const candles = await this.loadCandles(symbol, understood.timeframe);
    const shared = await this.engine.computeSharedState(symbol, request, new Date());
    const context = buildChartContext(candles, shared.snapshot);

    const ruleMatches = this.rules.evaluate(context, symbol, understood.timeframe);
    const annotations = this.annotations.build(context, understood, ruleMatches);

    const optionContext = understood.market.hasOptionChain
      ? await this.buildOptionPanel(symbol, context, understood)
      : null;

    return {
      runId: run.runId,
      symbol,
      timeframe: understood.timeframe,
      candles: candles.map(serializeCandle),
      optionContext,
      annotations,
      reasoning: run,
      panes: derivePanes(annotations),
      ruleMatches: ruleMatches.map((m) => ({
        id: m.spec.id,
        name: m.spec.name,
        matched: m.matched,
        score: Number(m.score.toFixed(3)),
        met: m.metNotes,
        unmet: m.unmetNotes,
      })),
    };
  }

  private async loadCandles(symbol: string, timeframe: Timeframe): Promise<Candle[]> {
    const { interval, days } = BARS_BY_TIMEFRAME[timeframe];
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    try {
      return await this.marketData.getCandles(symbol, interval, from, to);
    } catch (err) {
      // An empty series produces an empty chart with no annotations, which is
      // honest. Fabricating bars to fill the panel would be the opposite.
      this.logger.warn(`could not load candles for ${symbol} ${timeframe}: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Panel 2 — the option chain around the strike in focus.
   *
   * When the user named no strike, the chain is centred on the ATM strike
   * (snapped to the instrument's own step) and `strikeSource` records that the
   * system chose it. A UI that cannot distinguish "the user asked about 24500"
   * from "we picked 24500" will eventually present one as the other.
   */
  private async buildOptionPanel(
    symbol: string,
    context: ChartContext,
    understood: ReasoningRun['understood'],
  ): Promise<OptionContextPanel | null> {
    let chain: OptionChainEntry[] = [];
    try {
      chain = await this.marketData.getOptionChain(symbol);
    } catch (err) {
      this.logger.warn(`option chain unavailable for ${symbol}: ${(err as Error).message}`);
    }

    const spot = context.candles[context.candles.length - 1]?.close ?? context.snapshot?.lastPrice ?? 0;
    if (chain.length === 0 || spot <= 0) return null;

    // Front expiry only — mixing expiries makes both the rows and the summary
    // meaningless, the same reasoning the existing `readOptionChain` applies.
    const frontExpiry = chain.reduce(
      (earliest, e) => (e.expiry.getTime() < earliest.getTime() ? e.expiry : earliest),
      chain[0].expiry,
    );
    const strikes = chain
      .filter((e) => e.expiry.getTime() === frontExpiry.getTime())
      .sort((a, b) => a.strike - b.strike);
    if (strikes.length === 0) return null;

    const step = understood.market.strikeStep ?? inferStrikeStep(strikes.map((s) => s.strike));
    const atm = step > 0 ? Math.round(spot / step) * step : nearestStrike(strikes, spot);
    const selectedStrike = understood.strike ?? atm;
    const strikeSource: OptionContextPanel['strikeSource'] =
      understood.strike !== null ? 'user' : 'atm-snap';

    // A window around the strike in focus rather than the whole chain: forty
    // rows of deep-OTM strikes bury the ones that matter.
    const windowSize = 10;
    const centreIndex = strikes.reduce(
      (best, entry, i) =>
        Math.abs(entry.strike - selectedStrike) < Math.abs(strikes[best].strike - selectedStrike) ? i : best,
      0,
    );
    const rows: OptionContextRow[] = strikes
      .slice(Math.max(0, centreIndex - windowSize), centreIndex + windowSize + 1)
      .map((entry) => ({
        strike: entry.strike,
        callOI: entry.callOI,
        putOI: entry.putOI,
        callVolume: entry.callVolume,
        putVolume: entry.putVolume,
        callLtp: entry.callLtp ?? null,
        putLtp: entry.putLtp ?? null,
        callIV: entry.callIV ?? null,
        putIV: entry.putIV ?? null,
        selected: Math.abs(entry.strike - selectedStrike) < 1e-6,
        stepsFromSpot: step > 0 ? Math.round((entry.strike - atm) / step) : 0,
      }));

    const summary = context.snapshot?.optionChain ?? null;

    return {
      underlying: symbol,
      spot,
      selectedStrike,
      selectedRight: understood.right,
      strikeSource,
      expiry: frontExpiry.toISOString(),
      rows,
      summary: summary
        ? {
            pcr: summary.pcr,
            maxPain: summary.maxPain,
            callOIWall: summary.callOIWall,
            putOIWall: summary.putOIWall,
            strikesAnalysed: summary.strikesAnalysed,
          }
        : null,
    };
  }

  /** Learn a TradingView strategy specification. */
  learnRule(spec: unknown) {
    return this.rules.learn(spec);
  }

  listRules() {
    return this.rules.list();
  }

  retireRule(id: string) {
    return this.rules.retire(id);
  }
}

/** Panes present in the annotation set, price always first. */
export function derivePanes(annotations: WorkspaceView['annotations']): WorkspaceView['panes'] {
  const present = new Set(annotations.map((a) => a.pane));
  const ordered: WorkspaceView['panes'] = ['price'];
  for (const pane of ['rsi', 'macd', 'volume'] as const) {
    if (present.has(pane)) ordered.push(pane);
  }
  return ordered;
}

/** Modal gap between adjacent strikes — the instrument's real step. */
export function inferStrikeStep(strikes: number[]): number {
  if (strikes.length < 2) return 0;
  const sorted = [...strikes].sort((a, b) => a - b);
  const gaps = new Map<number, number>();
  for (let i = 1; i < sorted.length; i++) {
    const gap = Math.round(sorted[i] - sorted[i - 1]);
    if (gap > 0) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  if (gaps.size === 0) return 0;
  // Modal rather than minimum: a chain with one missing strike has a double
  // gap somewhere, and taking the minimum would still be right, but taking the
  // mean would not. Modal is robust to both.
  return [...gaps.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function nearestStrike(strikes: OptionChainEntry[], spot: number): number {
  return strikes.reduce((best, e) => (Math.abs(e.strike - spot) < Math.abs(best - spot) ? e.strike : best), strikes[0].strike);
}
