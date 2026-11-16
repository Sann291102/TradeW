import { Inject, Injectable } from '@nestjs/common';
import {
  Candle,
  CandleInterval,
  MarketBreadth,
  MarketDataProvider,
  OptionChainEntry,
  resolveActiveExpiry,
} from '@tradew/types';
import { MarketProfile, MarketProfileType, Signal, TrendAnalysis } from '../domain';
import { atmStrikeFor } from '../strategy/option-context';
import {
  alignContracts,
  readLeg,
  unreadableLeg,
  type ContractAlignment,
  type LegRead,
} from './contract-alignment';
import {
  averageVolume,
  cpr,
  ema,
  macd,
  oiTrend,
  realizedVolatilityPct,
  rsi,
  swingLevels,
  vwap,
} from './indicators';

export const MARKET_DATA = 'MARKET_DATA_PROVIDER';

// Snapshot windowing constants and the forming-bar split, moved to
// `@tradew/strategy-core/features` with the rest of the feature builder.
// `splitClosedAndForming` in particular is load-bearing for every rule that
// measures the newest bar, so it must be the same implementation the
// backtester and the autonomous engine use.
// Imported as well as re-exported: `export … from` creates no local binding,
// and `MarketIntelligenceService` below calls these directly.
import {
  SNAPSHOT_INTERVAL,
  SNAPSHOT_LOOKBACK_MS,
  composeSnapshot,
  readOptionChain,
  sessionSlice,
} from '@tradew/strategy-core';

export {
  SNAPSHOT_INTERVAL,
  SNAPSHOT_LOOKBACK_MS,
  INTERVAL_MS,
  splitClosedAndForming,
} from '@tradew/strategy-core';

/**
 * `MarketSnapshot`, `OptionChainRead` and the bar-time helpers now live in
 * `@tradew/strategy-core`.
 *
 * They are the contract between "how the bars were obtained" and "what the
 * strategy decides", so they had to sit below both Sentinel and the autonomous
 * execution engine rather than inside one of them. Re-exported from here
 * unchanged: every existing `import { MarketSnapshot } from
 * './market-intelligence.service'` in the tree stays correct, and there is
 * still exactly ONE declaration of each type in the repository — two
 * structurally-identical copies would type-check against each other and then
 * drift, which is the failure this move exists to prevent.
 */

import {
  latestBarAt,
  latestDataAt,
  liveCandles,
  type MarketSnapshot,
  type OptionChainRead,
} from '@tradew/strategy-core';

export { latestBarAt, latestDataAt, liveCandles };
export type { MarketSnapshot, OptionChainRead };

/**
 * Market & Technical Intelligence agent (deterministic half) —
 * Module 1 of the Sentinel Master Plan.
 *
 * Computes structure/indicators, classifies the session into one of ten
 * market profiles, and emits observation-only signals — "Momentum is
 * weakening", never "sell".
 */
@Injectable()
export class MarketIntelligenceService {
  constructor(@Inject(MARKET_DATA) private readonly marketData: MarketDataProvider) {}

