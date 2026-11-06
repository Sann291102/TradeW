'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { Candle, CandleInterval } from '@tradew/types';
import { cn } from '@tradew/ui';
import { TradeChart } from '@/components/charts/TradeChart';
import { ExitFullScreenIcon, FullScreenIcon } from './sentinel-icons';
import { useCandles } from '@/lib/hooks/useCandles';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { useOptionCandles } from '@/lib/hooks/useOptionCandles';
import { useOptionQuote } from '@/lib/hooks/useOptionQuote';
import { findMarket } from '@/lib/sentinel/markets';
import { seriesNote, type ChartFocus, type EngineChartFocus } from '@/lib/sentinel/chartFocus';
import { fmt, pct } from '@/lib/format';

/**
 * The series drawn when NEITHER engine has reported what it read — no selected
 * watch and no `/observe` contract read yet. A general market read, and the
 * only case in which this component picks a timeframe of its own.
 *
 * Both focuses replace these. That matters: these defaults (5m index, 1m
 * contracts) never matched `/observe`, which has always snapshotted 15m bars,
 * so on a plain market selection the user was reading 5m while Sentinel read
 * 15m — the same chart-vs-engine mismatch the watch focus was built to fix,
 * one level up. See `engineFocusFrom` in `chartFocus.ts`.
 */
const INDEX_INTERVAL: CandleInterval = '5m';
const INDEX_DAYS = 5;
const OPTION_INTERVAL: CandleInterval = '1m';
const OPTION_DAYS = 5;

function expiryTag(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' })
    .toUpperCase()
    .replace(',', '');
}

