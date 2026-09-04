import { Injectable, Logger } from '@nestjs/common';
import type {
  Candle,
  CandleInterval,
  MarketBreadth,
  MarketDataProvider,
  NewsItem,
  OptionChainEntry,
  OptionContractRef,
  Quote,
} from '@tradew/types';
import { liveExpiries, normaliseExpiryList, tradingDateIso } from '@tradew/types';
import { istDateKey } from '@tradew/market-data';
import { PrismaService } from '../prisma.service';

/**
 * Sentinel's market-data provider — REAL data only.
 *
 * Resolution order for candles (and breadth/VIX):
 *   1. Live feed  — the standalone Dhan bridge (live-feed-server.ts) when
 *      SENTINEL_LIVE_FEED_URL is set. Serves real Dhan OHLCV on demand for the
 *      *entire* resolved universe (indices, ~212 stocks, ETFs and MCX
 *      commodities), so any market the user selects reads real, not simulated.
 *   2. Candle table — persisted real history backfilled from Dhan
 *      (services/market-data/scripts/backfill-candles.ts). Used when the live
 *      bridge is unset/unreachable but the symbol was backfilled.
 *   3. Nothing. There is no simulator fallback.
 *
 * Removed 2026-07-26: the third tier used to be a SimulatedMarketDataProvider
 * so /observe could always answer. That meant Sentinel produced a complete,
 * confident-looking observation — day classification, signals, timeline — off
 * invented candles whenever the bridge was down, with nothing in the response
 * marking it as fabricated. An observation-and-education product whose whole
 * value is trustworthy context cannot afford that. It now raises
 * MarketDataUnavailableError and the workspace reports that it is not
 * connected.
 *
 * The live bridge is a pragmatic step, not the final architecture: the Phase 4
 * ingestion pipeline (DHAN-MARKET-DATA-INTEGRATION.md) will write live Candle
 * rows to Postgres and this provider will read only the table.
 */

/**
 * Raised when neither real source can serve a request. Mapped to HTTP 503 by
 * the controller so the web workspace can say exactly what is disconnected.
 *
 * ── WHY THIS TAKES A DIAGNOSIS RATHER THAN COMPOSING ONE ──────────────────
 *
 * The message used to be a fixed sentence: "The Dhan live-feed bridge is
 * unreachable and no backfilled candles exist for it." On 2026-08-17 that
 * sentence was shown to the user, and BOTH of its clauses were false:
 *
 *   · The bridge was up, answering in ~30 ms, and streaming live quotes. What
 *     had failed was the Dhan credential it presents — it was 18 h old, past
 *     Dhan's 24 h regulatory cap, and Dhan was returning DH-901. The bridge
 *     reported that verbatim in its response body; this provider discarded it.
 *
 *   · Backfilled candles DID exist — 1,627 NIFTY 15m rows. They simply all
 *     predated the 5-day window the snapshot asks for (newest 2026-08-11).
 *
 * So the one artefact the user and the operator both read pointed at two
 * innocent components and hid the real one, and the investigation started in the
 * wrong service. A hardcoded diagnosis is a guess that cannot ever be wrong out
 * loud. This class now states only what was actually observed at each tier.
 */
export interface UnavailableDiagnosis {
  /** What was being read, e.g. '15m candles'. */
  what: string;
  symbol?: string;
  /** What the live bridge said, verbatim, or why it could not be reached. */
  liveFeed: string;
  /** What the Candle table held — including rows outside the asked-for window. */
  storedHistory: string;
  /** True when only an operator can fix this (a renewed Dhan credential). */
  needsOperator?: boolean;
}

export class MarketDataUnavailableError extends Error {
  readonly diagnosis: UnavailableDiagnosis;

  constructor(diagnosis: UnavailableDiagnosis) {
    super(
      `No real market data available${diagnosis.symbol ? ` for ${diagnosis.symbol}` : ''} (${diagnosis.what}). ` +
        `Live feed: ${diagnosis.liveFeed}. Stored history: ${diagnosis.storedHistory}. ` +
        'Sentinel does not substitute simulated data.',
    );
    this.name = 'MarketDataUnavailableError';
    this.diagnosis = diagnosis;
  }
}

