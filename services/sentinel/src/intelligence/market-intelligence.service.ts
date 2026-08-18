import { Inject, Injectable } from '@nestjs/common';
import { Candle, CandleInterval, MarketBreadth, MarketDataProvider, OptionChainEntry } from '@tradew/types';
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

/**
 * The bars every Sentinel observation is computed on.
 *
 * Named because it is now read in two places — the underlying snapshot and the
 * CE/PE legs beside it — and because the workspace captions its charts with
 * it. It had been an inline `'15m'` while the browser drew a 5m index and 1m
 * contracts, so the user and the engine were looking at different bars with
 * nothing on screen saying so. One constant, exported, is what keeps the chart
 * and the verdict describing the same market.
 */
export const SNAPSHOT_INTERVAL: CandleInterval = '15m';

/** How far back a snapshot reaches. Enough bars for a 50-period EMA at 15m. */
export const SNAPSHOT_LOOKBACK_MS = 5 * 86_400_000;

export interface MarketSnapshot {
  symbol: string;
  lastPrice: number;
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  vwap: number | null;
  macdHistogram: number | null;
  cpr: { pivot: number; bc: number; tc: number } | null;
  volumeVsAvg: number | null; // last volume / 20-period average
  oiTrend: 'rising' | 'falling' | 'flat' | 'unknown';
  realizedVolPct: number | null;
  vix: number | null;
  breadthRatio: number | null; // advances / declines
  support: number | null;
  resistance: number | null;
  candles: Candle[];
  /** the bars belonging to the most recent session in `candles` */
  sessionCandles: Candle[];
  /** the prior completed daily bar, when history reaches back that far */
  priorDay: Candle | null;
  /** Module 1 — today's regime classification */
  marketProfile: MarketProfile | null;
  /** Module 1 — directional read of the current session */
  trendAnalysis: TrendAnalysis | null;
  /** opening range (first 30 minutes of the session), when derivable */
  openingRange: { high: number; low: number; establishedAt: Date } | null;
  /** front-expiry option chain analytics — null when the instrument has no chain */
  optionChain: OptionChainRead | null;
}

/**
 * The bar this snapshot was built on — the market-event time of anything
 * derived from it.
 *
 * Every rule in `strategy-rules.ts` is a pure function of the snapshot, so the
 * newest bar in it IS the moment the market did whatever a detection describes.
 * The scan's own clock is a poll clock and says nothing about the market.
 *
 * Prefers the session's newest bar (what the session narrative is ordered by)
 * and falls back to the newest bar of the wider history, so a pre-market
 * snapshot with no session bars yet still reports the last real bar instead of
 * the wall clock. Returns null only when the snapshot carries no candles at
 * all — the one case where a caller genuinely has nothing but its own clock.
 */
export function latestBarAt(
  snapshot: Pick<MarketSnapshot, 'candles' | 'sessionCandles'>,
): Date | null {
  const session = snapshot.sessionCandles ?? [];
  const history = snapshot.candles ?? [];
  const bar = session[session.length - 1] ?? history[history.length - 1] ?? null;
  if (!bar) return null;
  // Declared as a Date, but the provider chain includes JSON hops where it
  // arrives as an ISO string or epoch ms. Normalising here keeps every caller
  // from having to know that.
  const at = bar.timestamp instanceof Date ? bar.timestamp : new Date(bar.timestamp);
  return Number.isNaN(at.getTime()) ? null : at;
}