  async snapshot(symbol: string): Promise<MarketSnapshot> {
    const to = new Date();
    const from = new Date(to.getTime() - SNAPSHOT_LOOKBACK_MS);

    // ── FOUR INDEPENDENT READS, CONCURRENTLY ──────────────────────────────
    //
    // These were four sequential `await`s. Nothing among them depends on
    // another — `composeSnapshot` below takes them as independent inputs — so
    // the serialization bought nothing and cost three round trips on the
    // critical path of a request that every open workspace polls every 10-30 s.
    // Measured 2026-08-17: p50 2,178 ms and p95 7,703 ms against this method's
    // own design note claiming ~1.6 s.
    //
    // It matters for CAPACITY, not just latency. A request that holds its
    // resources three round trips longer than necessary holds a worker, a
    // socket and a Prisma connection for that whole time at every tier, and the
    // number of concurrent in-flight requests is what exhausts those pools.
    //
    // `allSettled`, not `all`, purely to keep this change BEHAVIOUR-NEUTRAL.
    // Both candle reads could fail the observation before and still must; but
    // `Promise.all` rejects with whichever settled first, so a run where both
    // failed would report a different fault from one run to the next. The
    // intraday read is the primary input — every rule in `strategy-rules.ts` is
    // computed from those bars — so its error keeps precedence exactly as it had
    // when these were sequential. Breadth and the chain degrade to "no data" as
    // they always did.
    const [intraday, breadthResult, daily, chainResult] = await Promise.allSettled([
      this.marketData.getCandles(symbol, SNAPSHOT_INTERVAL, from, to),
      this.marketData.getMarketBreadth(),
      this.marketData.getCandles(symbol, '1d', new Date(to.getTime() - 10 * 86_400_000), to),
      this.marketData.getOptionChain(symbol),
    ]);

    if (intraday.status === 'rejected') throw intraday.reason;
    if (daily.status === 'rejected') throw daily.reason;

    const candles = intraday.value;
    const dayCandles = daily.value;
    const breadth: MarketBreadth =
      breadthResult.status === 'fulfilled' ? breadthResult.value : { advances: 0, declines: 0, unchanged: 0 };
    // Not every instrument has a chain (cash equities, the index itself on some
    // providers). A failure here degrades the option factor to "no data" rather
    // than failing the whole observation.
    const chain: OptionChainEntry[] = chainResult.status === 'fulfilled' ? chainResult.value : [];

    // The LIVE last bar, deliberately — this is the spot the option chain is
    // read against, and max pain relative to a spot a bar behind is max pain
    // relative to the wrong number. `composeSnapshot` drops the forming bar
    // from everything that measures a bar; this is not one of those.
    const last = candles[candles.length - 1];
    // `dayCandles[length - 2]`, not `[length - 1]`: the newest daily bar is
    // today's, still forming. The daily series has always been handled this
    // way — the intraday series is what had not been.
    const priorDay = dayCandles[dayCandles.length - 2] ?? null;

    return composeSnapshot(
      symbol,
      candles,
      priorDay,
      {
        vix: breadth.vix ?? null,
        breadthRatio: breadth.declines > 0 ? breadth.advances / breadth.declines : null,
        optionChain: readOptionChain(chain, last?.close ?? 0),
      },
      { interval: SNAPSHOT_INTERVAL, now: to },
    );
  }

