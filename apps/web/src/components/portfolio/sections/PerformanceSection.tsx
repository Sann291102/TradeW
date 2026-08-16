'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Skeleton, StatCard, cn } from '@tradew/ui';
import { inr, pct, sign } from '@/lib/format';
import {
  type MonthlyReturnsRange,
  type PerformanceOverview,
  type PortfolioValueRange,
  type TodayPerformance,
  fetchDailyPnl,
  fetchDiary,
  fetchMonthlyReturns,
  fetchPerformanceOverview,
  fetchPortfolioValueSeries,
  fetchTodayPerformance,
} from '@/lib/oms';
import { qk } from '@/lib/query/keys';
import { NEAR_LIVE_POLL_MS, liveQueryOptions } from '@/lib/query/live';
import { AreaChart } from '../charts/AreaChart';
import { BarChart } from '../charts/BarChart';
import { Pagination } from '../Pagination';

type Tab = 'Portfolio Value' | 'Daily P&L' | 'Monthly Returns' | 'Performance Diary';
const TABS: Tab[] = ['Portfolio Value', 'Daily P&L', 'Monthly Returns', 'Performance Diary'];
const VALUE_RANGES: PortfolioValueRange[] = ['1W', '1M', '3M', '1Y', 'ALL'];
const RETURNS_RANGES: MonthlyReturnsRange[] = ['3M', '6M', '1Y'];

export function PerformanceSection() {
  const [tab, setTab] = useState<Tab>('Portfolio Value');

  // The 15s cadence is the cache's now, so it pauses with the tab rather than
  // running against a screen nobody is looking at.
  const overviewQuery = useQuery({
    queryKey: qk.performance.overview(),
    queryFn: fetchPerformanceOverview,
    ...liveQueryOptions({ intervalMs: NEAR_LIVE_POLL_MS }),
  });
  const todayQuery = useQuery({
    queryKey: qk.performance.today(),
    queryFn: fetchTodayPerformance,
    ...liveQueryOptions({ intervalMs: NEAR_LIVE_POLL_MS }),
  });

  const overview = overviewQuery.data ?? null;
  const today = todayQuery.data ?? null;
  const failed = [overviewQuery, todayQuery].find((q) => q.isError && !q.data);
  const error = failed
    ? failed.error instanceof Error
      ? failed.error.message
      : 'Could not load performance'
    : null;

  return (
    <div>
      {error && (
        <div role="alert" className="mb-3 rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => {
              void overviewQuery.refetch();
              void todayQuery.refetch();
            }}
            className="mt-1.5 font-semibold underline underline-offset-2 hover:no-underline"
          >
            Try again
          </button>
        </div>
      )}

      <section className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {overview ? (
          <>
            <StatCard
              label="Portfolio Value"
              value={inr(overview.portfolioValue, 2)}
              delta={`${sign(overview.changeAmount)}${inr(Math.abs(overview.changeAmount), 2)} (${pct(overview.changePct)})`}
            />
            <StatCard label="Today's P&L" value={`${sign(overview.todaysPnl)}${inr(Math.abs(overview.todaysPnl), 2)}`} />
            <StatCard
              label="Overall P&L"
              value={`${sign(overview.overallPnl)}${inr(Math.abs(overview.overallPnl), 2)}`}
              delta={pct(overview.overallReturnPct)}
            />
            <StatCard label="Invested Amount" value={inr(overview.investedAmount, 2)} />
          </>
        ) : (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)
        )}
      </section>

      <section className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <TodayPanel today={today} />
        <SummaryPanel overview={overview} />
      </section>

      <div role="tablist" aria-label="Performance views" className="mb-3 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors duration-micro',
              tab === t ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Portfolio Value' && <PortfolioValuePanel />}
      {tab === 'Daily P&L' && <DailyPnlPanel />}
      {tab === 'Monthly Returns' && <MonthlyReturnsPanel />}
      {tab === 'Performance Diary' && <DiaryPanel />}
    </div>
  );
}

