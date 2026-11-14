import type { CandleInterval } from '@tradew/types';
import type { MarketProfile, TrendAnalysis } from '../domain';
import { analyseLiquidity, analyseStructure } from './market-structure';
import { readIndexDirection } from '../execution/index-direction';
import { assessDataQuality, DEFAULT_MAX_BAR_AGE_MINUTES, DEFAULT_MIN_CANDLES } from '../execution/data-quality';
import { regimeFromProfile } from '../reasoning/regime-intelligence.service';
import { latestBarAt, type MarketSnapshot } from './market-intelligence.service';
import type { ContractAlignment } from './contract-alignment';

/**
 * The OBSERVATION projection of the canonical `MarketSnapshot` — what Tara is
 * allowed to read, and the only market-analysis surface outside Sentinel's own
 * premium response.
 *
 * ── WHY A PROJECTION AND NOT A SECOND ENGINE ───────────────────────────────
 *
 * Nothing here computes anything. Every number below is lifted from a
 * `MarketSnapshot` that `composeSnapshot()` already built, or from the same
 * pure readers (`analyseStructure`, `analyseLiquidity`, `readIndexDirection`,
 * `assessDataQuality`) that `/observe` and `/execution/evaluate` call on that
 * identical object. That is the whole point of this file: the assistant, the
 * Sentinel workspace and the autonomous paper agents describe ONE market,
 * because they read one snapshot.
 *
 * Writing a second indicator path for the assistant was the obvious shortcut
 * and is the specific thing this module exists to prevent. The repository
 * already carries three implementations of EMA/RSI/VWAP (this engine,
 * `services/sentinel-py`, and a dead client copy in `apps/web`); a fourth,
 * wired to the surface that talks to users, would guarantee that the number
 * Tara says and the number the agent traded on eventually disagree with no way
 * to arbitrate which is right.
 *
 * ── THE BOUNDARY THIS FILE ENFORCES ────────────────────────────────────────
 *
 * MEASUREMENTS cross. CONCLUSIONS do not.
 *
 * Allowed here: price, OHLC, volume, indicator values, structure, liquidity,
 * regime, option-chain aggregates, index direction, data freshness — facts
 * about the market that anyone with a chart could read for themselves.
 *
 * Never here, and never to be added: `synthesis`, `publication`,
 * `sideInFocus`, `strategyAdvice`, `strategyMatches`, `confidence`,
 * `crossValidation`, or any strike selection. Those are Sentinel's *reasoning*
 * — the premium product (`SUBSCRIPTIONS.md` §3) — and they are also the only
 * fields that carry a direction a user could act on. Keeping them out is what
 * makes this route safe to serve without the `sentinel` entitlement.
 *
 * The type below is the enforcement: there is no field to put a verdict in.
 * Adding one is a deliberate act, not an accident of spreading a snapshot.
 *
 * ── INDEX DIRECTION IS A MEASUREMENT, NOT A CALL ───────────────────────────
 *
 * `readIndexDirection` is included and `alignedOptionSide` is not. The first
 * reports how five structural reads of the index voted, each with its own
 * measurement; the second turns that into "buy calls". The line between an
 * observation and an instruction runs exactly between those two functions.
 */

/** A measurement that could not be taken, and why — never a zeroed stand-in. */
export interface Unavailable {
  available: false;
  reason: string;
}

/**
 * Every numeric field is `number | null`. A null ALWAYS means "not measurable
 * from these bars" and is accompanied by an entry in `unavailable` naming the
 * reason. Nothing is defaulted to zero: a `0` VWAP and an unmeasured VWAP read
 * identically once they leave this service, and the first is a lie.
 */
export interface ObservationIndicators {
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  vwap: number | null;
  macdHistogram: number | null;
  cpr: { pivot: number; bc: number; tc: number } | null;
  /** Last bar's volume as a multiple of the 20-bar average. */
  volumeVsAvg: number | null;
  realizedVolPct: number | null;
  vix: number | null;
  /** advances / declines across the exchange. */
  breadthRatio: number | null;
  support: number | null;
  resistance: number | null;
}