/**
 * A named fault from the bridge, as its routes now report one.
 *
 * `source: 'error'` alone was not enough to act on — it said something went
 * wrong without saying what, so every consumer guessed. The bridge now names the
 * kind alongside it (see `describeFault` in live-feed-server.ts).
 */
interface FeedFault {
  fault?: 'auth' | 'rate-limit' | 'upstream';
  error?: string;
  needsOperator?: boolean;
}

/** A read that either produced a body or produced a named reason it did not. */
type FeedRead<T> = { ok: true; data: T } | { ok: false; reason: string; needsOperator: boolean };

/** Human-readable fault text from a bridge body that carries one. */
function faultText(body: FeedFault | null | undefined): string | null {
  if (!body?.error && !body?.fault) return null;
  const kind = body.fault ? `${body.fault} fault` : 'upstream fault';
  return body.error ? `${kind} — ${body.error}` : kind;
}

const LIVE_FEED_URL = (process.env.SENTINEL_LIVE_FEED_URL ?? '').replace(/\/$/, '');
const LIVE_FEED_TIMEOUT_MS = Number(process.env.SENTINEL_LIVE_FEED_TIMEOUT_MS ?? 4000);

interface FeedCandle {
  timestamp: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest?: number;
}
interface FeedQuote {
  symbol: string;
  ltp: number;
  change?: number;
  changePct?: number;
  volume?: number;
}
interface FeedSnapshot {
  indices?: FeedQuote[];
  stocks?: FeedQuote[];
  etfs?: FeedQuote[];
  commodities?: FeedQuote[];
}

/** One leg of a strike as the bridge's `/optionchain` serves it. */
interface FeedOptionLeg {
  ltp?: number;
  oi?: number;
  volume?: number;
  iv?: number;
  /**
   * Previous-session OI and close, exactly as the bridge already serves them.
   *
   * The bridge has mapped Dhan's `previous_oi` / `previous_close_price` onto
   * every leg since the option-chain endpoint was written; this provider was
   * simply dropping both on the floor, so the engine could see WHERE open
   * interest sat and never whether it had grown or shrunk. Reading them costs
   * nothing — same call, same body — and it is the whole input to
   * `execution/option-positioning.ts`.
   */
  previousOi?: number;
  previousClose?: number;
}
interface FeedOptionChain {
  spot?: number | null;
  strikes?: { strike: number; ce?: FeedOptionLeg | null; pe?: FeedOptionLeg | null }[];
}

/**
 * How long a read chain is reused.
 *
 * Shorter than the bridge's own chain TTL would be pointless (the call would
 * just hit that cache); longer would let OI walls go stale across a sweep. The
 * observation cadences this serves are 45s (`/observe`) and 60s (the watch
 * sweep), so 30s means neither is ever served a chain it has already seen
 * twice.
 */
const OPTION_CACHE_TTL_MS = 30_000;
/** Expiry lists change on expiry, not on ticks. See `getOptionExpiries`. */
const EXPIRY_CACHE_TTL_MS = 15 * 60_000;

function contractLabel(c: OptionContractRef): string {
  return `${c.symbol} ${c.expiry} ${c.strike} ${c.side}`;
}

@Injectable()
export class CandleMarketDataProvider implements MarketDataProvider {
  readonly name = LIVE_FEED_URL ? 'live-feed+db-candle' : 'db-candle';
  private readonly logger = new Logger(CandleMarketDataProvider.name);

  /** symbol:expiry → last read chain. See OPTION_CACHE_TTL_MS. */
  private readonly chainCache = new Map<string, { at: number; entries: OptionChainEntry[] }>();
  /** symbol → traded expiries, nearest first. See EXPIRY_CACHE_TTL_MS. */
  private readonly expiryCache = new Map<string, { at: number; expiries: string[] }>();

  constructor(private readonly prisma: PrismaService) {}

