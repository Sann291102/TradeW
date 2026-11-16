/**
 * Cross-market strategy performance — which strategies work in which markets.
 *
 * The experiment's actual output:
 *
 *   | Market | Strategy | Trades | Win rate | P&L | Drawdown | Profit factor | Avg |
 *
 * Built ONLY from `ExecutionJournal` rows, which exist only for positions that
 * actually closed. Nothing here simulates, back-fills or extrapolates: an
 * empty market produces an empty row group, not a zero.
 *
 * ## THE CURRENCY RULE — why there is no total column
 *
 * Indian P&L is INR. Crypto P&L is USD. There is no FX conversion anywhere in
 * the paper-wallet path — `PaperWallet` is rupees end to end and `CryptoWallet`
 * is dollars end to end, deliberately, because "adding one to satisfy crypto
 * would put a conversion rate inside every existing money calculation".
 *
 * So a cross-market P&L total is not a number this system can honestly produce,
 * and the temptation to produce one anyway is the single most likely way this
 * comparison becomes misleading. Two structural defences:
 *
 *   1. Absolute P&L is reported PER ROW with its own `currency`, and there is
 *      no aggregate field for it anywhere in this response. A caller cannot sum
 *      what is not there.
 *   2. The RANKING is computed on currency-free measures only — win rate,
 *      profit factor, and mean R. R is a ratio of realised P&L to the risk
 *      budgeted for that trade, so it is dimensionless and genuinely comparable
 *      across a ₹ option and a $ coin.
 *
 * ## Why small samples are SUPPRESSED rather than shown
 *
 * `backtest-metrics.spec.ts` already pins this rule for backtests: some numbers
 * are "suppressed for insufficient sample rather than printed as if they meant
 * something". The same applies with more force here, because the whole purpose
 * is comparison — and a 100% win rate over two trades placed beside a 54% win
 * rate over two hundred invites exactly the wrong conclusion. Below the floor,
 * the derived metrics are null and `sampleSufficient` is false.
 *
 * ## The confounds are reported, not hidden
 *
 * Three properties differ between these markets in ways that affect results
 * independently of strategy quality, so each row carries them:
 *
 *   · `longOnly` — spot crypto cannot short (`CryptoPosition.quantity` is
 *     documented ">= 0"), so BTC acts on bullish signals only. A strategy that
 *     scores better on gold may simply have been allowed to trade both
 *     directions there.
 *   · `sessionKind` — 24/7 versus a bounded session. A continuous market gives
 *     a strategy more opportunities per calendar day and no overnight gap.
 *   · `eodFlatten` — Indian and MCX positions are squared off; crypto ones are
 *     not. That truncates losers and winners alike, and changes what a holding
 *     period means.
 *
 * Leaving these to be inferred from the numbers is how a comparison becomes an
 * argument rather than evidence.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  marketForSymbol,
  tradableSpec,
  venueRequiresEodFlatten,
  venueSession,
  type ExperimentMarket,
} from '@tradew/market-data';

/**
 * Closed trades a (market, strategy) bucket needs before its derived metrics
 * are reported at all.
 *
 * 20 is not a statistical threshold — no honest one exists for this — it is the
 * point below which a win rate's confidence interval is so wide that showing it
 * next to a large sample misleads more than it informs. Stated as a constant so
 * the choice is arguable rather than buried.
 */
export const MIN_SAMPLE = 20;

export interface CrossMarketRow {
  market: ExperimentMarket;
  strategyId: string | null;
  strategyName: string;

  trades: number;
  /** True once `trades >= MIN_SAMPLE`. Derived metrics are null below it. */
  sampleSufficient: boolean;

  // ---- Currency-free. Comparable across markets. -------------------------
  /** Fraction 0-1, or null below the sample floor. */
  winRate: number | null;
  /** Gross profit / gross loss. Null below the floor, or when there are no
   *  losses at all — an infinite profit factor is not a large one, and
   *  rendering it as a number invites a comparison that means nothing. */
  profitFactor: number | null;
  /**
   * Mean R per trade — the headline comparable, and the ranking key.
   *
   * This IS the expectancy. Expectancy is (avg win R × win rate) + (avg loss R
   * × loss rate), which is algebraically the mean of every trade's R — so a
   * separate `expectancyR` field would be the same number under a second name,
   * and two columns showing one measure invites a reader to treat them as
   * corroborating evidence. One field, named for what it is.
   */
  avgR: number | null;
  /** Worst peak-to-trough of the cumulative R curve, in R. Null below floor. */
  maxDrawdownR: number | null;