export interface ObservationBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ObservationStructure {
  state: 'uptrend' | 'downtrend' | 'range' | 'undefined';
  event: 'break-of-structure' | 'change-of-character' | null;
  eventDirection: 'bullish' | 'bearish' | null;
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
  /** The measurements behind the classification, in the reader's own words. */
  evidence: string[];
}

export interface ObservationLiquidity {
  pools: { price: number; side: 'above' | 'below'; touches: number; swept: boolean }[];
  recentSweep: { side: 'above' | 'below'; price: number; reclaimed: boolean } | null;
}

export interface ObservationOptionChain {
  frontExpiry: string;
  /** total put OI / total call OI */
  pcr: number;
  maxPain: number;
  callOIWall: number | null;
  putOIWall: number | null;
  strikesAnalysed: number;
  atmStrike: number | null;
  /** The at-the-money row only. The full ladder is the Option Chain panel's job. */
  atm: {
    strike: number;
    callOI: number;
    putOI: number;
    callLtp: number | null;
    putLtp: number | null;
    callIV: number | null;
    putIV: number | null;
  } | null;
}

/** CE/PE premium behaviour over the SAME bars as the underlying. */
export interface ObservationContracts {
  readable: boolean;
  unreadableReason: string | null;
  strike: number | null;
  expiry: string | null;
  ce: { strike: number; changePct: number | null; direction: string | null; unavailableReason: string | null } | null;
  pe: { strike: number; changePct: number | null; direction: string | null; unavailableReason: string | null } | null;
  alignment: string | null;
  notes: string[];
}

export interface ObservationIndexDirection {
  direction: 'bullish' | 'bearish' | 'neutral' | 'unclear';
  /** 0..1 — the winning side's share of the weight that actually voted. */
  strength: number;
  votes: { id: string; label: string; direction: string; weight: number; detail: string }[];
  conflicts: string[];
  summary: string;
}

export interface ObservationFreshness {
  ok: boolean;
  candles: number;
  newestBarAt: string | null;
  barAgeMinutes: number | null;
  /** The first failing check's detail, or null when everything passed. */
  reason: string | null;
  checks: { id: string; label: string; passed: boolean; detail: string }[];
}

/**
 * The complete observation-only read of one symbol on one timeframe.
 *
 * `timeframe` is the interval the measurements were ACTUALLY computed on, and
 * `requestedTimeframe` is what the caller asked for. They differ only where the
 * canonical engine has no such interval (a weekly chart is read on daily bars),
 * and `timeframeNote` says so in words — a response that silently analysed
 * different bars from the ones on the user's screen is the failure
 * `SNAPSHOT_INTERVAL` was introduced to prevent, restated one layer up.
 */
export interface MarketObservation {
  symbol: string;
  timeframe: CandleInterval;
  requestedTimeframe: string;
  timeframeNote: string | null;
  /** When the observation was produced (server clock), ISO. */
  observedAt: string;
  /** The market-event time of the newest bar it was computed from, ISO. */
  barAt: string | null;
  lastPrice: number | null;
  latestBar: ObservationBar | null;
  session: {
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
    bars: number;
  };
  priorDay: ObservationBar | null;
  openingRange: { high: number; low: number; establishedAt: string } | null;
  indicators: ObservationIndicators;
  trend: TrendAnalysis | null;
  marketProfile: MarketProfile | null;
  regime: string | null;
  structure: ObservationStructure | null;
  liquidity: ObservationLiquidity | null;
  optionChain: ObservationOptionChain | null;
  contracts: ObservationContracts | null;
  indexDirection: ObservationIndexDirection | null;
  freshness: ObservationFreshness;
  /**
   * Every measurement that could not be taken, with the reason.
   *
   * Present so a consumer never has to guess why a field is null, and so the
   * assistant can say "I don't have a VWAP for these bars because there are
   * only nine of them" instead of quietly omitting it. Absence of evidence has
   * to be reportable, or it gets narrated as evidence of absence.
   */
  unavailable: { field: string; reason: string }[];
}

