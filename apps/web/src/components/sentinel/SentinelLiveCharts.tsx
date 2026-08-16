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
import { useOptionChainStrikes } from '@/lib/sentinel/useOptionChainStrikes';
import { findMarket } from '@/lib/sentinel/markets';
import { seriesNote, type ChartFocus } from '@/lib/sentinel/chartFocus';
import { fmt, pct } from '@/lib/format';

/**
 * The series drawn when nothing is under observation — a general market read
 * rather than a claim about what any engine is evaluating. With a focus, these
 * are replaced by the timeframe the sweep actually reads (see `chartFocus.ts`).
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
 * Strikes are whatever the user picked in OptionChainPanel (lifted to page
 * state and passed down as `ceStrike`/`peStrike`); before a pick is made this
 * falls back to the ATM strike from its own chain poll, same default
 * OptionChainPanel itself uses. Every series is real Dhan OHLC via the same
 * hooks the Trade workspace's ChartPanel uses — no simulated fallback, so an
 * unreachable bridge or an illiquid contract says so instead of drawing
 * placeholder candles.
 *
 * ── WITH A FOCUS ───────────────────────────────────────────────────────────
 * When a watch is selected, `focus` overrides all of that: the market becomes
 * the watch's, both legs pin to the strike the sweep is reading, and — the
 * part that matters — every series is drawn on the timeframe the ENGINE
 * evaluates rather than this component's own defaults. That is the whole
 * reason the focus exists. A 1m chart beside a 15m evaluation makes the
 * engine's verdicts uncheckable: the user is looking at bars Sentinel never
 * read, and any disagreement between the two is unexplainable.
 */