  async getCandles(symbol: string, interval: CandleInterval, from: Date, to: Date): Promise<Candle[]> {
    const live = await this.candlesFromLiveFeed(symbol, interval, from, to);
    if (live.ok && live.data.length) return live.data;

    const stored = await this.candlesFromTable(symbol, interval, from, to);
    if (stored.ok && stored.data.length) return stored.data;

    // Both tiers declined. Report WHAT each of them said, not a guess about it —
    // see `MarketDataUnavailableError`'s header for the incident this replaces.
    const liveFeed = live.ok ? 'answered with no bars in the requested window' : live.reason;
    const storedHistory = stored.ok ? 'answered with no rows' : stored.reason;
    this.logger.warn(
      `no real candles for ${symbol} ${interval} — refusing to simulate. live: ${liveFeed}; stored: ${storedHistory}`,
    );
    throw new MarketDataUnavailableError({
      what: `${interval} candles`,
      symbol,
      liveFeed,
      storedHistory,
      needsOperator: !live.ok && live.needsOperator,
    });
  }

  /** Real Dhan candles for any symbol the live bridge covers (incl. commodities). */
  private async candlesFromLiveFeed(
    symbol: string,
    interval: CandleInterval,
    from: Date,
    to: Date,
  ): Promise<FeedRead<Candle[]>> {
    if (!LIVE_FEED_URL) {
      return { ok: false, reason: 'not configured (SENTINEL_LIVE_FEED_URL is unset)', needsOperator: true };
    }
    const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
    const url = `${LIVE_FEED_URL}/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&days=${days}`;
    const read = await this.readFeed<{ candles?: FeedCandle[]; source?: string } & FeedFault>(url);
    if (!read.ok) return read;

    const json = read.data;
    // The bridge answers HTTP 200 for an upstream fault and names it in the body.
    // Reading only `source !== 'dhan'` is what turned "your Dhan token was
    // refused" into "no market data exists" — the fault text is the single most
    // useful string in the whole failure and it was being thrown away here.
    const fault = faultText(json);
    if (fault) {
      return { ok: false, reason: `bridge reported ${fault}`, needsOperator: json.needsOperator === true };
    }
    if (json.source === 'none') {
      return { ok: false, reason: 'bridge does not cover this symbol', needsOperator: false };
    }
    if (json.source !== 'dhan' || !Array.isArray(json.candles)) {
      return { ok: false, reason: `bridge returned an unusable body (source=${String(json.source)})`, needsOperator: false };
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const candles = json.candles
      .filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs)
      .map((c) => ({
        timestamp: new Date(c.timestamp),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        openInterest: c.openInterest,
      }));
    return { ok: true, data: candles };
  }

  /**
   * Persisted real history from the Candle table.
   *
   * When the window is empty this reports whether the table holds rows for this
   * symbol at all, and how stale the newest one is. That distinction is the
   * difference between "run the backfill" and "the backfill ran but has not run
   * since Tuesday" — and on 2026-08-17 the user was shown "no backfilled candles
   * exist" while 1,627 NIFTY 15m rows sat in the table, all of them older than
   * the 5-day window. One extra query, only on the failure path, and the operator
   * is pointed at the actual problem.
   */
  private async candlesFromTable(
    symbol: string,
    interval: CandleInterval,
    from: Date,
    to: Date,
  ): Promise<FeedRead<Candle[]>> {
    try {
      const inst = await this.prisma.instrument.findUnique({ where: { symbol }, select: { id: true } });
      if (!inst) return { ok: false, reason: `no Instrument row for ${symbol}`, needsOperator: false };
      const rows = await this.prisma.candle.findMany({
        where: { instrumentId: inst.id, timeframe: interval, bucketStart: { gte: from, lte: to } },
        orderBy: { bucketStart: 'asc' },
      });
      if (!rows.length) {
        const newest = await this.prisma.candle.findFirst({
          where: { instrumentId: inst.id, timeframe: interval },
          orderBy: { bucketStart: 'desc' },
          select: { bucketStart: true },
        });
        return {
          ok: false,
          reason: newest
            ? `${interval} rows exist but none inside the requested window ` +
              `(${from.toISOString()}..${to.toISOString()}); newest stored bar is ${newest.bucketStart.toISOString()} — the backfill is stale`
            : `no ${interval} rows backfilled for ${symbol}`,
          needsOperator: false,
        };
      }
      return {
        ok: true,
        data: rows.map((r) => ({
          timestamp: r.bucketStart,
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: Number(r.volume),
          openInterest: r.openInterest != null ? Number(r.openInterest) : undefined,
        })),
      };
    } catch (err) {
      this.logger.warn(`candle table read failed for ${symbol} ${interval}: ${err}`);
      return { ok: false, reason: `candle table read failed — ${err instanceof Error ? err.message : String(err)}`, needsOperator: false };
    }
  }