  /**
   * Read the CE and PE legs at the at-the-money strike, on the SAME bars as
   * the snapshot.
   *
   * This is the engine half of the workspace's three-chart panel. Until
   * 2026-08-16 that panel drew an index, a call and a put while the engine
   * read only the index; see `contract-alignment.ts` for why the premium
   * series cannot be inferred from the underlying.
   *
   * ── THE INTERVAL IS NOT A CHOICE ──────────────────────────────────────
   * `SNAPSHOT_INTERVAL` is used for all three series because comparing a 15m
   * index move against a 1m premium move compares different amounts of time
   * and calls the difference divergence. The whole read is only meaningful on
   * one clock.
   *
   * ── HONEST DEGRADATION ────────────────────────────────────────────────
   * Every failure here is named and none is fatal. No options market, a
   * provider without the optional capability, a bridge that declined one leg:
   * each produces a `ContractAlignment` that says so. The underlying's
   * observation is unaffected — this is additional evidence, never a gate on
   * the read the workspace already produced.
   */
  async contracts(snapshot: MarketSnapshot): Promise<ContractAlignment> {
    // ── THE ONE PLACE THAT PUTS THE FORMING BAR BACK ──────────────────────
    // `readSeries` measures each series from its first open to its last close,
    // and the CE/PE legs below are fetched raw — so they carry their own
    // forming bars. Comparing a closed-bar index against forming-bar premiums
    // would compare different amounts of time and then call the difference
    // divergence, which is the exact failure the shared `SNAPSHOT_INTERVAL`
    // exists to prevent. Symmetry matters more here than closure, and nothing
    // in this method measures a single bar's range or volume.
    // Re-sliced from the live series rather than appending the forming bar to
    // `sessionCandles`: on the session's FIRST bar the closed bars still end on
    // yesterday, so appending would hand `readSeries` a two-day span and report
    // yesterday's open as today's. Slicing the live series picks the newest
    // calendar day present, which is the one bar that has actually traded.
    const live = liveCandles(snapshot);
    const session = sessionSlice(live);
    const bars = session.length ? session : live;
    const base = {
      underlying: snapshot.symbol,
      interval: SNAPSHOT_INTERVAL,
      indexCandles: bars,
    };

    // The capability check, not a try/catch: a provider that cannot read
    // contracts at all is a different state from one whose read failed, and
    // the panel says a different thing for each.
    if (!this.marketData.getOptionCandles || !this.marketData.getOptionExpiries) {
      return alignContracts({
        ...base,
        expiry: null,
        strike: null,
        ce: null,
        pe: null,
        contractsReadable: false,
      });
    }

    // ── A FAILED EXPIRY READ IS NOT "NO OPTIONS MARKET" ───────────────────
    //
    // This used to be `.catch(() => [])`, which fed the `!expiry` branch below
    // and therefore reported `contractsReadable: true` — "the provider can read
    // contracts, this instrument simply has none". For NIFTY that is false, and
    // on 2026-08-17 it was the claim the workspace made all session while the
    // real fault was a refused Dhan credential.
    //
    // The distinction already exists in this method's own vocabulary:
    // `contractsReadable: false` is "we could not read", which is exactly what a
    // thrown expiry read means. Using it costs nothing and makes the panel say
    // the true thing.
    let expiries: string[];
    try {
      expiries = await this.marketData.getOptionExpiries(snapshot.symbol);
    } catch (err) {
      return alignContracts({
        ...base,
        expiry: null,
        strike: null,
        ce: null,
        pe: null,
        contractsReadable: false,
        unreadableReason: (err as Error).message,
      });
    }
    /**
     * The active series, through the canonical resolver rather than a bare
     * `expiries[0]`.
     *
     * `getOptionExpiries` already drops expired contracts, so this is belt to
     * that braces — but the two legs read below are the CE/PE premium series
     * this engine reports to the user, and reading them off a dead contract
     * produces an empty history that renders as a quiet market rather than a
     * rolled-over series. The 2026-08-19 rollover made exactly that mistake one
     * layer up. There is one function that answers this question; this is it.
     */
    const expiry = resolveActiveExpiry({ symbol: snapshot.symbol, availableExpiries: expiries }).value;
    const strike = atmStrikeFor(snapshot.symbol, snapshot.lastPrice);

    // No options market (a commodity, most equities) or no usable spot. Not a
    // fault — `contractsReadable` stays true because the provider CAN read
    // contracts, there simply are none for this instrument.
    if (!expiry || strike == null) {
      return alignContracts({ ...base, expiry, strike, ce: null, pe: null, contractsReadable: true });
    }

    // The window the index bars cover, so the legs are read over the same
    // stretch of market rather than the same number of days.
    const from = bars[0]?.timestamp ?? new Date(Date.now() - SNAPSHOT_LOOKBACK_MS);
    const to = new Date();

    const [ce, pe] = await Promise.all([
      this.readLegCandles(snapshot.symbol, expiry, strike, 'CE', from, to),
      this.readLegCandles(snapshot.symbol, expiry, strike, 'PE', from, to),
    ]);

    return alignContracts({ ...base, expiry, strike, ce, pe, contractsReadable: true });
  }

  /** One leg, with its failure recorded rather than thrown. */
  private async readLegCandles(
    symbol: string,
    expiry: string,
    strike: number,
    side: 'CE' | 'PE',
    from: Date,
    to: Date,
  ): Promise<LegRead> {
    try {
      const candles = await this.marketData.getOptionCandles!({ symbol, expiry, strike, side }, SNAPSHOT_INTERVAL, from, to);
      return readLeg(side, strike, candles);
    } catch (err) {
      // One leg failing must not take the other down with it: an illiquid put
      // at a strike whose call trades heavily is a normal, readable state.
      return unreadableLeg(side, strike, (err as Error).message);
    }
  }

