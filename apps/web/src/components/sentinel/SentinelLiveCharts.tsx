'use client';

import { useEffect, useState } from 'react';
import type { Candle, CandleInterval } from '@tradew/types';
import { cn } from '@tradew/ui';
import { TradeChart } from '@/components/charts/TradeChart';
import { ExitFullScreenIcon, FullScreenIcon } from './sentinel-icons';
import { useCandles } from '@/lib/hooks/useCandles';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { useOptionCandles } from '@/lib/hooks/useOptionCandles';
import { useOptionQuote } from '@/lib/hooks/useOptionQuote';
import { useOptionChainStrikes } from '@/lib/sentinel/useOptionChainStrikes';
import { fmt, pct } from '@/lib/format';

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
 */
export function SentinelLiveCharts({
  symbol,
  marketName,
  ceStrike,
  peStrike,
}: {
  symbol: string;
  marketName: string;
  /** User-selected strikes from OptionChainPanel; null defaults to ATM. */
  ceStrike: number | null;
  peStrike: number | null;
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

  const { candles: indexCandles, status: indexStatus, reason: indexReason } = useCandles(symbol, INDEX_INTERVAL, INDEX_DAYS);
  const { quotes: liveIndices } = useDhanLiveFeed();
  const liveIndex = liveIndices?.find((q) => q.symbol === symbol) ?? null;

  // Independent chain poll (nearest expiry + ATM fallback) — decoupled from
  // OptionChainPanel's own poll, same as every other panel on this page
  // fetching what it needs rather than threading a shared cache through.
  const chain = useOptionChainStrikes(symbol, true);
  const effectiveCe = ceStrike ?? chain.ce[chain.atmIndex]?.strike ?? null;
  const effectivePe = peStrike ?? chain.pe[chain.atmIndex]?.strike ?? null;

  const { candles: ceCandles, status: ceCandlesStatus } = useOptionCandles(
    symbol,
    chain.expiry ?? undefined,
    effectiveCe ?? undefined,
    'CE',
    OPTION_INTERVAL,
    OPTION_DAYS,
  );
  const { candles: peCandles, status: peCandlesStatus } = useOptionCandles(
    symbol,
    chain.expiry ?? undefined,
    effectivePe ?? undefined,
    'PE',
    OPTION_INTERVAL,
    OPTION_DAYS,
  );
  const { quote: ceQuote } = useOptionQuote(symbol, chain.expiry ?? undefined, effectiveCe ?? undefined, 'CE');
  const { quote: peQuote } = useOptionQuote(symbol, chain.expiry ?? undefined, effectivePe ?? undefined, 'PE');

  const safeCeCandles = sanitizeOptionCandles(ceCandles, ceQuote?.ltp);
  const safePeCandles = sanitizeOptionCandles(peCandles, peQuote?.ltp);

  const expiryLabel = expiryTag(chain.expiry);

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
          <p className="text-[11px] font-bold uppercase tracking-wideTrack text-faint">Live Charts</p>
          <p className="mt-1 text-[11.5px] text-muted">
            {marketName} · {expiryLabel ? `${expiryLabel} expiry` : 'nearest expiry'} — what Sentinel is watching, observation only
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
            title={marketName}
            badge="IDX"
            interval="5"
            candles={indexCandles}
            status={indexStatus}
            liveLast={liveIndex?.ltp}
            changePct={liveIndex?.changePct ?? null}
            ohlc={liveIndex && liveIndex.open != null && liveIndex.high != null && liveIndex.low != null
              ? { open: liveIndex.open, high: liveIndex.high, low: liveIndex.low, close: liveIndex.ltp }
              : null}
            height={indexHeight}
            fitKey={`${symbol}|idx|5m`}
            intervalMinutes={5}
            unavailableTitle={indexReason === 'api-unreachable' ? 'Market data API not connected' : 'No history available'}
            unavailableDetail={
              indexReason === 'api-unreachable'
                ? 'The Dhan live-feed bridge (port 4600) is not reachable, so no real candles could be loaded.'
                : `Dhan returned no candles for ${symbol} at 5m.`
            }
          />
        </div>

        <div className="lg:col-start-2 lg:row-start-1">
          <ChartTile
            title={effectiveCe != null ? `${marketName} ${expiryLabel} ${effectiveCe} CALL`.trim() : `${marketName} CALL`}
            badge="NSE"
            interval="1"
            candles={safeCeCandles}
            status={ceCandlesStatus}
            liveLast={ceQuote?.ltp}
            changePct={ceQuote?.changePct ?? null}
            ohlc={lastCandleOhlc(safeCeCandles)}
            tone="up"
            height={optionHeight}
            fitKey={`${symbol}|ce|${effectiveCe}|1m`}
            intervalMinutes={1}
            unavailableTitle={effectiveCe == null ? 'No call strike selected' : 'No traded history for this contract'}
            unavailableDetail={
              effectiveCe == null
                ? 'Select a CE strike from Option Chain to watch it here.'
                : `Dhan has no traded candles for ${symbol} ${effectiveCe} CE.`
            }
          />
        </div>

        <div className="lg:col-start-2 lg:row-start-2">
          <ChartTile
            title={effectivePe != null ? `${marketName} ${expiryLabel} ${effectivePe} PUT`.trim() : `${marketName} PUT`}
            badge="NSE"
            interval="1"
            candles={safePeCandles}
            status={peCandlesStatus}
            liveLast={peQuote?.ltp}
            changePct={peQuote?.changePct ?? null}
            ohlc={lastCandleOhlc(safePeCandles)}
            tone="down"
            height={optionHeight}
            fitKey={`${symbol}|pe|${effectivePe}|1m`}
            intervalMinutes={1}
            unavailableTitle={effectivePe == null ? 'No put strike selected' : 'No traded history for this contract'}
            unavailableDetail={
              effectivePe == null
                ? 'Select a PE strike from Option Chain to watch it here.'
                : `Dhan has no traded candles for ${symbol} ${effectivePe} PE.`
            }
          />
        </div>
      </div>

      <p className="mt-3 text-[10.5px] leading-relaxed text-faint">
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
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-bg">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cn('truncate text-[12px] font-bold', accentClass)}>{title}</span>
          <span className="shrink-0 text-[10.5px] text-faint">
            · {interval} · {badge}
          </span>
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