  /** Real market breadth + India VIX from the live bridge's snapshot. */
  async getMarketBreadth(): Promise<MarketBreadth> {
    if (LIVE_FEED_URL) {
      const snap = await this.fetchJson<FeedSnapshot>(`${LIVE_FEED_URL}/quotes`);
      const stocks = snap?.stocks ?? [];
      if (stocks.length) {
        let advances = 0;
        let declines = 0;
        let unchanged = 0;
        for (const s of stocks) {
          const chg = s.changePct ?? 0;
          if (chg > 0) advances++;
          else if (chg < 0) declines++;
          else unchanged++;
        }
        const vixRow = (snap?.indices ?? []).find((i) => /vix/i.test(i.symbol));
        if (advances + declines > 0) {
          return { advances, declines, unchanged, vix: vixRow?.ltp };
        }
      }
    }
    // Unknown, not flat. Zeros are how "no breadth reading" is expressed to
    // composeSnapshot: `declines > 0` is false so breadthRatio becomes null,
    // and an absent vix becomes null. Both factors then report "no data"
    // rather than contributing an invented neutral reading. Breadth is
    // optional context, so unlike candles this does not fail the observation.
    return { advances: 0, declines: 0, unchanged: 0 };
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    const read = await this.readFeed<T>(url);
    return read.ok ? read.data : null;
  }

  /**
   * One read of the bridge, with the REASON preserved when it fails.
   *
   * `fetchJson` above kept the `catch { return null }` shape for the callers that
   * genuinely treat any failure as "no optional context" (breadth, quotes). But
   * for candles and expiries, null was the entire problem: it merged a timeout, a
   * dead credential, an unknown symbol and a genuinely empty answer into one
   * value, and the caller then invented a sentence about which of them had
   * happened. Anything that reports a fault to a user reads this instead.
   *
   * The abort is called out separately because it is the multi-user failure mode:
   * the bridge serializes option-chain calls behind a 3.1 s floor gap, so with
   * several users on different symbols the later ones exceed this 4 s deadline —
   * measured at 6.2 s, 9.4 s, 12.5 s, 15.6 s for the 3rd–6th concurrent caller.
   * "Timed out after 4000ms" is a materially different diagnosis from "no data",
   * and it is the one that points at the queue.
   */
  private async readFeed<T>(url: string): Promise<FeedRead<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIVE_FEED_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return { ok: false, reason: `bridge answered HTTP ${res.status}`, needsOperator: false };
      return { ok: true, data: (await res.json()) as T };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        reason: aborted
          ? `bridge did not answer within ${LIVE_FEED_TIMEOUT_MS}ms (SENTINEL_LIVE_FEED_TIMEOUT_MS)`
          : `bridge unreachable — ${err instanceof Error ? err.message : String(err)}`,
        needsOperator: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Real Dhan LTP/quote from the live bridge's snapshot for any symbol it
   * covers (indices, stocks, ETFs, commodities); simulator only if the bridge
   * is unset/unreachable or doesn't carry the symbol.
   */
  async getQuote(symbol: string): Promise<Quote> {
    const live = await this.quoteFromLiveFeed(symbol);
    if (live) return live;
    throw new MarketDataUnavailableError({
      what: 'quote',
      symbol,
      liveFeed: LIVE_FEED_URL
        ? 'bridge snapshot carries no tick for this symbol'
        : 'not configured (SENTINEL_LIVE_FEED_URL is unset)',
      storedHistory: 'not consulted — quotes are only served by the live bridge',
      needsOperator: !LIVE_FEED_URL,
    });
  }