/**
 * Turn a caller's timeframe label into an interval this engine can actually
 * read, or refuse it by name.
 *
 * Case-insensitive because the workspace's own pills are `1H`/`1D` while
 * `CandleInterval` is `1h`/`1d`, and a user typing "analyse NIFTY on 1H" is
 * naming the pill. The weekly pill has no interval of its own — `ChartPanel`
 * already draws it from daily bars — so it resolves to `1d` and says so rather
 * than silently analysing different bars from the ones on screen.
 */
export function resolveInterval(
  requested: string,
): { ok: true; interval: CandleInterval; note: string | null } | { ok: false; reason: string } {
  const key = requested.trim().toLowerCase().replace(/\s+/g, '');
  switch (key) {
    case '1m':
    case '1min':
    case '1minute':
      return { ok: true, interval: '1m', note: null };
    case '5m':
    case '5min':
    case '5minute':
    case '5minutes':
      return { ok: true, interval: '5m', note: null };
    case '15m':
    case '15min':
    case '15minute':
    case '15minutes':
      return { ok: true, interval: '15m', note: null };
    case '1h':
    case '60m':
    case 'hourly':
    case '1hour':
      return { ok: true, interval: '1h', note: null };
    case '1d':
    case 'daily':
    case '1day':
      return { ok: true, interval: '1d', note: null };
    case '1w':
    case 'weekly':
    case '1week':
      return {
        ok: true,
        interval: '1d',
        note: 'There is no weekly interval in the analysis engine, so this was measured on daily bars — the same bars the weekly chart is drawn from.',
      };
    default:
      return {
        ok: false,
        reason: `"${requested}" is not a timeframe the analysis engine reads. Supported: 1m, 5m, 15m, 1H, 1D, 1W.`,
      };
  }
}

/** Fields that must NEVER appear in this projection. Asserted by a test. */
export const FORBIDDEN_OBSERVATION_FIELDS = [
  'synthesis',
  'publication',
  'sideInFocus',
  'strategyAdvice',
  'strategyAdvices',
  'strategyMatches',
  'strategyLifecycles',
  'crossValidation',
  'confidence',
  'institutionalCrossValidation',
  'recommendation',
  'signals',
] as const;