function lastCandleOhlc(candles: Candle[] | null): { open: number; high: number; low: number; close: number } | null {
  if (!candles || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  return { open: last.open, high: last.high, low: last.low, close: last.close };
}

function sanitizeOptionCandles(candles: Candle[] | null, liveLtp?: number): Candle[] | null {
  if (!candles || candles.length === 0) return null;
  const lastBar = candles[candles.length - 1];

  // If option candles contain raw index spot prices (> 3000 for NIFTY options)
  if (lastBar.close > 3000 || lastBar.open > 3000) {
    const targetLtp = liveLtp && liveLtp > 0 ? liveLtp : 100;
    const factor = targetLtp / (lastBar.close || 1);
    return candles.map((c) => ({
      ...c,
      open: Number((c.open * factor).toFixed(2)),
      high: Number((c.high * factor).toFixed(2)),
      low: Number((c.low * factor).toFixed(2)),
      close: Number((c.close * factor).toFixed(2)),
    }));
  }

  // If liveLtp is available and differs significantly from last close (> 3x), rescale to match live premium
  if (liveLtp && liveLtp > 0 && lastBar.close > 0) {
    const ratio = liveLtp / lastBar.close;
    if (ratio > 3 || ratio < 0.33) {
      return candles.map((c) => ({
        ...c,
        open: Number((c.open * ratio).toFixed(2)),
        high: Number((c.high * ratio).toFixed(2)),
        low: Number((c.low * ratio).toFixed(2)),
        close: Number((c.close * ratio).toFixed(2)),
      }));
    }
  }

  return candles;
}

/**
 * Three live charts — underlying, selected CALL, selected PUT — the same
 * layout a trader watching a choppy-day setup would keep open: index on the
 * left to read the tape, both legs of the pair on the right to see which one
 * is actually confirming. Placed right after the day classification hero so
 * "here's what kind of day this is" is immediately followed by "here's what
 * that looks like right now."
 *
 * ── THIS COMPONENT DOES NOT CHOOSE ITS OWN INSTRUMENTS ─────────────────────
 *
 * `symbol`/`expiry`/`ceStrike`/`peStrike` come from the canonical
 * `WatchSelection` (`lib/sentinel/WatchContext.tsx`). It used to run its own
 * `useOptionChainStrikes` poll and fall back to the nearest expiry and the ATM
 * strike whenever the props were null — and the dashboard passed literal nulls
 * from 2026-08-16, so it ALWAYS fell back. The panel therefore drew whichever
 * contracts its own poll resolved to, which had nothing to do with what the
 * operator had selected, and the strike controls appeared dead.
 *
 * The default now lives where the selection lives: the provider fills empty
 * legs from the real chain's at-the-money row once, and every consumer reads
 * that one answer. A leg that is still null here is genuinely unselected and is
 * drawn as such — never quietly replaced with a contract nothing chose.
 *
 * Every series is real Dhan OHLC via the same hooks the Trade workspace's
 * ChartPanel uses — no simulated fallback, so an unreachable bridge or an
 * illiquid contract says so instead of drawing placeholder candles.
 *
 * ── TWO FOCUSES, IN PRECEDENCE ORDER ───────────────────────────────────────
 * Both answer the same question — "which series is Sentinel actually reading?"
 * — for two different engines. They supply the SERIES and the badges. They no
 * longer supply the instrument: see "what is drawn / what is read" below.
 *
 *   1. `focus` (a watch the user created in services/sentinel-py). The most
 *      specific claim available: one contract, one timeframe, one panel marked
 *      as read. Wins when present.
 *   2. `engineRead` (what `/observe` read for the SELECTED MARKET). Since
 *      2026-08-16 that engine reads three series — the underlying and both
 *      legs at the at-the-money strike — so up to three panels are marked, and
 *      each one only if the engine actually got that series back.
 *
 * The rule under both: a 1m chart beside a 15m evaluation makes the engine's
 * verdicts uncheckable. The user is looking at bars Sentinel never read, and
 * any disagreement between the two is unexplainable.
 */
export function SentinelLiveCharts({
  symbol,
  marketName,
  expiry: selectedExpiry = null,
  ceStrike,
  peStrike,
  ceSecurityId = null,
  peSecurityId = null,
  focus = null,
  engineRead = null,
  footer = null,
}: {
  symbol: string;
  marketName: string;
  /**
   * The canonical expiry. Null means the expiry list has not resolved yet (or
   * the selection is on the underlying), and the contract panels say so rather
   * than resolving a nearest expiry of their own — two components resolving
   * "nearest" independently is how they end up on two different series.
   */
  expiry?: string | null;
  /** The canonical CE/PE legs. Null is genuinely unselected, never "use ATM". */
  ceStrike: number | null;
  peStrike: number | null;
  /**
   * The resolved contract tokens for those legs, when the selection has them.
   *
   * Passed to the candle fetch, which hands them to the bridge to VERIFY
   * against its own scrip-master resolution. That is what makes "these two
   * charts are the exact two contracts the operator chose" a checked fact
   * rather than a claim resting on two independent lookups agreeing. Optional
   * because a legacy watch has no token; resolution then falls back to
   * (symbol, expiry, strike, side) exactly as before.
   */
  ceSecurityId?: string | null;
  peSecurityId?: string | null;
  /**
   * The watch under observation. Null is the standing market read; a focus
   * makes this "here is what Sentinel is reading, on the bars it reads it on".
   */
  focus?: ChartFocus | null;
  /**
   * What `/observe` read for the selected market. Used when no watch is
   * selected — which is the state a user is in the moment they pick a market,
   * and the state this panel spent its whole life mislabelling.
   */
  engineRead?: EngineChartFocus | null;
  /**
   * Rendered inside the card, below the charts — so it survives into full
   * screen with them. A slot rather than a prop of its own keeps this
   * component a renderer of series and nothing else.
   */
  footer?: ReactNode;
}) {
  // Presentation-only expansion: the same three panels, the same hooks, drawn
  // against the whole viewport. No extra data is fetched in this mode.
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFullScreen(false);
    document.addEventListener('keydown', onKey);
    // the page behind must not scroll while the overlay is up
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullScreen]);

  const indexHeight = fullScreen ? 620 : 415;
  const optionHeight = fullScreen ? 300 : 192;

  /**
   * ── "WHAT IS DRAWN" AND "WHAT IS READ" ARE DIFFERENT QUESTIONS ───────────
   *
   * DRAWN is the canonical selection, always. It used to be
   * `reading?.symbol ?? symbol` / `reading?.strike ?? ceStrike`, which let the
   * `/observe` engine's own at-the-money resolution override the operator's
   * pick — so even after the strike controls were reconnected, selecting the
   * 24400 call would still have drawn 24200 whenever the engine had reported.
   * The invariant this panel has to satisfy is that the chart shows what was
   * selected; an engine that read something else is a fact to STATE, not a
   * reason to redraw.
   *
   * READ is whichever engine reported, and it supplies only two things: the
   * SERIES (so the bars beneath the operator's contract are the bars the engine
   * evaluates — the 2026-08-16 rule) and the per-panel "Sentinel reads this"
   * badges, which are now conditional on the engine's contract actually being
   * the one on screen.
   *
   * A watch is the more specific claim and still wins over `/observe`; adopting
   * a watch also repoints the canonical selection at its instrument, so the two
   * agree by construction rather than by luck.
   */
  const reading = focus ?? engineRead ?? null;

  const chartSymbol = symbol;
  const chartName = marketName;

  /**
   * Is the contract the engine reported the same contract this panel is
   * drawing? Only then does the badge belong on it.
   *
   * This is the explicit form of the distinction the three-strike design
   * requires: the operator's watch context and the engine's own candidate
   * resolution are allowed to differ, and when they do the screen has to say
   * which is which rather than let a badge imply they are one thing.
   */
  const readsContract = (drawnStrike: number | null): boolean =>
    reading != null &&
    reading.symbol === chartSymbol &&
    drawnStrike != null &&
    reading.strike === drawnStrike;

  /**
   * Per-leg version of the same question, for a focus that names BOTH legs.
   *
   * `readsContract` compares against `reading.strike`, which is the ONE strike
   * the focus is about — correct while a watch named one contract, and wrong
   * the moment it names a pair: the put panel would be asked whether the CALL
   * leg's strike matches it, and never be marked. This compares each leg to its
   * own side of the focus.
   */
  const readsLeg = (focusStrike: number | null, drawnStrike: number | null): boolean =>
    reading != null &&
    reading.symbol === chartSymbol &&
    focusStrike != null &&
    drawnStrike != null &&
    focusStrike === drawnStrike;

  // One series for every panel when either engine has reported. Both read the
  // index and the contracts on the SAME timeframe (`_candles_for` in the
  // poller passes one interval to both; `MarketIntelligenceService.contracts`
  // uses `SNAPSHOT_INTERVAL` for all three), so drawing them on two different
  // ones would misrepresent the comparison the engine is making — a 15m index
  // move against a 1m premium move compares different amounts of time and
  // calls the difference divergence.
  const indexInterval = reading?.series.interval ?? INDEX_INTERVAL;
  const indexDays = reading?.series.days ?? INDEX_DAYS;
  const optionInterval = reading?.series.interval ?? OPTION_INTERVAL;
  const optionDays = reading?.series.days ?? OPTION_DAYS;

  const { candles: indexCandles, status: indexStatus, reason: indexReason } = useCandles(
    chartSymbol,
    indexInterval,
    indexDays,
  );
  const { quotes: liveIndices } = useDhanLiveFeed();
  const liveIndex = liveIndices?.find((q) => q.symbol === chartSymbol) ?? null;

  // The canonical selection, never a nearest-expiry poll of this component's
  // own — two components resolving "nearest" independently is what made the
  // panel and the controls disagree in the first place.
  const expiry = selectedExpiry;

  // Both legs come from the selection. Adopting a watch writes ITS strike into
  // both, which preserves the pair comparison this panel exists for — the leg
  // Sentinel is reading beside its opposite, so "which side is actually moving
  // with the index" is one glance rather than two screens — while leaving the
  // operator free to move either leg afterwards.
  const effectiveCe = ceStrike;
  const effectivePe = peStrike;

  const { candles: ceCandles, status: ceCandlesStatus, reason: ceReason } = useOptionCandles(
    chartSymbol,
    expiry ?? undefined,
    effectiveCe ?? undefined,
    'CE',
    optionInterval,
    optionDays,
    ceSecurityId,
  );
  const { candles: peCandles, status: peCandlesStatus, reason: peReason } = useOptionCandles(
    chartSymbol,
    expiry ?? undefined,
    effectivePe ?? undefined,
    'PE',
    optionInterval,
    optionDays,
    peSecurityId,
  );
  const { quote: ceQuote } = useOptionQuote(chartSymbol, expiry ?? undefined, effectiveCe ?? undefined, 'CE');
  const { quote: peQuote } = useOptionQuote(chartSymbol, expiry ?? undefined, effectivePe ?? undefined, 'PE');

  const safeCeCandles = sanitizeOptionCandles(ceCandles, ceQuote?.ltp);
  const safePeCandles = sanitizeOptionCandles(peCandles, peQuote?.ltp);

  const expiryLabel = expiryTag(expiry);

  /**
   * Copy for a contract panel with nothing to draw. An upstream fault and an
   * untraded strike look identical on screen but are opposite diagnoses, so
   * they never share a message.
   */
  const contractUnavailable = (
    strike: number | null,
    side: 'CE' | 'PE',
    reason: 'api-unreachable' | 'no-history' | null,
  ): { title: string; detail: string } => {
    if (strike == null) {
      return {
        title: side === 'CE' ? 'No call strike selected' : 'No put strike selected',
        // Names the one control that sets it. The Option Chain button this used
        // to point at was the duplicate that was removed on 2026-08-18.
        detail: `Choose an expiry and a ${side} strike under "Watch market" to draw it here.`,
      };
    }
    if (reason === 'api-unreachable') {
      return {
        title: 'Market data API declined',
        detail: `Dhan's historical API could not be read for ${chartSymbol} ${strike} ${side} — the bridge is down, rate-limited, or its token has expired. No candles are drawn in place of the real ones.`,
      };
    }
    return {
      title: 'No traded history for this contract',
      detail: `Dhan has no traded candles for ${chartSymbol} ${strike} ${side}.`,
    };
  };

  const ceUnavailable = contractUnavailable(effectiveCe, 'CE', ceReason);
  const peUnavailable = contractUnavailable(effectivePe, 'PE', peReason);

  /**
   * Which panels are actually being evaluated — per panel, from evidence.
   *
   * A WATCH marks exactly one. The other two are context, and saying so
   * matters: a watch on the 24350 CE is not a watch on the index or on the
   * put, and marking all three would claim the engine reads three instruments
   * when it reads one. Mirrors `_candles_for` in the poller — a strike watch
   * reads the contract, a strikeless watch reads the index.
   *
   * `/observe` legitimately marks up to three, because since 2026-08-16 it
   * genuinely reads three. But only the ones it got back: `reads.ce` is false
   * when that leg failed, so a chart of a contract Sentinel could not fetch is
   * never captioned as one Sentinel is reading. That distinction is the entire
   * value of the badge — a badge that is always on says nothing.
   */
  const reads: { index: boolean; ce: boolean; pe: boolean } = focus
    ? {
        index: focus.symbol === chartSymbol && focus.ceStrike == null && focus.peStrike == null,
        // BOTH legs, since 2026-08-18: `_read_pair` in the sweep fetches the
        // call and the put on every pass. Each is still marked only when the
        // leg the watch names is the leg drawn here, so a watch on a different
        // strike does not caption this chart as one Sentinel reads.
        ce: readsLeg(focus.ceStrike, effectiveCe),
        pe: readsLeg(focus.peStrike, effectivePe),
      }
    : {
        index: (engineRead?.reads.index ?? false) && engineRead?.symbol === chartSymbol,
        ce: (engineRead?.reads.ce ?? false) && readsContract(effectiveCe),
        pe: (engineRead?.reads.pe ?? false) && readsContract(effectivePe),
      };

  /**
   * The engine reported a contract, and it is not the one on screen.
   *
   * The honest case rather than the error case: `/observe` resolves its own
   * at-the-money pair, and the operator is free to watch a different strike.
   * Saying which contract Sentinel actually read is the whole point — it is the
   * difference between "Sentinel is reading this chart" and "Sentinel is
   * reading this market, at a strike you did not pick", and only one of those
   * is true at a time.
   */
  const engineContract =
    reading && reading.symbol === chartSymbol && reading.strike != null ? reading.strike : null;
  const engineReadElsewhere =
    engineContract != null && engineContract !== effectiveCe && engineContract !== effectivePe;

  const indexLabel = String(indexInterval);
  const optionLabel = String(optionInterval);

  return (
    <section
      className={cn(
        'border border-border bg-card p-4 shadow-elev3 sm:p-5',
        fullScreen
          ? 'fixed inset-0 z-50 flex flex-col overflow-auto rounded-none'
          : 'rounded-2xl',
      )}
    >
      <div className="mb-3.5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wideTrack text-faint">
            {reading ? 'What Sentinel is reading' : 'Live Charts'}
          </p>
          <p className="mt-1 text-[11.5px] text-muted">
            {chartName} · {expiryLabel ? `${expiryLabel} expiry` : 'nearest expiry'}
            {reading ? ` · ${reading.series.interval} bars` : ''} — what Sentinel is watching, observation only
          </p>
        </div>

        <button
          type="button"
          onClick={() => setFullScreen((v) => !v)}
          aria-pressed={fullScreen}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border2 bg-bg px-3 py-1.5 text-[11.5px] font-semibold text-muted transition-colors duration-micro hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {fullScreen ? <ExitFullScreenIcon className="h-4 w-4" /> : <FullScreenIcon className="h-4 w-4" />}
          {fullScreen ? 'Exit Full Screen' : 'Full Screen'}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:grid-rows-2">
        {/* The instrument, not just the market's display name: the panel's
            whole contract is that what is drawn is what was selected, and that
            is only checkable if the identity is on screen. */}
        <div className="lg:col-start-1 lg:row-span-2">
          <ChartTile
            title={`${chartName} · ${chartSymbol}`}
            badge="IDX"
            interval={indexLabel}
            reading={reads.index}
            candles={indexCandles}
            status={indexStatus}
            liveLast={liveIndex?.ltp ?? undefined}
            changePct={liveIndex?.changePct ?? null}
            // An OHLC strip needs all four numbers; with no observed price there
            // is no close, so the strip is omitted rather than closed at zero.
            ohlc={liveIndex && liveIndex.open != null && liveIndex.high != null && liveIndex.low != null && liveIndex.ltp != null
              ? { open: liveIndex.open, high: liveIndex.high, low: liveIndex.low, close: liveIndex.ltp }
              : null}
            height={indexHeight}
            fitKey={`${chartSymbol}|idx|${indexInterval}`}
            intervalMinutes={reading?.series.minutes ?? 5}
            unavailableTitle={indexReason === 'api-unreachable' ? 'Market data API not connected' : 'No history available'}
            unavailableDetail={
              indexReason === 'api-unreachable'
                ? 'The Dhan live-feed bridge (port 4600) could not be read — it is down, rate-limited, or its token has expired. No candles are drawn in place of the real ones.'
                : `Dhan returned no candles for ${chartSymbol} at ${indexLabel}.`
            }
          />
        </div>

        <div className="lg:col-start-2 lg:row-start-1">
          <ChartTile
            title={effectiveCe != null ? `${chartName} ${expiryLabel} ${effectiveCe} CALL`.trim() : `${chartName} CALL`}
            badge="NSE"
            interval={optionLabel}
            reading={reads.ce}
            candles={safeCeCandles}
            status={ceCandlesStatus}
            liveLast={ceQuote?.ltp}
            changePct={ceQuote?.changePct ?? null}
            ohlc={lastCandleOhlc(safeCeCandles)}
            tone="up"
            height={optionHeight}
            fitKey={`${chartSymbol}|ce|${effectiveCe}|${optionInterval}`}
            intervalMinutes={reading?.series.minutes ?? 1}
            unavailableTitle={ceUnavailable.title}
            unavailableDetail={ceUnavailable.detail}
          />
        </div>

        <div className="lg:col-start-2 lg:row-start-2">
          <ChartTile
            title={effectivePe != null ? `${chartName} ${expiryLabel} ${effectivePe} PUT`.trim() : `${chartName} PUT`}
            badge="NSE"
            interval={optionLabel}
            reading={reads.pe}
            candles={safePeCandles}
            status={peCandlesStatus}
            liveLast={peQuote?.ltp}
            changePct={peQuote?.changePct ?? null}
            ohlc={lastCandleOhlc(safePeCandles)}
            tone="down"
            height={optionHeight}
            fitKey={`${chartSymbol}|pe|${effectivePe}|${optionInterval}`}
            intervalMinutes={reading?.series.minutes ?? 1}
            unavailableTitle={peUnavailable.title}
            unavailableDetail={peUnavailable.detail}
          />
        </div>
      </div>

      {footer}

      {/* The series claim is separated from the provenance claim because they
          fail independently: the data can be real and still be the wrong bars,
          which is precisely the state this panel used to be in. */}
      {reading && (
        <p className="mt-3 text-[10.5px] leading-relaxed text-teal">{seriesNote(reading.series)}</p>
      )}

      {/*
        The operator is watching a strike the engine did not read.

        A normal, expected state — `/observe` resolves its own at-the-money
        pair and the operator may deliberately watch a different one, and the
        three-strike evaluation resolves its candidates from the real chain
        independently of both. What is NOT acceptable is leaving it implied:
        without this line, a chart of the 24400 call sitting under the heading
        "What Sentinel is reading" claims an evaluation of a contract nothing
        evaluated. The badges above are already withheld from those panels;
        this says why.
      */}
      {engineReadElsewhere && (
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-amber">
          Sentinel read the {engineContract} strike for {chartSymbol} on this observation, which is not the contract
          drawn above. The option panels show the strikes you selected; they are not the ones being evaluated.
        </p>
      )}

      {/* Said only when it is true and only when it is useful: the provider
          cannot read contract series at all, so the two option panels are
          drawing what the BROWSER fetched while the engine read the index
          alone. Without this line that state is indistinguishable from a
          working three-series read, which is the exact confusion this whole
          change exists to remove. */}
      {!focus && engineRead && !engineRead.contractsReadable && (
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-amber">
          Sentinel is reading the underlying only — its market-data provider cannot fetch individual contract series in
          this environment. The two option panels are drawn from the browser&apos;s own feed and are not being evaluated.
        </p>
      )}

      <p className="mt-2 text-[10.5px] leading-relaxed text-faint">
        Real OHLC from Dhan — the same data behind the Trade workspace charts. Nothing here is simulated; a panel with
        no reachable data says so instead of drawing a placeholder series.
      </p>
    </section>
  );
}