  private async quoteFromLiveFeed(symbol: string): Promise<Quote | null> {
    if (!LIVE_FEED_URL) return null;
    const snap = await this.fetchJson<FeedSnapshot>(`${LIVE_FEED_URL}/quotes`);
    if (!snap) return null;
    const target = symbol.toUpperCase();
    const row = [
      ...(snap.indices ?? []),
      ...(snap.stocks ?? []),
      ...(snap.etfs ?? []),
      ...(snap.commodities ?? []),
    ].find((r) => r.symbol?.toUpperCase() === target);
    if (!row || typeof row.ltp !== 'number') return null;
    return {
      symbol,
      lastPrice: row.ltp,
      change: row.change ?? 0,
      changePercent: row.changePct ?? 0,
      volume: row.volume ?? 0,
      timestamp: new Date(),
    };
  }

  // --- options ---------------------------------------------------------
  //
  // `getOptionChain` returned `[]` for every symbol from 2026-07-26 until
  // 2026-08-16, with a comment describing that as "the honest answer" pending
  // the Phase 4 ingestion pipeline. It was honest and it was also unnecessary:
  // the live-feed bridge has served `/optionchain` and
  // `/optionchain/expirylist` the whole time — the web workspace's option
  // chain panel, its CE/PE charts and its strike pickers all read them. So the
  // ENGINE was the only part of TradeW that could not see the option market,
  // while the screen beside it showed a full chain.
  //
  // Consequences of that gap, all now closed: `snapshot.optionChain` was
  // always null, so PCR / max pain / OI walls never reached the confidence
  // engine's option factor, `buildOptionContext` reported `unavailable: true`
  // on every observation, and `positioningNotes` never produced a line.

  async getOptionChain(symbol: string, expiry?: Date): Promise<OptionChainEntry[]> {
    if (!LIVE_FEED_URL) return [];

    // The chain is optional context — `snapshot()` degrades the option factor to
    // "no data" without failing the observation — so a failed expiry read is
    // absorbed here rather than propagated. But it is LOGGED with its reason:
    // silently absorbing it is how a dead credential looked like a market with no
    // options for a whole session. `contracts()` calls `getOptionExpiries`
    // directly and does see the throw, which is where it belongs, because that
    // read is reported to the user.
    let expiryIso: string | undefined;
    try {
      expiryIso = expiry ? istDateKey(expiry) : (await this.getOptionExpiries(symbol))[0];
    } catch (err) {
      this.logger.warn(
        `option chain skipped for ${symbol} — could not read its expiry list: ${(err as Error).message}`,
      );
      return [];
    }
    if (!expiryIso) return []; // no options market for this instrument

    const cacheKey = `${symbol.toUpperCase()}:${expiryIso}`;
    const cached = this.chainCache.get(cacheKey);
    if (cached && Date.now() - cached.at < OPTION_CACHE_TTL_MS) return cached.entries;

    const json = await this.fetchJson<FeedOptionChain>(
      `${LIVE_FEED_URL}/optionchain?symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiryIso)}`,
    );
    if (!json || !Array.isArray(json.strikes) || json.strikes.length === 0) {
      // Rate-limited, bridge down, or genuinely no chain. All three degrade to
      // "no chain read", never to a fabricated one — the option factor reports
      // no data, exactly as it did when this method was a stub.
      return cached?.entries ?? [];
    }

    const expiryDate = new Date(`${expiryIso}T00:00:00+05:30`);
    const entries: OptionChainEntry[] = json.strikes
      .filter((row) => Number.isFinite(row.strike))
      .map((row) => ({
        strike: row.strike,
        expiry: expiryDate,
        callOI: row.ce?.oi ?? 0,
        putOI: row.pe?.oi ?? 0,
        callVolume: row.ce?.volume ?? 0,
        putVolume: row.pe?.volume ?? 0,
        callIV: row.ce?.iv ?? undefined,
        putIV: row.pe?.iv ?? undefined,
        callLtp: row.ce?.ltp ?? undefined,
        putLtp: row.pe?.ltp ?? undefined,
        // `?? undefined`, never `?? 0`. Zero is a legitimate previous OI for a
        // newly listed strike, so the absent case has to stay distinguishable
        // from it — `option-positioning.ts` reads `undefined` as "change is
        // unknowable" and 0 as "this strike carried nothing yesterday", and
        // collapsing the two would report every wall as built today.
        callPrevOI: row.ce?.previousOi ?? undefined,
        putPrevOI: row.pe?.previousOi ?? undefined,
        callPrevClose: row.ce?.previousClose ?? undefined,
        putPrevClose: row.pe?.previousClose ?? undefined,
      }));

    this.chainCache.set(cacheKey, { at: Date.now(), entries });
    return entries;
  }