function iso(value: Date | string | number | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function bar(candle: { timestamp: Date; open: number; high: number; low: number; close: number; volume: number } | null | undefined): ObservationBar | null {
  if (!candle) return null;
  const at = iso(candle.timestamp);
  if (!at) return null;
  return {
    timestamp: at,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  };
}

/**
 * Project a canonical snapshot into the observation-only read.
 *
 * Pure and synchronous: everything it needs was computed upstream, which is
 * what lets the same projection be built from a live snapshot, a replayed one,
 * or a fixture in a test without a network.
 */
export function projectObservation(input: {
  snapshot: MarketSnapshot;
  timeframe: CandleInterval;
  requestedTimeframe: string;
  timeframeNote?: string | null;
  now: Date;
  contracts?: ContractAlignment | null;
}): MarketObservation {
  const { snapshot, now } = input;
  const unavailable: { field: string; reason: string }[] = [];
  const miss = (field: string, reason: string) => unavailable.push({ field, reason });

  const candles = snapshot.candles ?? [];
  const sessionCandles = snapshot.sessionCandles ?? [];
  const barAt = latestBarAt(snapshot);

  // ---- indicators: null is reported, never defaulted ----------------------
  const ind: ObservationIndicators = {
    rsi14: snapshot.rsi14,
    ema20: snapshot.ema20,
    ema50: snapshot.ema50,
    vwap: snapshot.vwap,
    macdHistogram: snapshot.macdHistogram,
    cpr: snapshot.cpr,
    volumeVsAvg: snapshot.volumeVsAvg,
    realizedVolPct: snapshot.realizedVolPct,
    vix: snapshot.vix,
    breadthRatio: snapshot.breadthRatio,
    support: snapshot.support,
    resistance: snapshot.resistance,
  };

  const thinHistory = `only ${candles.length} bar${candles.length === 1 ? '' : 's'} of ${input.timeframe} history were available`;
  if (ind.rsi14 === null) miss('indicators.rsi14', thinHistory);
  if (ind.ema20 === null) miss('indicators.ema20', thinHistory);
  if (ind.ema50 === null) miss('indicators.ema50', thinHistory);
  if (ind.vwap === null) miss('indicators.vwap', thinHistory);
  if (ind.macdHistogram === null) miss('indicators.macdHistogram', thinHistory);
  if (ind.cpr === null) miss('indicators.cpr', 'no prior completed daily bar in the history window');
  if (ind.volumeVsAvg === null) miss('indicators.volumeVsAvg', thinHistory);
  if (ind.realizedVolPct === null) miss('indicators.realizedVolPct', thinHistory);
  if (ind.vix === null) miss('indicators.vix', 'the market-data provider published no VIX with this breadth read');
  if (ind.breadthRatio === null) miss('indicators.breadthRatio', 'the market-data provider published no advance/decline breadth');
  if (ind.support === null) miss('indicators.support', 'no swing low formed in the bars available');
  if (ind.resistance === null) miss('indicators.resistance', 'no swing high formed in the bars available');

  // ---- structure & liquidity: the same readers /observe uses --------------
  let structure: ObservationStructure | null = null;
  let liquidity: ObservationLiquidity | null = null;
  if (candles.length >= 5) {
    const s = analyseStructure(candles);
    structure = {
      state: s.state,
      event: s.event,
      eventDirection: s.eventDirection,
      lastSwingHigh: s.lastSwingHigh?.price ?? null,
      lastSwingLow: s.lastSwingLow?.price ?? null,
      evidence: s.evidence ?? [],
    };
    const l = analyseLiquidity(candles);
    liquidity = { pools: l.pools.slice(0, 5), recentSweep: l.recentSweep };
  } else {
    miss('structure', `market structure needs at least 5 bars; ${candles.length} were available`);
    miss('liquidity', `liquidity pools need at least 5 bars; ${candles.length} were available`);
  }

  // ---- option chain: aggregates + the ATM row, never a chosen strike ------
  let optionChain: ObservationOptionChain | null = null;
  const chain = snapshot.optionChain;
  if (chain) {
    const spot = snapshot.lastPrice;
    const atmRow =
      spot > 0 && chain.entries.length
        ? chain.entries.reduce((best, e) =>
            Math.abs(e.strike - spot) < Math.abs(best.strike - spot) ? e : best,
          )
        : null;
    optionChain = {
      frontExpiry: iso(chain.frontExpiry) ?? '',
      pcr: chain.pcr,
      maxPain: chain.maxPain,
      callOIWall: chain.callOIWall,
      putOIWall: chain.putOIWall,
      strikesAnalysed: chain.strikesAnalysed,
      atmStrike: atmRow?.strike ?? null,
      atm: atmRow
        ? {
            strike: atmRow.strike,
            callOI: atmRow.callOI,
            putOI: atmRow.putOI,
            callLtp: atmRow.callLtp ?? null,
            putLtp: atmRow.putLtp ?? null,
            callIV: atmRow.callIV ?? null,
            putIV: atmRow.putIV ?? null,
          }
        : null,
    };
  } else {
    miss('optionChain', 'this instrument published no front-expiry option chain');
  }

  // ---- CE/PE legs, when the caller read them -----------------------------
  let contracts: ObservationContracts | null = null;
  if (input.contracts) {
    const c = input.contracts;
    contracts = {
      readable: c.contractsReadable,
      unreadableReason: c.unreadableReason,
      strike: c.strike,
      expiry: c.expiry,
      ce: c.ce
        ? {
            strike: c.ce.strike,
            changePct: c.ce.series?.changePct ?? null,
            direction: c.ce.series?.direction ?? null,
            unavailableReason: c.ce.unavailableReason,
          }
        : null,
      pe: c.pe
        ? {
            strike: c.pe.strike,
            changePct: c.pe.series?.changePct ?? null,
            direction: c.pe.series?.direction ?? null,
            unavailableReason: c.pe.unavailableReason,
          }
        : null,
      alignment: c.alignment,
      notes: c.notes,
    };
    if (!c.contractsReadable) {
      miss('contracts', c.unreadableReason ?? 'contract series are not readable from this provider');
    }
  } else {
    miss('contracts', 'CE/PE legs were not requested for this observation');
  }

  // ---- index direction: the votes, never the aligned side -----------------
  let indexDirection: ObservationIndexDirection | null = null;
  if (candles.length > 0) {
    const d = readIndexDirection(snapshot);
    indexDirection = {
      direction: d.direction,
      strength: d.strength,
      votes: d.votes.map((v) => ({
        id: v.id,
        label: v.label,
        direction: v.direction,
        weight: v.weight,
        detail: v.detail,
      })),
      conflicts: d.conflicts.map((v) => v.label),
      summary: d.summary,
    };
  } else {
    miss('indexDirection', 'no bars were available to read a direction from');
  }

  // ---- freshness: the same gate the paper agents are held to --------------
  const quality = assessDataQuality({
    now,
    candles: candles.length,
    newestBarAt: barAt,
    spot: snapshot.lastPrice > 0 ? snapshot.lastPrice : null,
    optionChainStrikes: chain?.strikesAnalysed ?? 0,
    minCandles: DEFAULT_MIN_CANDLES,
    maxBarAgeMinutes: DEFAULT_MAX_BAR_AGE_MINUTES,
    // The assistant is describing a market, not sizing a position — a symbol
    // with no options market is a complete observation, not a degraded one.
    requireOptionChain: false,
  });

  const sessionHigh = sessionCandles.length ? Math.max(...sessionCandles.map((c) => c.high)) : null;
  const sessionLow = sessionCandles.length ? Math.min(...sessionCandles.map((c) => c.low)) : null;
  if (!sessionCandles.length) miss('session', 'no bars belonging to the most recent session were available');
  if (!snapshot.marketProfile) miss('marketProfile', 'the session has too few bars to classify');
  if (!snapshot.trendAnalysis) miss('trend', 'the session has too few bars to measure direction');
  if (!snapshot.openingRange) miss('openingRange', 'no bars inside the session’s first 30 minutes');

  return {
    symbol: snapshot.symbol,
    timeframe: input.timeframe,
    requestedTimeframe: input.requestedTimeframe,
    timeframeNote: input.timeframeNote ?? null,
    observedAt: now.toISOString(),
    barAt: iso(barAt),
    lastPrice: snapshot.lastPrice > 0 ? snapshot.lastPrice : null,
    latestBar: bar(candles[candles.length - 1]),
    session: {
      open: sessionCandles[0]?.open ?? null,
      high: sessionHigh,
      low: sessionLow,
      close: sessionCandles[sessionCandles.length - 1]?.close ?? null,
      volume: sessionCandles.length ? sessionCandles.reduce((s, c) => s + c.volume, 0) : null,
      bars: sessionCandles.length,
    },
    priorDay: bar(snapshot.priorDay),
    openingRange: snapshot.openingRange
      ? {
          high: snapshot.openingRange.high,
          low: snapshot.openingRange.low,
          establishedAt: iso(snapshot.openingRange.establishedAt) ?? '',
        }
      : null,
    indicators: ind,
    trend: snapshot.trendAnalysis,
    marketProfile: snapshot.marketProfile,
    regime: snapshot.marketProfile ? regimeFromProfile(snapshot.marketProfile) : null,
    structure,
    liquidity,
    optionChain,
    contracts,
    indexDirection,
    freshness: {
      ok: quality.ok,
      candles: quality.candles,
      newestBarAt: quality.newestBarAt,
      barAgeMinutes: quality.barAgeMinutes,
      reason: quality.reason,
      checks: quality.checks,
    },
    unavailable,
  };
}
