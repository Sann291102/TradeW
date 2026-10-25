/**
 * The autonomous scanner — market data in, trade candidates out.
 *
 * ## What it is
 *
 * The service that lets the bot find its own setups. It picks a data source by
 * market, builds a `MarketSnapshot` with the shared feature core, and hands it
 * to `scanForCandidates` from `@tradew/strategy-core`.
 *
 * **It does not import Sentinel, and it never asks Sentinel anything.** That is
 * the architectural requirement, and it is satisfied structurally rather than
 * by convention: there is no Sentinel client in this module's constructor, so
 * a future edit cannot quietly reintroduce the dependency without adding one.
 *
 * ## What it deliberately does NOT do
 *
 * Place orders. Size positions. Debit a wallet. Pick an option strike. It ends
 * at a decision, and it has no code path that could do otherwise.
 *
 * ## It is not gated by a switch, deliberately
 *
 * An earlier version refused to scan unless `AUTONOMOUS_ENGINE_ENABLED` was
 * set. That conflated two different powers — watching and trading — and its
 * effect was that the only way to collect a decision dataset was to grant the
 * brain authority to trade, which is exactly backwards.
 *
 * Scanning is an observation: it reads market data and computes. Whether a pass
 * RUNS is the caller's decision (`AUTONOMOUS_OBSERVER_ENABLED`, on
 * `BrainObserverService`); whether anything may ever be ORDERED is
 * `autonomousExecutionEnabled()` below, which nothing reads yet. This method's
 * job is to answer honestly whenever it is asked.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CandleInterval } from '@tradew/types';
import {
  isVenueOpen,
  tradableSpec,
  venueMinuteOfDay,
  type ExperimentMarket,
  type TradableSpec,
} from '@tradew/market-data';
import {
  composeSnapshot,
  scanForCandidates,
  type MarketSnapshot,
  type TradeCandidate,
} from '@tradew/strategy-core';
import { MarketDataUnavailable, type MarketDataRead, type MarketDataSource } from './market-data.port';
import { DhanBridgeSource } from './dhan-bridge.source';
import { BinanceSource } from './binance.source';

/**
 * May the brain place an order? Absent means NO.
 *
 * ## Why this no longer gates scanning
 *
 * It did, and that was wrong. Observation and execution are separate powers,
 * and conflating them meant the only way to collect a decision dataset was to
 * let the brain trade — exactly backwards. The brain must be able to watch,
 * decide, journal and learn while holding no authority whatsoever, so this
 * switch now guards ONLY the order path.
 *
 * Nothing reads it yet: there is no order path in the autonomous engine at all.
 * It exists so that the thing which eventually places an order has a switch
 * that was always about placing orders, rather than inheriting one that used to
 * mean something else.
 *
 * Whether the brain may RUN is `AUTONOMOUS_OBSERVER_ENABLED`, in
 * `brain-observer.service.ts`.
 */
export function autonomousExecutionEnabled(): boolean {
  return process.env.AUTONOMOUS_ENGINE_ENABLED === 'true';
}

/**
 * The timeframe the engine decides on.
 *
 * 15m, matching `SNAPSHOT_INTERVAL` and the bars every existing rule was
 * written and calibrated against. Making it configurable per market would
 * make cross-market results incomparable, which is the one thing the
 * multi-market experiment exists to avoid.
 */
export const SCAN_INTERVAL: CandleInterval = '15m';

/** Days of history requested. Enough for a 50-period EMA at 15m with slack. */
const LOOKBACK_DAYS = 5;

export type ScanStatus = 'scanned' | 'skipped-disabled' | 'skipped-closed' | 'data-unavailable' | 'not-tradable';

export interface ScanResult {
  symbol: string;
  market: ExperimentMarket | null;
  status: ScanStatus;
  /** Present when `status === 'scanned'`. */
  candidates: TradeCandidate[];
  /** Why nothing was scanned, when nothing was. */
  detail: string | null;
  source: string | null;
  /** How fresh the data was, in seconds, when it could be measured. */
  dataAgeSeconds: number | null;
  /**
   * The closed-bar market state the decision was made on.
   *
   * Exposed so a caller can inspect or re-derive from EXACTLY what the brain
   * saw, rather than rebuilding a snapshot and hoping it matches. The
   * verification script uses it to exercise the contract and premium gates on
   * real bars even when no setup happens to be validated at that instant.
   */
  snapshot?: MarketSnapshot;
}

@Injectable()
export class SetupScannerService {
  private readonly logger = new Logger(SetupScannerService.name);
  private readonly sources: MarketDataSource[];

  constructor(
    private readonly dhan: DhanBridgeSource,
    private readonly binance: BinanceSource,
  ) {
    this.sources = [dhan, binance];
  }

  /** The source authoritative for a market, or null when none is. */
  sourceFor(market: ExperimentMarket): MarketDataSource | null {
    return this.sources.find((s) => s.markets.includes(market)) ?? null;
  }