export interface OptionChainRead {
  /** total put OI / total call OI */
  pcr: number;
  /** the strike at which option writers lose least, i.e. the pin */
  maxPain: number;
  /** the strike carrying the most call OI above spot */
  callOIWall: number | null;
  /** the strike carrying the most put OI below spot */
  putOIWall: number | null;
  strikesAnalysed: number;
  /**
   * The expiry every entry below belongs to. `readOptionChain` already narrows
   * to the front expiry before computing anything (mixing expiries makes both
   * PCR and max pain meaningless) — this names the one it picked, so a reader
   * never has to infer it from the entries.
   */
  frontExpiry: Date;
  /**
   * The front-expiry strikes themselves, ascending.
   *
   * Exposed because the aggregates above answer "what is positioning doing?"
   * and cannot answer "what does one specific contract cost right now?" — the
   * question strike-candidate evaluation is made of. Carrying them here rather
   * than re-reading the chain keeps the observation on ONE chain read: a second
   * fetch would be a second point in time, so a candidate's premium could
   * disagree with the PCR computed beside it.
   */
  entries: OptionChainEntry[];
}

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

    const last = candles[candles.length - 1];
    const priorDay = dayCandles[dayCandles.length - 2] ?? null;

    return composeSnapshot(symbol, candles, priorDay, {
      vix: breadth.vix ?? null,
      breadthRatio: breadth.declines > 0 ? breadth.advances / breadth.declines : null,
      optionChain: readOptionChain(chain, last?.close ?? 0),
    });
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
    const bars = snapshot.sessionCandles.length ? snapshot.sessionCandles : snapshot.candles;
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
    const expiry = expiries[0] ?? null;
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

/**
 * Everything a snapshot can be derived from the bars alone. The live
 * `snapshot()` above and the Module 12 backtest replay both call this, so a
 * strategy is replayed against exactly the structure it was detected on —
 * there is no second, drifting copy of the indicator wiring.
 */
export function composeSnapshot(
  symbol: string,
  candles: Candle[],
  priorDay: Candle | null,
  external: {
    vix: number | null;
    breadthRatio: number | null;
    optionChain: OptionChainRead | null;
  },
): MarketSnapshot {
  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];
  const ema20Series = ema(closes, 20);
  const ema50Series = ema(closes, 50);
  const levels = swingLevels(candles);
  const sessionCandles = sessionSlice(candles);
  const trendAnalysis = analyseTrend(sessionCandles, candles);

  return {
    symbol,
    lastPrice: last?.close ?? 0,
    rsi14: rsi(closes),
    ema20: ema20Series[ema20Series.length - 1] ?? null,
    ema50: ema50Series[ema50Series.length - 1] ?? null,
    vwap: vwap(candles.slice(-26)),
    macdHistogram: macd(closes)?.histogram ?? null,
    cpr: priorDay ? cpr(priorDay) : null,
    volumeVsAvg: last ? last.volume / Math.max(1, averageVolume(candles)) : null,
    oiTrend: oiTrend(candles),
    realizedVolPct: realizedVolatilityPct(closes),
    vix: external.vix,
    breadthRatio: external.breadthRatio,
    support: levels?.support ?? null,
    resistance: levels?.resistance ?? null,
    candles,
    sessionCandles,
    priorDay,
    marketProfile: classifyProfile(sessionCandles, priorDay, trendAnalysis),
    trendAnalysis,
    openingRange: computeOpeningRange(sessionCandles),
    optionChain: external.optionChain,
  };
}

/** Bars belonging to the most recent calendar day present in `candles`. */
export function sessionSlice(candles: Candle[]): Candle[] {
  const last = candles[candles.length - 1];
  if (!last) return [];
  const day = last.timestamp.toDateString();
  return candles.filter((c) => c.timestamp.toDateString() === day);
}

/** Opening range from the first 30 minutes of the session. */
export function computeOpeningRange(
  sessionCandles: Candle[],
): { high: number; low: number; establishedAt: Date } | null {
  if (sessionCandles.length === 0) return null;
  const start = sessionCandles[0].timestamp.getTime();
  const window = sessionCandles.filter((c) => c.timestamp.getTime() - start < 30 * 60_000);
  if (window.length === 0) return null;
  return {
    high: Math.max(...window.map((c) => c.high)),
    low: Math.min(...window.map((c) => c.low)),
    establishedAt: window[window.length - 1].timestamp,
  };
}

/**
 * Put-Call Ratio, max pain and the nearest OI walls, from the front expiry.
 * Max pain is the strike at which option writers' aggregate payout is
 * smallest — the classic pin level. Returns null when there is no chain.
 */