  // ---- Absolute. NEVER comparable, never summed. -------------------------
  /** Net realised P&L in `currency`. Reported per row only. */
  netPnl: number;
  currency: 'INR' | 'USD';
  avgTradePnl: number;

  // ---- Confounds, reported so they are not inferred ----------------------
  longOnly: boolean;
  sessionKind: 'session' | 'continuous';
  eodFlatten: boolean;
  /** Symbols that contributed, so a row's provenance is checkable. */
  symbols: string[];
}

export interface CrossMarketReport {
  windowDays: number;
  rows: CrossMarketRow[];
  /** Markets with no closed trades in the window. Named, not omitted. */
  marketsWithNoData: ExperimentMarket[];
  /** Machine-readable caveats the UI must render alongside the table. */
  caveats: string[];
  minSample: number;
}

@Injectable()
export class CrossMarketPerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async report(days = 30): Promise<CrossMarketReport> {
    const since = new Date(Date.now() - days * 86_400_000);

    const journals = await this.prisma.executionJournal.findMany({
      where: { exitAt: { not: null, gte: since } },
      orderBy: { exitAt: 'asc' },
      select: {
        symbol: true,
        strategyId: true,
        strategyName: true,
        realizedPnl: true,
        rMultiple: true,
        result: true,
      },
    });

    // Group by (market, strategy). A journal row whose symbol is outside the
    // experiment registry is EXCLUDED rather than bucketed under a default —
    // `marketForSymbol` returns null precisely so a stray symbol is visibly
    // ungrouped instead of silently attributed to the market with the most
    // history.
    const buckets = new Map<string, {
      market: ExperimentMarket;
      strategyId: string | null;
      strategyName: string;
      symbols: Set<string>;
      pnls: number[];
      rs: number[];
      wins: number;
    }>();