  /**
   * Scan one instrument.
   *
   * Every early return carries a reason. "Nothing happened" is never an
   * acceptable answer from this method — the whole point of the rejection
   * journal is that a quiet scan is still a fact worth stating.
   */
  async scanSymbol(symbol: string, now: Date = new Date()): Promise<ScanResult> {
    const base: ScanResult = {
      symbol,
      market: null,
      status: 'not-tradable',
      candidates: [],
      detail: null,
      source: null,
      dataAgeSeconds: null,
    };

    // NOTE: there is deliberately no enablement check here any more.
    //
    // Scanning is an observation, and an observation is free — it reads market
    // data and computes. Refusing to do it because the ORDER switch is off is
    // what made the parallel brain impossible to run. The caller decides
    // whether to run a pass (`AUTONOMOUS_OBSERVER_ENABLED`, on the observer);
    // this method's job is to answer honestly when asked.
    const spec = tradableSpec(symbol);
    if (!spec || !spec.tradeable) {
      return {
        ...base,
        status: 'not-tradable',
        detail: spec
          ? `${symbol} is in the registry but marked not tradable — it has no resolved feed.`
          : `${symbol} is not in the tradable universe.`,
      };
    }

    const source = this.sourceFor(spec.market);
    if (!source) {
      return {
        ...base,
        market: spec.market,
        status: 'data-unavailable',
        detail: `No market-data source is registered for ${spec.market}.`,
      };
    }

    // The venue's own clock, not IST for everything. Crypto is always open;
    // MCX runs to 23:30; NSE to 15:30. Asking one calendar about three venues
    // is how a 24/7 market gets told it is out of hours.
    if (!isVenueOpen(spec.venue, now)) {
      return {
        ...base,
        market: spec.market,
        source: source.id,
        status: 'skipped-closed',
        detail: `${spec.venue} is closed at this time.`,
      };
    }

    let read: MarketDataRead;
    try {
      read = await source.read(symbol, SCAN_INTERVAL, LOOKBACK_DAYS);
    } catch (err) {
      const detail = err instanceof MarketDataUnavailable ? err.message : String(err);
      // A fault is OUR failure to find out, and it is reported as such rather
      // than as a market with no setups.
      this.logger.warn(`scan ${symbol}: ${detail}`);
      return { ...base, market: spec.market, source: source.id, status: 'data-unavailable', detail };
    }

    const snapshot = this.buildSnapshot(symbol, read, now);
    const candidates = scanForCandidates(snapshot, {
      market: spec.market,
      symbol,
      timeframe: SCAN_INTERVAL,
      now,
      istMinuteOfDay: this.sessionMinute(spec, now),
    });

    return {
      symbol,
      market: spec.market,
      status: 'scanned',
      candidates,
      snapshot,
      detail: null,
      source: read.source,
      dataAgeSeconds: read.lastDataAt
        ? Math.round((now.getTime() - read.lastDataAt.getTime()) / 1000)
        : null,
    };
  }

  /** Scan several instruments, one source call each, concurrently. */
  async scanAll(symbols: string[], now: Date = new Date()): Promise<ScanResult[]> {
    return Promise.all(symbols.map((s) => this.scanSymbol(s, now)));
  }

  /**
   * Bars → `MarketSnapshot`, via the shared feature core.
   *
   * The option chain is passed as null. That is correct for this phase and not
   * a placeholder: no rule in the agent catalogue reads the chain, and the
   * India option adapter — which does need it — fetches its own at
   * materialisation time, where the strike and expiry are actually chosen.
   */
  private buildSnapshot(symbol: string, read: MarketDataRead, now: Date): MarketSnapshot {
    const snapshot = composeSnapshot(
      symbol,
      read.candles,
      null,
      { vix: null, breadthRatio: null, optionChain: null },
      { interval: SCAN_INTERVAL, now },
    );

    // ── DECISION PRICE = THE LAST CLOSED BAR. Architectural, not incidental.
    //
    // `composeSnapshot` sets `lastPrice` from the FORMING bar, and an earlier
    // version of this method went further and substituted the venue's live
    // ticker. Both make the decision depend on WHEN the poll landed: nine rules
    // and the whole level layer read `lastPrice`, so the same bar could refuse
    // at one poll and accept at the next. That was observed live on
    // 2026-09-09 (BTCUSDT/agent-ema-cross, refused 19:45, accepted 20:07).
    //
    // The deciding argument is backtest parity. A live ticker DOES NOT EXIST in
    // historical data, so a brain that decides on one can never be replayed —
    // the backtester would evaluate closed bars while the live engine evaluated
    // intra-bar prices, and every divergence between them would be
    // unattributable. "Backtest and live call the same core" is only true if
    // the core is given the same KIND of input in both.
    //
    // So the decision is deterministic per bar: one bar, one market state, one
    // answer, reproducible forever from the journalled feature vector.
    //
    // The live ticker is NOT discarded — it is the freshness signal
    // (`read.lastDataAt` → `dataAgeSeconds`), which answers "is this feed
    // alive?" That is a different question from "what is the market state?",
    // and conflating them is what produced the non-determinism.
    const closed = snapshot.candles[snapshot.candles.length - 1] ?? null;
    if (closed) {
      return { ...snapshot, lastPrice: closed.close };
    }
    // No closed bar at all — leave the snapshot as composed. The engine's
    // `minCandles` gate refuses it long before any level is derived.
    return snapshot;
  }

  /**
   * The venue session clock a setup's `idealSession` is judged against.
   *
   * Null for a venue that never closes: a window like '09:30-12:00' is a claim
   * about a session, and a market without one must not have its setups refused
   * for being outside a session that does not exist.
   */
  private sessionMinute(spec: TradableSpec, now: Date): number | null {
    if (spec.market === 'CRYPTO') return null;
    return venueMinuteOfDay(spec.venue, now);
  }
}