  signals(s: MarketSnapshot): Signal[] {
    const out: Signal[] = [];
    const sig = (name: string, triggered: boolean, weight: number, evidence: string[], data?: Record<string, unknown>) =>
      out.push({ name, agent: 'market-technical', triggered, weight, evidence, data });

    if (s.rsi14 !== null) {
      sig('overbought_rsi', s.rsi14 > 70, 0.2, [`RSI(14) is ${s.rsi14.toFixed(1)}${s.rsi14 > 70 ? ', above 70' : ''}`], { rsi: s.rsi14 });
      sig('oversold_rsi', s.rsi14 < 30, 0.2, [`RSI(14) is ${s.rsi14.toFixed(1)}${s.rsi14 < 30 ? ', below 30' : ''}`], { rsi: s.rsi14 });
    }
    if (s.macdHistogram !== null) {
      sig('weakening_momentum', s.macdHistogram < 0, 0.2, [`MACD histogram is ${s.macdHistogram.toFixed(2)} (below signal line)`]);
    }
    if (s.ema20 !== null && s.ema50 !== null) {
      const below = s.lastPrice < s.ema20 && s.ema20 < s.ema50;
      sig('below_key_emas', below, 0.15, [`Price ${s.lastPrice.toFixed(1)} vs EMA20 ${s.ema20.toFixed(1)} / EMA50 ${s.ema50.toFixed(1)}`]);
    }
    if (s.vix !== null) {
      sig('elevated_vix', s.vix > 18, 0.3, [`India VIX at ${s.vix.toFixed(1)}${s.vix > 18 ? ' — elevated' : ''}`], { vix: s.vix });
    }
    if (s.realizedVolPct !== null) {
      sig('elevated_realized_vol', s.realizedVolPct > 1.2, 0.2, [`Realized volatility ${s.realizedVolPct.toFixed(2)}% per bar over the last 20 bars`]);
    }
    if (s.volumeVsAvg !== null) {
      sig('below_average_participation', s.volumeVsAvg < 0.7, 0.2, [`Current volume is ${(s.volumeVsAvg * 100).toFixed(0)}% of the 20-bar average`]);
    }
    if (s.breadthRatio !== null) {
      sig('weak_breadth', s.breadthRatio < 0.8, 0.15, [`Advance/decline ratio is ${s.breadthRatio.toFixed(2)}`]);
    }
    if (s.cpr) {
      const insideCpr = s.lastPrice >= s.cpr.bc && s.lastPrice <= s.cpr.tc;
      sig('consolidating_in_cpr', insideCpr, 0.1, [`Price is trading inside the Central Pivot Range (${s.cpr.bc.toFixed(1)}–${s.cpr.tc.toFixed(1)})`]);
    }

    // ---- Module 1 profile-derived signals -------------------------------
    // The profile itself is not a warning; these are the three regimes where
    // the classification genuinely raises something worth being aware of.
    if (s.marketProfile) {
      const p = s.marketProfile;
      sig(
        'volatility_compression',
        p.type === 'Low Volatility Compression' || p.type === 'Inside Day',
        0.15,
        [`Session profile is ${p.type}: ${p.description}`],
        { profile: p.type },
      );
      sig(
        'range_expansion',
        p.type === 'Outside Day / Expansion' || p.type === 'High Volatility Range',
        0.2,
        [`Session profile is ${p.type}: ${p.description}`],
        { profile: p.type },
      );
      sig(
        'gap_driven_session',
        p.type === 'Gap & Go' || p.type === 'Gap Fill / Mean Reversion',
        0.2,
        [`Session profile is ${p.type}: ${p.description}`],
        { profile: p.type },
      );
    }

    // ---- option chain (Module 1 "Market Dynamics") ----------------------
    if (s.optionChain) {
      const oc = s.optionChain;
      const pinDistPct = s.lastPrice > 0 ? Math.abs(s.lastPrice - oc.maxPain) / s.lastPrice : 1;
      sig(
        'option_writers_pin_risk',
        pinDistPct < 0.003,
        0.2,
        [
          `Max pain sits at ${oc.maxPain.toFixed(0)}, ${(pinDistPct * 100).toFixed(2)}% from spot ${s.lastPrice.toFixed(1)} (${oc.strikesAnalysed} strikes, front expiry)`,
        ],
        { maxPain: oc.maxPain, pcr: oc.pcr },
      );
      sig(
        'lopsided_put_call_ratio',
        oc.pcr > 1.5 || oc.pcr < 0.6,
        0.15,
        [`Put-Call OI ratio is ${oc.pcr.toFixed(2)}${oc.pcr > 1.5 ? ' — heavily put-weighted' : oc.pcr < 0.6 ? ' — heavily call-weighted' : ''}`],
        { pcr: oc.pcr },
      );
    }

    return out;
  }
}

// ------------------------------------------------------------------ helpers
// Pure, deterministic and unit-testable — same contract as `indicators.ts`,
// no injected state, so the profile classifier can be exercised directly.

// The feature/context builder moved to `@tradew/strategy-core/features`.
//
// It is the step that turns bars into a `MarketSnapshot`, and the autonomous
// engine has to run it with Sentinel switched off — so it could not stay
// inside a Nest service in another process. Re-exported unchanged, so every
// existing import from this module keeps working and there is still exactly
// ONE implementation in the repository.
export {
  composeSnapshot,
  sessionSlice,
  computeOpeningRange,
  readOptionChain,
  analyseTrend,
  classifyProfile,
} from '@tradew/strategy-core';