export function SentinelLiveCharts({
  symbol,
  marketName,
  ceStrike,
  peStrike,
  focus = null,
  footer = null,
}: {
  symbol: string;
  marketName: string;
  /** User-selected strikes from OptionChainPanel; null defaults to ATM. */
  ceStrike: number | null;
  peStrike: number | null;
  /**
   * The watch under observation. Null is the standing market read; a focus
   * makes this "here is what Sentinel is reading, on the bars it reads it on".
   */
  focus?: ChartFocus | null;
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

  // The focus owns the market too: a watch on BANKNIFTY must not be drawn
  // against whatever the market selector happens to be showing.
  const chartSymbol = focus?.symbol ?? symbol;
  const chartName = focus ? findMarket(focus.symbol).name : marketName;

  // One series for every panel when focused — the engine reads the index and
  // the contract on the SAME timeframe (`_candles_for` in the poller passes
  // one interval to both), so drawing them on two different ones would
  // misrepresent the comparison the engine is making.
  const indexInterval = focus?.series.interval ?? INDEX_INTERVAL;
  const indexDays = focus?.series.days ?? INDEX_DAYS;
  const optionInterval = focus?.series.interval ?? OPTION_INTERVAL;
  const optionDays = focus?.series.days ?? OPTION_DAYS;

  const { candles: indexCandles, status: indexStatus, reason: indexReason } = useCandles(
    chartSymbol,
    indexInterval,
    indexDays,
  );
  const { quotes: liveIndices } = useDhanLiveFeed();
  const liveIndex = liveIndices?.find((q) => q.symbol === chartSymbol) ?? null;

  // Independent chain poll (nearest expiry + ATM fallback) — decoupled from
  // OptionChainPanel's own poll, same as every other panel on this page
  // fetching what it needs rather than threading a shared cache through.
  const chain = useOptionChainStrikes(chartSymbol, true);

  // The watch's own expiry wins: it is the contract the sweep is reading, and
  // the nearest expiry may not be it.
  const expiry = focus?.expiry ?? chain.expiry;

  // A focused watch pins BOTH legs to its own strike. That is the comparison
  // the panel exists for — the leg Sentinel is reading beside its opposite, so
  // "which side is actually confirming" is one glance rather than two screens.
  // A watch with no strike is an index watch; it falls through to the user's
  // own pick and then ATM, exactly as before.
  const effectiveCe = focus?.strike ?? ceStrike ?? chain.ce[chain.atmIndex]?.strike ?? null;
  const effectivePe = focus?.strike ?? peStrike ?? chain.pe[chain.atmIndex]?.strike ?? null;

  const { candles: ceCandles, status: ceCandlesStatus, reason: ceReason } = useOptionCandles(
    chartSymbol,
    expiry ?? undefined,
    effectiveCe ?? undefined,
    'CE',
    optionInterval,
    optionDays,
  );
  const { candles: peCandles, status: peCandlesStatus, reason: peReason } = useOptionCandles(
    chartSymbol,
    expiry ?? undefined,
    effectivePe ?? undefined,
    'PE',
    optionInterval,
    optionDays,
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
        detail: `Select a ${side} strike from Option Chain to watch it here.`,
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
   * Which of the three panels the sweep is actually evaluating.
   *
   * The other two are context, and saying so matters: a watch on the 24350 CE
   * is not a watch on the index or on the put, and marking all three the same
   * would claim the engine is reading three instruments when it reads one.
   * Mirrors `_candles_for` in the poller — a strike watch reads the contract,
   * a strikeless watch reads the index.
   */
  const readingPanel: 'index' | 'ce' | 'pe' | null = !focus
    ? null
    : focus.strike != null && focus.optionType
      ? focus.optionType === 'CE'
        ? 'ce'
        : 'pe'
      : 'index';

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
            {focus ? 'What Sentinel is reading' : 'Live Charts'}
          </p>
          <p className="mt-1 text-[11.5px] text-muted">
            {chartName} · {expiryLabel ? `${expiryLabel} expiry` : 'nearest expiry'}
            {focus ? ` · ${focus.series.interval} bars` : ''} — what Sentinel is watching, observation only
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
        <div className="lg:col-start-1 lg:row-span-2">
          <ChartTile
            title={chartName}
            badge="IDX"
            interval={indexLabel}
            reading={readingPanel === 'index'}
            candles={indexCandles}
            status={indexStatus}
            liveLast={liveIndex?.ltp}
            changePct={liveIndex?.changePct ?? null}
            ohlc={liveIndex && liveIndex.open != null && liveIndex.high != null && liveIndex.low != null
              ? { open: liveIndex.open, high: liveIndex.high, low: liveIndex.low, close: liveIndex.ltp }
              : null}
            height={indexHeight}
            fitKey={`${chartSymbol}|idx|${indexInterval}`}
            intervalMinutes={focus?.series.minutes ?? 5}
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
            reading={readingPanel === 'ce'}
            candles={safeCeCandles}
            status={ceCandlesStatus}
            liveLast={ceQuote?.ltp}
            changePct={ceQuote?.changePct ?? null}
            ohlc={lastCandleOhlc(safeCeCandles)}
            tone="up"
            height={optionHeight}
            fitKey={`${chartSymbol}|ce|${effectiveCe}|${optionInterval}`}
            intervalMinutes={focus?.series.minutes ?? 1}
            unavailableTitle={ceUnavailable.title}
            unavailableDetail={ceUnavailable.detail}
          />
        </div>

        <div className="lg:col-start-2 lg:row-start-2">
          <ChartTile
            title={effectivePe != null ? `${chartName} ${expiryLabel} ${effectivePe} PUT`.trim() : `${chartName} PUT`}
            badge="NSE"
            interval={optionLabel}
            reading={readingPanel === 'pe'}
            candles={safePeCandles}
            status={peCandlesStatus}
            liveLast={peQuote?.ltp}
            changePct={peQuote?.changePct ?? null}
            ohlc={lastCandleOhlc(safePeCandles)}
            tone="down"
            height={optionHeight}
            fitKey={`${chartSymbol}|pe|${effectivePe}|${optionInterval}`}
            intervalMinutes={focus?.series.minutes ?? 1}
            unavailableTitle={peUnavailable.title}
            unavailableDetail={peUnavailable.detail}
          />
        </div>
      </div>

      {footer}

      {/* The series claim is separated from the provenance claim because they
          fail independently: the data can be real and still be the wrong bars,
          which is precisely the state this panel used to be in. */}
      {focus && (
        <p className="mt-3 text-[10.5px] leading-relaxed text-teal">{seriesNote(focus.series)}</p>
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