  /**
   * Traded expiries, nearest first.
   *
   * Cached far longer than the chain itself: an expiry list changes when a
   * contract expires, not tick to tick, and every chain read starts with this
   * call. Without the cache a watch sweep over a dozen symbols would put two
   * dozen calls into the bridge's shared Dhan queue, which enforces a 3.1s
   * floor between option-family calls — the sweep would spend minutes waiting
   * on a list that had not changed.
   */
  async getOptionExpiries(symbol: string): Promise<string[]> {
    if (!LIVE_FEED_URL) return [];
    const key = symbol.toUpperCase();

    /**
     * ── EXPIRED CONTRACTS ARE FILTERED ON THE WAY OUT, NOT ON THE WAY IN ────
     *
     * Every return path in this method runs through `liveExpiries` against the
     * CURRENT IST trading date, including the three that serve a stale cache
     * entry after a failed read. That placement is the point.
     *
     * The list used to be stored and returned as `[...expiries].sort()` —
     * ordered, never date-filtered — and callers take `[0]`. So on the morning
     * after an expiry the engine observed a contract that had stopped trading:
     * `market-intelligence.service` reads `expiries[0]` for the CE/PE legs of
     * every `/observe` snapshot, and `contracts()` reads it for the pair it
     * reports to the user. Both would have been reading a dead series, and the
     * empty premium history that came back reads as a quiet market rather than
     * a rolled-over contract.
     *
     * Filtering at STORE time would not have fixed it: this cache holds an
     * entry for 15 minutes and is deliberately served stale for far longer when
     * the bridge is unreachable, so an entry filtered on the day it was read
     * keeps asserting that day's answer. The stored value is what the bridge
     * said; the returned value is what is live now.
     */
    const cached = this.expiryCache.get(key);
    if (cached && Date.now() - cached.at < EXPIRY_CACHE_TTL_MS) {
      return liveExpiries(cached.expiries, tradingDateIso());
    }

    const read = await this.readFeed<{ expiries?: string[] } & FeedFault>(
      `${LIVE_FEED_URL}/optionchain/expirylist?symbol=${encodeURIComponent(symbol)}`,
    );

    // ── A FAILED READ IS NOT "NO OPTIONS MARKET" ──────────────────────────
    //
    // The old code got the caching half of this right — it left the cache alone
    // so the next call would retry — and the return half catastrophically wrong:
    // `return cached?.expiries ?? []`. With no cache entry that is `[]`, and `[]`
    // is the contract's value for "this instrument has no options market". So a
    // 4 s timeout or a refused credential became a factual claim about NIFTY,
    // which `useExpiries` turned into `status: 'unavailable'` and the watch
    // creator printed as "NIFTY has no live option chain" — while the very next
    // line of that message listed NIFTY as an index that has one.
    //
    // Throwing is what makes the two distinguishable. `MarketDataProvider`
    // documents this: [] is an answer about the instrument, an exception is a
    // failure to read. Serving a still-valid stale list first is fine — that IS
    // a real answer — but inventing one is not.
    if (!read.ok) {
      if (cached) return liveExpiries(cached.expiries, tradingDateIso());
      throw new MarketDataUnavailableError({
        what: 'option expiry list',
        symbol,
        liveFeed: read.reason,
        storedHistory: 'not consulted — expiry lists are only served by the live bridge',
        needsOperator: read.needsOperator,
      });
    }

    const fault = faultText(read.data);
    if (fault) {
      if (cached) return liveExpiries(cached.expiries, tradingDateIso());
      throw new MarketDataUnavailableError({
        what: 'option expiry list',
        symbol,
        liveFeed: `bridge reported ${fault}`,
        storedHistory: 'not consulted — expiry lists are only served by the live bridge',
        needsOperator: read.data.needsOperator === true,
      });
    }

    if (!Array.isArray(read.data.expiries)) {
      if (cached) return liveExpiries(cached.expiries, tradingDateIso());
      throw new MarketDataUnavailableError({
        what: 'option expiry list',
        symbol,
        liveFeed: 'bridge returned a body with no expiries field',
        storedHistory: 'not consulted — expiry lists are only served by the live bridge',
        needsOperator: false,
      });
    }

    // Only a clean read caches. An empty array here IS Dhan's answer that this
    // instrument has no derivatives market, and caching that is correct.
    //
    // Stored RAW (normalised, but not date-filtered) and filtered on the way
    // out — see the `liveExpiries` call at the top of this method for why the
    // filter must not be baked into a cached value.
    const expiries = normaliseExpiryList(read.data.expiries);
    this.expiryCache.set(key, { at: Date.now(), expiries });
    return liveExpiries(expiries, tradingDateIso());
  }