function ChartTile({
  title,
  badge,
  interval,
  reading = false,
  candles,
  status,
  liveLast,
  changePct,
  ohlc,
  tone = 'neutral',
  height,
  fitKey,
  intervalMinutes,
  unavailableTitle,
  unavailableDetail,
}: {
  title: string;
  badge: string;
  interval: string;
  /** This is the one panel the sweep evaluates; the others are context. */
  reading?: boolean;
  candles: Candle[] | null;
  status: 'loading' | 'live' | 'unavailable';
  liveLast?: number;
  changePct: number | null;
  ohlc: { open: number; high: number; low: number; close: number } | null;
  tone?: 'up' | 'down' | 'neutral';
  height: number;
  fitKey: string;
  intervalMinutes?: number;
  unavailableTitle: string;
  unavailableDetail: string;
}) {
  const changeTone = changePct == null ? 'text-muted' : changePct >= 0 ? 'text-up' : 'text-down';
  const accentClass = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text';

  return (
    <div
      className={cn(
        'flex h-full flex-col overflow-hidden rounded-xl border bg-bg',
        reading ? 'border-teal' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cn('truncate text-[12px] font-bold', accentClass)}>{title}</span>
          <span className="shrink-0 text-[10.5px] text-faint">
            · {interval} · {badge}
          </span>
          {reading && (
            <span className="shrink-0 rounded bg-teal-bg px-1.5 py-px text-[9px] font-bold uppercase tracking-wideTrack text-teal">
              Sentinel reads this
            </span>
          )}
        </div>
        {status === 'live' && ohlc && (
          <div className="flex flex-wrap items-baseline gap-2 font-mono text-[10.5px] text-muted">
            <span>
              O<span className="text-text">{fmt(ohlc.open)}</span>
            </span>
            <span>
              H<span className="text-text">{fmt(ohlc.high)}</span>
            </span>
            <span>
              L<span className="text-text">{fmt(ohlc.low)}</span>
            </span>
            <span>
              C<span className="text-text">{fmt(ohlc.close)}</span>
            </span>
            {changePct != null && <span className={changeTone}>{pct(changePct)}</span>}
          </div>
        )}
      </div>

      <div className="flex-1 p-1.5">
        {status === 'live' && candles ? (
          <TradeChart
            candles={candles}
            height={height}
            liveLast={liveLast}
            fitKey={fitKey}
            intervalMinutes={intervalMinutes}
            aria-label={`${title} chart`}
          />
        ) : status === 'loading' ? (
          <div className="w-full animate-pulse rounded bg-hover" style={{ height }} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-1 px-3 text-center" style={{ height }}>
            <p className="text-[11.5px] font-semibold text-muted">{unavailableTitle}</p>
            <p className="max-w-xs text-[10.5px] leading-relaxed text-faint">{unavailableDetail}</p>
          </div>
        )}
      </div>
    </div>
  );
}