export function readOptionChain(chain: OptionChainEntry[], spot: number): OptionChainRead | null {
  if (chain.length === 0) return null;

  // Front expiry only — mixing expiries makes both PCR and max pain meaningless.
  const frontExpiry = chain.reduce(
    (earliest, e) => (e.expiry.getTime() < earliest.getTime() ? e.expiry : earliest),
    chain[0].expiry,
  );
  const strikes = chain
    .filter((e) => e.expiry.getTime() === frontExpiry.getTime())
    .sort((a, b) => a.strike - b.strike);
  if (strikes.length === 0) return null;

  const totalCallOI = strikes.reduce((s, e) => s + e.callOI, 0);
  const totalPutOI = strikes.reduce((s, e) => s + e.putOI, 0);
  if (totalCallOI <= 0) return null;

  let maxPain = strikes[0].strike;
  let minLoss = Number.POSITIVE_INFINITY;
  for (const candidate of strikes) {
    const loss = strikes.reduce(
      (sum, e) =>
        sum +
        e.callOI * Math.max(0, candidate.strike - e.strike) +
        e.putOI * Math.max(0, e.strike - candidate.strike),
      0,
    );
    if (loss < minLoss) {
      minLoss = loss;
      maxPain = candidate.strike;
    }
  }

  const above = strikes.filter((e) => e.strike >= spot);
  const below = strikes.filter((e) => e.strike <= spot);
  const callOIWall = above.length
    ? above.reduce((a, b) => (b.callOI > a.callOI ? b : a)).strike
    : null;
  const putOIWall = below.length ? below.reduce((a, b) => (b.putOI > a.putOI ? b : a)).strike : null;

  return {
    pcr: totalPutOI / totalCallOI,
    maxPain,
    callOIWall,
    putOIWall,
    strikesAnalysed: strikes.length,
    frontExpiry,
    entries: strikes,
  };
}

export function analyseTrend(sessionCandles: Candle[], allCandles: Candle[]): TrendAnalysis | null {
  if (sessionCandles.length < 2) return null;
  const open = sessionCandles[0].open;
  const close = sessionCandles[sessionCandles.length - 1].close;
  const sessionChangePct = open !== 0 ? ((close - open) / open) * 100 : 0;

  // Momentum: the session's net directional travel as a fraction of its total
  // absolute travel — 1 = perfectly one-directional, 0 = pure chop.
  let net = 0;
  let gross = 0;
  for (let i = 1; i < sessionCandles.length; i++) {
    const step = sessionCandles[i].close - sessionCandles[i - 1].close;
    net += step;
    gross += Math.abs(step);
  }
  const momentumScore = gross > 0 ? Math.abs(net) / gross : 0;

  const avgVol = averageVolume(allCandles);
  const lastVol = sessionCandles[sessionCandles.length - 1].volume;

  return {
    sessionChangePct,
    momentumScore,
    volumeStrength: avgVol > 0 ? lastVol / avgVol : 1,
    direction: sessionChangePct > 0.15 ? 'bullish' : sessionChangePct < -0.15 ? 'bearish' : 'neutral',
  };
}

const PROFILE_META: Record<
  MarketProfileType,
  Pick<MarketProfile, 'description' | 'trend' | 'volatility' | 'structure'>
> = {
  'Bullish Trend Day': {
    description: 'Sustained directional advance with the close holding near the session high',
    trend: 'bullish',
    volatility: 'normal',
    structure: 'trending',
  },
  'Bearish Trend Day': {
    description: 'Sustained directional decline with the close holding near the session low',
    trend: 'bearish',
    volatility: 'normal',
    structure: 'trending',
  },
  'High Volatility Range': {
    description: 'Wide two-sided swings with no net directional resolution',
    trend: 'choppy',
    volatility: 'high',
    structure: 'ranging',
  },
  'Low Volatility Compression': {
    description: 'Range materially narrower than the prior session — energy coiling',
    trend: 'neutral',
    volatility: 'low',
    structure: 'consolidating',
  },
  'Gap & Go': {
    description: 'Opened away from the prior close and extended in the gap direction',
    trend: 'neutral',
    volatility: 'high',
    structure: 'breaking-out',
  },
  'Gap Fill / Mean Reversion': {
    description: 'Opened away from the prior close and traded back through it',
    trend: 'neutral',
    volatility: 'normal',
    structure: 'ranging',
  },
  'Inside Day': {
    description: "Entire session range contained inside the prior session's range",
    trend: 'neutral',
    volatility: 'low',
    structure: 'consolidating',
  },
  'Outside Day / Expansion': {
    description: "Session traded beyond both sides of the prior session's range",
    trend: 'choppy',
    volatility: 'high',
    structure: 'breaking-out',
  },
  'Rally Continuation': {
    description: 'Constructive drift higher without the conviction of a full trend day',
    trend: 'bullish',
    volatility: 'normal',
    structure: 'trending',
  },
  'Descent Continuation': {
    description: 'Constructive drift lower without the conviction of a full trend day',
    trend: 'bearish',
    volatility: 'normal',
    structure: 'trending',
  },
};

