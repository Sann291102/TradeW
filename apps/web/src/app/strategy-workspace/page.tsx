'use client';

import { useState } from 'react';
import { useSessionStore } from '@/lib/store/sessionStore';
import { MarketSelector } from '@/components/sentinel/MarketSelector';
import { SentinelLocked } from '@/components/sentinel/SentinelLocked';
import { AnnotatedChart } from '@/components/strategy-workspace/AnnotatedChart';
import { OptionContextPanel } from '@/components/strategy-workspace/OptionContextPanel';
import { StrategyVisualization } from '@/components/strategy-workspace/StrategyVisualization';
import { useStrategyWorkspace } from '@/lib/strategy-workspace/useStrategyWorkspace';
import { DEFAULT_MARKET, findMarket } from '@/lib/sentinel/markets';

const TIMEFRAMES = ['5m', '15m', '1h', '1d'] as const;

/**
 * Visual Strategy Workspace — three synchronized panels over one reasoning run.
 *
 *   1. the live market chart, with the AI's annotation layer drawn on it
 *   2. the option-chain context around the strike in focus
 *   3. the AI strategy visualization: what was concluded, why, from which rule,
 *      at what confidence, citing which passages
 *
 * "Synchronized" is a property of the data, not a UI trick: one request to
 * `/sentinel-intelligence/workspace` returns all three, derived from one
 * reasoning run against one candle series. Three panels polling independently
 * would drift out of step, and the annotations would describe a chart the user
 * is no longer looking at.
 *
 * Separate from `/sentinel`, which remains the orchestrator's workspace and is
 * untouched. Same shell, same auth, same `sentinel` entitlement.
 */