  /**
   * Real Dhan OHLC for ONE option contract — the premium series.
   *
   * The bridge already sanitises these (Dhan occasionally returns the
   * underlying's prices on an option securityId; `/candles/option` rescales
   * against the live premium). Deliberately not re-sanitised here: two
   * independent corrections of the same artefact is how a correctly-priced
   * series gets scaled twice.
   */
  async getOptionCandles(
    contract: OptionContractRef,
    interval: CandleInterval,
    from: Date,
    to: Date,
  ): Promise<Candle[]> {
    const noContractHistory = (liveFeed: string, needsOperator = false) =>
      new MarketDataUnavailableError({
        what: `${interval} option candles`,
        symbol: contractLabel(contract),
        liveFeed,
        // No Candle-table fallback: contract OHLC has never been backfilled, so
        // there is no second real source to fall through to. Throwing is what
        // makes "could not read this leg" reach the caller as a fact rather than
        // an empty series that reads like a flat one.
        storedHistory: 'not consulted — contract OHLC is never backfilled, the bridge is the only source',
        needsOperator,
      });

    if (!LIVE_FEED_URL) throw noContractHistory('not configured (SENTINEL_LIVE_FEED_URL is unset)', true);

    const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
    const url =
      `${LIVE_FEED_URL}/candles/option?symbol=${encodeURIComponent(contract.symbol)}` +
      `&expiry=${encodeURIComponent(contract.expiry)}&strike=${contract.strike}` +
      `&type=${contract.side}&interval=${interval}&days=${days}`;

    const read = await this.readFeed<{ candles?: FeedCandle[]; source?: string } & FeedFault>(url);
    if (!read.ok) throw noContractHistory(read.reason, read.needsOperator);

    const json = read.data;
    const fault = faultText(json);
    if (fault) throw noContractHistory(`bridge reported ${fault}`, json.needsOperator === true);
    if (json.source !== 'dhan' || !Array.isArray(json.candles) || !json.candles.length) {
      throw noContractHistory(
        json.source === 'none'
          ? 'contract not found in the scrip master'
          : 'bridge answered with no bars for this contract',
      );
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    return json.candles
      .filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs)
      .map((c) => ({
        timestamp: new Date(c.timestamp),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        openInterest: c.openInterest,
      }));
  }

  // --- not yet served by the bridge ---
  // This used to return generated headlines. Empty is the honest answer:
  // NewsIntelligenceService reports no published flow rather than inventing
  // sentiment. A real integration lands with the Phase 4 pipeline.

  async getNews(_symbols?: string[], _sinceHours?: number): Promise<NewsItem[]> {
    return [];
  }

  /** Healthy only when a real source can actually answer. */
  async healthCheck(): Promise<boolean> {
    if (!LIVE_FEED_URL) return false;
    return (await this.fetchJson<FeedSnapshot>(`${LIVE_FEED_URL}/quotes`)) !== null;
  }
}
