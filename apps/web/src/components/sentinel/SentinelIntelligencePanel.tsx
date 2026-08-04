'use client';

import { useState } from 'react';
import { AnnotatedChart } from '@/components/strategy-workspace/AnnotatedChart';
import { OptionContextPanel } from '@/components/strategy-workspace/OptionContextPanel';
import { StrategyVisualization } from '@/components/strategy-workspace/StrategyVisualization';
import { useStrategyWorkspace } from '@/lib/strategy-workspace/useStrategyWorkspace';

const TIMEFRAMES = ['5m', '15m', '1h', '1d'] as const;

/**
 * SentinelIntelligence's reasoning + 3-panel visualization, embedded in the
 * Sentinel workspace itself rather than as a separate page.
 *
 * `symbol` is owned by the parent — `/sentinel`'s existing MarketSelector —
 * so switching the market head re-derives this panel exactly like every other
 * card on the page. Timeframe, strike and the free-text question are local:
 * they refine the reasoning run without changing which instrument the rest
 * of the page is reading.
 *
 * Was previously its own route (`/strategy-workspace`). Folded in because a
 * trader should not have to leave Sentinel to see the AI's reasoning about
 * the market they are already looking at — one workspace, not two.
 */
export function SentinelIntelligencePanel({ symbol }: { symbol: string }) {
  const [timeframe, setTimeframe] = useState<string>('15m');
  const [strikeInput, setStrikeInput] = useState('');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState<string | undefined>(undefined);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const parsedStrike = Number(strikeInput);
  const { data, unavailable, loading, refresh } = useStrategyWorkspace({
    symbol,
    timeframe,
    strike: Number.isFinite(parsedStrike) && parsedStrike > 0 ? parsedStrike : undefined,
    query: submittedQuery,
  });

  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[13px] font-semibold text-text">SentinelIntelligence — reasoning &amp; strategy visualization</h2>
          <p className="text-[11px] text-muted">
            10 specialist agents, citation-grounded, surfaced only at ≥70% confidence with corroboration
            {data && !loading && (
              <span className="text-faint">
                {' '}
                · {data.reasoning.corpus.chunks.toLocaleString()} passages learned from {data.reasoning.corpus.documents}{' '}
                sources
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
        <Fault unavailable={unavailable} />
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
          Analysing {symbol}…
        </div>
      )}
    </section>
  );
}

function Fault({ unavailable }: { unavailable: NonNullable<ReturnType<typeof useStrategyWorkspace>['unavailable']> }) {
  const fault =
    unavailable.kind === 'unauthenticated'
      ? { title: 'Not signed in', detail: 'Sign in to get a live reasoning read from SentinelIntelligence.' }
      : unavailable.kind === 'api-unreachable'
        ? { title: 'API not connected', detail: 'The TradeW API could not be reached, so no analysis ran.' }
        : unavailable.kind === 'no-market-data'
          ? { title: 'No market data', detail: unavailable.message }
          : {
              title: 'SentinelIntelligence not connected',
              detail: `HTTP ${unavailable.status}: ${unavailable.message}. Check that services/sentinel is running.`,
            };

  return (
    <div className="rounded-lg border border-border bg-surface p-4 text-center">
      <p className="text-[12.5px] font-semibold text-text">{fault.title}</p>
      <p className="mx-auto mt-1 max-w-xl text-[11.5px] leading-relaxed text-muted">{fault.detail}</p>
    </div>
  );
}

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