function TodayPanel({ today }: { today: TodayPerformance | null }) {
  if (!today) return <Skeleton className="h-40 w-full" />;
  const rows: Array<[string, string, 'up' | 'down' | 'neutral']> = [
    ["Today's P&L", `${sign(today.todaysPnl)}${inr(Math.abs(today.todaysPnl), 2)}`, today.todaysPnl >= 0 ? 'up' : 'down'],
    ["Today's Return %", pct(today.todaysReturnPct), today.todaysReturnPct >= 0 ? 'up' : 'down'],
    ["Today's Trades", String(today.todaysTrades), 'neutral'],
    ["Today's Realized P&L", `${sign(today.todaysRealizedPnl)}${inr(Math.abs(today.todaysRealizedPnl), 2)}`, today.todaysRealizedPnl >= 0 ? 'up' : 'down'],
    ["Today's Unrealized P&L", `${sign(today.todaysUnrealizedPnl)}${inr(Math.abs(today.todaysUnrealizedPnl), 2)}`, today.todaysUnrealizedPnl >= 0 ? 'up' : 'down'],
    ["Today's Charges", inr(today.todaysCharges, 2), 'neutral'],
  ];
  return (
    <div className="rounded-card border border-border bg-card p-4 shadow-card">
      <h3 className="mb-2 text-sm font-bold text-text">Today&apos;s Performance</h3>
      <dl className="space-y-1.5">
        {rows.map(([label, value, tone]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 border-b border-border pb-1 last:border-0">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className={cn('font-mono text-xs font-semibold tabular-nums', tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text')}>
              {value}
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-4 pt-1">
          <dt className="text-xs text-muted">Top Gainer / Loser</dt>
          <dd className="flex gap-2 text-xs">
            {today.topGainer ? (
              <Badge tone="positive" className="px-1.5 py-0 text-[10px]">
                {today.topGainer.symbol} +{inr(today.topGainer.pnl, 2)}
              </Badge>
            ) : (
              <span className="text-faint">—</span>
            )}
            {today.topLoser && (
              <Badge tone="negative" className="px-1.5 py-0 text-[10px]">
                {today.topLoser.symbol} {inr(today.topLoser.pnl, 2)}
              </Badge>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function SummaryPanel({ overview }: { overview: PerformanceOverview | null }) {
  if (!overview) return <Skeleton className="h-40 w-full" />;
  const winRate = overview.totalTrades > 0 ? (overview.winCount / overview.totalTrades) * 100 : 0;
  return (
    <div className="rounded-card border border-border bg-card p-4 shadow-card">
      <h3 className="mb-2 text-sm font-bold text-text">Lifetime Summary</h3>
      <dl className="space-y-1.5">
        <Row label="Overall Return %" value={pct(overview.overallReturnPct)} tone={overview.overallReturnPct >= 0 ? 'up' : 'down'} />
        <Row label="Total Trades" value={String(overview.totalTrades)} />
        <Row label="Wins" value={String(overview.winCount)} tone="up" />
        <Row label="Losses" value={String(overview.lossCount)} tone="down" />
        <Row label="Win Rate" value={`${winRate.toFixed(1)}%`} />
        <Row label="Margin Used" value={inr(overview.marginUsed, 2)} />
        <Row label="Available Margin" value={inr(overview.availableMargin, 2)} />
      </dl>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border pb-1 last:border-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn('font-mono text-xs font-semibold tabular-nums', tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text')}>
        {value}
      </dd>
    </div>
  );
}

function RangeTabs<T extends string>({ ranges, active, onChange }: { ranges: T[]; active: T; onChange: (r: T) => void }) {
  return (
    <div className="mb-2 flex gap-1">
      {ranges.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={cn(
            'rounded-md px-2 py-1 text-[11px] font-semibold transition-colors duration-micro',
            active === r ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

/**
 * A failed chart load used to be unrecoverable AND silent.
 *
 * These four panels each did `setPoints(null); void fetchX().then(setPoints)`.
 * The `void` swallowed the rejection, so a 500 left the skeleton up forever
 * with nothing on screen to say why and no way to ask again — the exact
 * "permanent error state" shape this audit set out to remove. And clearing to
 * `null` first meant every range switch dropped the chart to a grey block
 * before redrawing, even for a range the user had already viewed.
 *
 * One shared footer covers both: cached per range so re-selecting one is
 * instant, and a real retry when the request genuinely could not be served.
 */
function ChartFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex h-[180px] flex-col items-center justify-center gap-2 text-xs text-amber">
      <p>Could not load this chart.</p>
      <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2 hover:no-underline">
        Try again
      </button>
    </div>
  );
}

function PortfolioValuePanel() {
  const [range, setRange] = useState<PortfolioValueRange>('1M');
  const query = useQuery({
    queryKey: qk.performance.valueSeries(range),
    queryFn: () => fetchPortfolioValueSeries(range),
  });

  return (
    <div className="rounded-card border border-border bg-card p-4 shadow-card">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-bold text-text">Portfolio Value</h3>
        <RangeTabs ranges={VALUE_RANGES} active={range} onChange={setRange} />
      </div>
      {query.isError && !query.data ? (
        <ChartFailure onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <Skeleton className="h-[220px] w-full" />
      ) : (
        <AreaChart points={query.data} />
      )}
    </div>
  );
}

function DailyPnlPanel() {
  const [range, setRange] = useState<PortfolioValueRange>('1M');
  const query = useQuery({
    queryKey: qk.performance.dailyPnl(range),
    queryFn: () => fetchDailyPnl(range),
  });

  return (
    <div className="rounded-card border border-border bg-card p-4 shadow-card">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-bold text-text">Daily P&amp;L</h3>
        <RangeTabs ranges={VALUE_RANGES} active={range} onChange={setRange} />
      </div>
      {query.isError && !query.data ? (
        <ChartFailure onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <Skeleton className="h-[180px] w-full" />
      ) : (
        <BarChart points={query.data.map((b) => ({ label: b.dateKey.slice(5), value: b.netPnl }))} valueFormat="currency" />
      )}
    </div>
  );
}

function MonthlyReturnsPanel() {
  const [range, setRange] = useState<MonthlyReturnsRange>('6M');
  const query = useQuery({
    queryKey: qk.performance.monthlyReturns(range),
    queryFn: () => fetchMonthlyReturns(range),
  });

  return (
    <div className="rounded-card border border-border bg-card p-4 shadow-card">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-bold text-text">Monthly Returns</h3>
        <RangeTabs ranges={RETURNS_RANGES} active={range} onChange={setRange} />
      </div>
      {query.isError && !query.data ? (
        <ChartFailure onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <Skeleton className="h-[180px] w-full" />
      ) : (
        <BarChart points={query.data.map((b) => ({ label: b.month, value: b.returnPct }))} valueFormat="percent" />
      )}
    </div>
  );
}

const DIARY_PAGE_SIZE = 10;

function DiaryPanel() {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: qk.performance.diary(page, DIARY_PAGE_SIZE),
    queryFn: () => fetchDiary(page, DIARY_PAGE_SIZE),
  });

  const rows = query.data?.rows ?? null;
  const total = query.data?.total ?? 0;

  if (query.isError && !query.data) return <ChartFailure onRetry={() => void query.refetch()} />;

  if (rows === null) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <ul className="space-y-2">
        {rows.map((d) => (
          <li key={d.dateKey} className="rounded-card border border-border bg-card p-3 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', d.closingValue >= d.openingValue ? 'bg-up' : 'bg-down')}
                />
                <span className="text-sm font-bold text-text">{d.dateKey}</span>
                {d.source === 'derived' && (
                  <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                    ESTIMATED
                  </Badge>
                )}
              </div>
              <span className={cn('font-mono text-sm font-bold tabular-nums', d.closingValue >= d.openingValue ? 'text-up' : 'text-down')}>
                {sign(d.closingValue - d.openingValue)}
                {inr(Math.abs(d.closingValue - d.openingValue), 2)} ({pct(d.dailyReturnPct)})
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
              <Row label="Opening" value={inr(d.openingValue, 2)} />
              <Row label="Closing" value={inr(d.closingValue, 2)} />
              <Row label="Realized" value={`${sign(d.realizedPnl)}${inr(Math.abs(d.realizedPnl), 2)}`} tone={d.realizedPnl >= 0 ? 'up' : 'down'} />
              <Row label="Unrealized" value={`${sign(d.unrealizedPnl)}${inr(Math.abs(d.unrealizedPnl), 2)}`} tone={d.unrealizedPnl >= 0 ? 'up' : 'down'} />
              <Row label="Trades" value={`${d.tradesCount} (${d.winCount}W/${d.lossCount}L)`} />
              <Row label="Charges" value={inr(d.charges, 2)} />
              <Row label="Best" value={d.bestPerformer ? `${d.bestPerformer.symbol} +${inr(d.bestPerformer.pnl, 2)}` : '—'} tone="up" />
              <Row label="Worst" value={d.worstPerformer ? `${d.worstPerformer.symbol} ${inr(d.worstPerformer.pnl, 2)}` : '—'} tone="down" />
            </dl>
          </li>
        ))}
      </ul>
      <Pagination page={page} pageSize={DIARY_PAGE_SIZE} total={total} onChange={setPage} />
    </div>
  );
}