export default function StrategyWorkspacePage() {
  const [symbol, setSymbol] = useState(DEFAULT_MARKET);
  const [timeframe, setTimeframe] = useState<string>('15m');
  const [strikeInput, setStrikeInput] = useState('');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState<string | undefined>(undefined);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const status = useSessionStore((s) => s.status);
  const hasCapability = useSessionStore((s) => s.hasCapability);

  const parsedStrike = Number(strikeInput);
  const { data, unavailable, loading, refresh } = useStrategyWorkspace({
    symbol,
    timeframe,
    strike: Number.isFinite(parsedStrike) && parsedStrike > 0 ? parsedStrike : undefined,
    query: submittedQuery,
  });

  const market = findMarket(symbol);
  const locked = status === 'authenticated' && !hasCapability('sentinel');
  if (locked) return <SentinelLocked />;

  return (
    <div className="min-h-screen">
      <main className="mx-auto max-w-[1600px] space-y-4 p-4 sm:p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-text">Visual Strategy Workspace</h1>
            <p className="text-[12.5px] text-muted">
              Reading <span className="font-semibold text-text">{market.name}</span> on {timeframe}
              {loading && ' · analysing…'}
              {data && !loading && (
                <span className="text-faint">
                  {' '}
                  · {data.reasoning.corpus.chunks.toLocaleString()} passages learned from{' '}
                  {data.reasoning.corpus.documents} sources
                </span>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-[10px] text-faint">
              Strike
              <input
                value={strikeInput}
                onChange={(e) => setStrikeInput(e.target.value.replace(/[^\d.]/g, ''))}
                placeholder="ATM"
                inputMode="decimal"
                className="w-20 rounded border border-border bg-surface px-2 py-1 text-[12px] text-text"
              />
            </label>

            <div className="flex flex-col text-[10px] text-faint">
              Timeframe
              <div className="flex overflow-hidden rounded border border-border">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setTimeframe(tf)}
                    className={`px-2 py-1 text-[11.5px] transition-colors ${
                      timeframe === tf ? 'bg-accent/15 font-semibold text-text' : 'text-muted hover:text-text'
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            </div>

            <MarketSelector value={symbol} onChange={setSymbol} />
          </div>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmittedQuery(query.trim() || undefined);
          }}
          className="flex gap-2"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask in your own words — e.g. “does my ORB setup confirm on the 5 min?”"
            className="min-w-0 flex-1 rounded border border-border bg-surface px-3 py-1.5 text-[12px] text-text placeholder:text-faint"
          />
          <button
            type="submit"
            className="shrink-0 rounded border border-border px-3 py-1.5 text-[12px] text-text transition-colors hover:bg-accent/10"
          >
            Analyse
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 rounded border border-border px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-text"
          >
            Refresh
          </button>
        </form>

        {unavailable ? (
          <Fault unavailable={unavailable} marketName={market.name} />
        ) : data ? (
          <>
            {data.reasoning.understood.assumptions.length > 0 && (
              <Assumptions assumptions={data.reasoning.understood.assumptions} />
            )}

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-w-0 space-y-4">
                <AnnotatedChart
                  candles={data.candles}
                  annotations={data.annotations}
                  panes={data.panes}
                  symbol={data.symbol}
                  timeframe={data.timeframe}
                  focusedId={focusedId}
                  onFocus={setFocusedId}
                />
                <OptionContextPanel context={data.optionContext} />
              </div>

              <div className="min-w-0">
                <StrategyVisualization payload={data} focusedId={focusedId} onFocus={setFocusedId} />
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-border bg-surface p-6 text-center text-[12px] text-muted">
            Analysing {market.name}…
          </div>
        )}

        <p className="pb-6 text-center text-[11px] text-faint">
          SentinelIntelligence produces observations and educational context grounded in its learned knowledge base. It
          is not investment advice, it never recommends trades, and it never places orders.
        </p>
      </main>
    </div>
  );
}

/**
 * Each fault named for what it actually is.
 *
 * A single "sign in for live analysis" banner shown for API outages and dead
 * services was wrong in two cases out of three — the same lesson the Sentinel
 * workspace already learned.
 */
function Fault({
  unavailable,
  marketName,
}: {
  unavailable: NonNullable<ReturnType<typeof useStrategyWorkspace>['unavailable']>;
  marketName: string;
}) {
  const fault =
    unavailable.kind === 'unauthenticated'
      ? {
          title: 'Not signed in',
          detail:
            'The workspace runs its analysis against your account. Sign in to get a live read — no sample analysis is shown in the meantime.',
        }
      : unavailable.kind === 'api-unreachable'
        ? {
            title: 'API not connected',
            detail: `The TradeW API could not be reached, so no analysis ran for ${marketName}. Start services/api (port 4000) and reload.`,
          }
        : unavailable.kind === 'no-market-data'
          ? {
              title: 'No market data',
              detail: `${unavailable.message} The chart is left empty rather than drawn from placeholder bars.`,
            }
          : {
              title: 'SentinelIntelligence not connected',
              detail: `The API answered but the analysis could not complete (HTTP ${unavailable.status}: ${unavailable.message}). Check that services/sentinel is running on port 4010.`,
            };

  return (
    <div className="rounded-lg border border-border bg-surface p-6 text-center">
      <p className="text-[13px] font-semibold text-text">{fault.title}</p>
      <p className="mx-auto mt-1.5 max-w-xl text-[12px] leading-relaxed text-muted">{fault.detail}</p>
    </div>
  );
}

/**
 * What the engine had to assume.
 *
 * Surfaced rather than buried: an answer built on a guessed timeframe or a
 * snapped strike is a different answer, and the reader is entitled to know
 * which parts of the question the system supplied itself.
 */
function Assumptions({ assumptions }: { assumptions: { field: string; value: string; reason: string }[] }) {
  return (
    <details className="rounded-lg border border-border bg-surface px-3 py-2">
      <summary className="cursor-pointer text-[11px] text-muted">
        {assumptions.length} assumption{assumptions.length === 1 ? '' : 's'} made about your request
      </summary>
      <ul className="mt-1.5 space-y-1">
        {assumptions.map((assumption, i) => (
          <li key={i} className="text-[10.5px] leading-relaxed text-faint">
            <span className="font-medium text-muted">
              {assumption.field} = {assumption.value}
            </span>{' '}
            — {assumption.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}