    for (const j of journals) {
      const market = marketForSymbol(j.symbol);
      if (!market) continue;

      const strategyId = j.strategyId ?? null;
      const key = `${market}::${strategyId ?? 'unattributed'}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          market,
          strategyId,
          strategyName: j.strategyName ?? 'Unattributed',
          symbols: new Set(),
          pnls: [],
          rs: [],
          wins: 0,
        };
        buckets.set(key, bucket);
      }

      bucket.symbols.add(j.symbol);
      const pnl = Number(j.realizedPnl);
      bucket.pnls.push(pnl);
      // `rMultiple` is nullable — a trade whose risk budget was not recorded
      // has no R. Pushed only when present, so the mean is over trades that
      // actually have one rather than treating a missing measurement as zero.
      // `post-trade-analysis.spec.ts` pins the same rule: "a missing
      // measurement is not a zero".
      if (j.rMultiple != null) bucket.rs.push(Number(j.rMultiple));
      // WIN is defined on realised P&L, not on `result`, so it means the same
      // thing in every market regardless of which exit reasons a venue can
      // produce. A scratch (exactly 0) is not a win.
      if (pnl > 0) bucket.wins += 1;
    }

    const rows = Array.from(buckets.values())
      .map((b) => this.toRow(b))
      // Rank by mean R — the currency-free measure, and the only one of these
      // that can order a rupee option against a dollar coin. Rows below the
      // sample floor sort last regardless of their raw numbers, so a two-trade
      // fluke never heads the table.
      .sort((a, b) => {
        if (a.sampleSufficient !== b.sampleSufficient) return a.sampleSufficient ? -1 : 1;
        return (b.avgR ?? -Infinity) - (a.avgR ?? -Infinity);
      });

    const present = new Set(rows.map((r) => r.market));
    const marketsWithNoData = (['INDIA', 'CRYPTO', 'GOLD'] as const).filter(
      (m) => !present.has(m),
    );

    return {
      windowDays: days,
      rows,
      marketsWithNoData,
      caveats: this.caveats(rows),
      minSample: MIN_SAMPLE,
    };
  }

  private toRow(b: {
    market: ExperimentMarket;
    strategyId: string | null;
    strategyName: string;
    symbols: Set<string>;
    pnls: number[];
    rs: number[];
    wins: number;
  }): CrossMarketRow {
    const trades = b.pnls.length;
    const sampleSufficient = trades >= MIN_SAMPLE;
    const netPnl = b.pnls.reduce((s, v) => s + v, 0);

    const symbols = Array.from(b.symbols).sort();
    // Every symbol in a bucket shares a market, so any of them answers the
    // venue questions. Falling back to the first is safe by construction.
    const spec = tradableSpec(symbols[0] ?? '');
    const currency = spec?.quoteCurrency ?? 'INR';
    const venue = spec?.venue ?? 'NSE';
    const session = venueSession(venue);

    const derived = sampleSufficient
      ? {
          winRate: b.wins / trades,
          profitFactor: this.profitFactor(b.pnls),
          avgR: b.rs.length ? b.rs.reduce((s, v) => s + v, 0) / b.rs.length : null,
          maxDrawdownR: b.rs.length ? this.maxDrawdownR(b.rs) : null,
        }
      : { winRate: null, profitFactor: null, avgR: null, maxDrawdownR: null };

    return {
      market: b.market,
      strategyId: b.strategyId,
      strategyName: b.strategyName,
      trades,
      sampleSufficient,
      ...derived,
      netPnl,
      currency,
      avgTradePnl: trades ? netPnl / trades : 0,
      // Spot crypto has no short side; options and futures do.
      longOnly: spec?.executionStyle === 'spot',
      sessionKind: session.kind,
      eodFlatten: venueRequiresEodFlatten(venue),
      symbols,
    };
  }

  /**
   * Gross profit / gross loss.
   *
   * Null when there were no losing trades. An "infinite" profit factor is not a
   * very good one — it is an undefined ratio over a sample that has not yet met
   * its first loss — and printing a large number for it would rank a lucky
   * streak above a genuinely robust strategy.
   */
  private profitFactor(pnls: number[]): number | null {
    let profit = 0;
    let loss = 0;
    for (const p of pnls) {
      if (p > 0) profit += p;
      else loss += Math.abs(p);
    }
    if (loss === 0) return null;
    return profit / loss;
  }

  /**
   * Worst peak-to-trough decline of the cumulative R curve.
   *
   * In R rather than in currency, for the same reason everything else
   * comparable here is: a ₹40,000 drawdown and a $600 one cannot be ranked
   * against each other, but −4.2R and −2.8R can.
   *
   * The peak is seeded at 0, not at the first value — matching
   * `execution-drawdown.ts`, whose comment records why: seeding at the first
   * point means a curve that is negative throughout reports no drawdown at all.
   */
  private maxDrawdownR(rs: number[]): number {
    let cumulative = 0;
    let peak = 0;
    let worst = 0;
    for (const r of rs) {
      cumulative += r;
      if (cumulative > peak) peak = cumulative;
      const dd = peak - cumulative;
      if (dd > worst) worst = dd;
    }
    return worst;
  }

  /** The caveats a reader must have in front of them to read the table right. */
  private caveats(rows: CrossMarketRow[]): string[] {
    const out: string[] = [
      'Absolute P&L is per-market and per-currency. It is never summed across markets: ' +
        'there is no FX conversion anywhere in the paper-wallet path, so a combined total would be a fabricated number.',
      `Derived metrics are withheld below ${MIN_SAMPLE} closed trades — a 100% win rate over two trades ` +
        'beside a 54% rate over two hundred invites exactly the wrong conclusion.',
    ];

    if (rows.some((r) => r.longOnly)) {
      out.push(
        'Spot crypto is LONG-ONLY: bearish signals are refused rather than traded, and are counted as ' +
          '`spot-long-only` refusals. A market that could trade both directions had more opportunities, ' +
          'independent of strategy quality.',
      );
    }
    if (rows.some((r) => r.sessionKind === 'continuous') && rows.some((r) => r.sessionKind === 'session')) {
      out.push(
        'These markets do not share a clock. A 24/7 venue offers more opportunities per calendar day and ' +
          'has no overnight gap; a session venue squares off intraday, truncating winners and losers alike.',
      );
    }
    return out;
  }
}