/**
 * Classify the session into one of the ten Master Plan market profiles.
 * First match wins; the ordering encodes specificity — structural containment
 * beats gap behaviour, which beats trend strength, which beats residual
 * range character.
 */
export function classifyProfile(
  sessionCandles: Candle[],
  priorDay: Candle | null,
  trend: TrendAnalysis | null,
): MarketProfile | null {
  if (sessionCandles.length < 2 || !trend) return null;

  const open = sessionCandles[0].open;
  const close = sessionCandles[sessionCandles.length - 1].close;
  const high = Math.max(...sessionCandles.map((c) => c.high));
  const low = Math.min(...sessionCandles.map((c) => c.low));
  const range = high - low;
  const rangePct = open !== 0 ? (range / open) * 100 : 0;
  const closePosition = range > 0 ? (close - low) / range : 0.5;
  const changePct = trend.sessionChangePct;

  const evidence: string[] = [
    `Session range ${low.toFixed(1)}–${high.toFixed(1)} (${rangePct.toFixed(2)}%), change ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`,
    `Close sits at ${(closePosition * 100).toFixed(0)}% of the session range`,
    `Directional persistence ${(trend.momentumScore * 100).toFixed(0)}%`,
  ];

  const build = (type: MarketProfileType, extra: string[] = []): MarketProfile => ({
    type,
    ...PROFILE_META[type],
    evidence: [...evidence, ...extra],
  });

  if (priorDay) {
    const priorRange = priorDay.high - priorDay.low;
    const gapPct = priorDay.close !== 0 ? ((open - priorDay.close) / priorDay.close) * 100 : 0;

    if (high <= priorDay.high && low >= priorDay.low) {
      return build('Inside Day', [
        `Contained inside the prior session's ${priorDay.low.toFixed(1)}–${priorDay.high.toFixed(1)} range`,
      ]);
    }
    if (high > priorDay.high && low < priorDay.low) {
      return build('Outside Day / Expansion', [
        `Traded beyond both sides of the prior session's ${priorDay.low.toFixed(1)}–${priorDay.high.toFixed(1)} range`,
      ]);
    }
    if (Math.abs(gapPct) >= 0.3) {
      const filled = low <= priorDay.close && high >= priorDay.close;
      const extended = Math.sign(changePct) === Math.sign(gapPct) && Math.abs(changePct) >= 0.2;
      if (filled && !extended) {
        return build('Gap Fill / Mean Reversion', [
          `Opened ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}% from the prior close and traded back through ${priorDay.close.toFixed(1)}`,
        ]);
      }
      if (extended && trend.volumeStrength >= 1) {
        return build('Gap & Go', [
          `Opened ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}% from the prior close and extended in the same direction on ${trend.volumeStrength.toFixed(1)}x average volume`,
        ]);
      }
    }
    if (priorRange > 0 && range < priorRange * 0.6) {
      return build('Low Volatility Compression', [
        `Range is ${((range / priorRange) * 100).toFixed(0)}% of the prior session's`,
      ]);
    }
    if (priorRange > 0 && range > priorRange * 1.2 && Math.abs(changePct) < 0.4) {
      return build('High Volatility Range', [
        `Range is ${((range / priorRange) * 100).toFixed(0)}% of the prior session's with no net resolution`,
      ]);
    }
  }

  if (changePct >= 0.5 && closePosition >= 0.7 && trend.momentumScore >= 0.4) {
    return build('Bullish Trend Day');
  }
  if (changePct <= -0.5 && closePosition <= 0.3 && trend.momentumScore >= 0.4) {
    return build('Bearish Trend Day');
  }
  if (changePct > 0.15) return build('Rally Continuation');
  if (changePct < -0.15) return build('Descent Continuation');
  return build('High Volatility Range');
}
