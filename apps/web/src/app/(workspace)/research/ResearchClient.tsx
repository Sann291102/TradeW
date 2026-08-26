'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CandleLoader, buttonClasses, cn } from '@tradew/ui';
import { fetchResearchSnapshot } from '@/lib/research/api';
import { fetchResearchPreferences, saveResearchPreferences } from '@/lib/research/storage';
import { RESEARCH_SECTIONS, type ResearchSectionKey } from '@/lib/research/sections';
import type { PeriodType, ResearchAnalysis, ResearchSnapshot, StatementType, SymbolSearchHit } from '@/lib/research/types';
import { asOf } from '@/lib/research/format';
import { useSignedIn } from '@/lib/query/usePortfolio';
import { SymbolSearch } from '@/components/research/SymbolSearch';
import { CompanyHeader } from '@/components/research/CompanyHeader';
import { StatementTable } from '@/components/research/StatementTable';
import { ReconciliationBanner } from '@/components/research/ReconciliationBanner';
import { RatiosSection } from '@/components/research/RatiosSection';
import { HistoryChart } from '@/components/research/HistoryChart';
import { OwnershipPanel, SegmentsPanel } from '@/components/research/OwnershipPanel';
import { AiResearchPanel } from '@/components/research/AiResearchPanel';
import { DataUnavailable } from '@/components/research/DataUnavailable';
import { NewsAndEventsPanel } from '@/components/research/NewsAndEventsPanel';
import { AnalystResearchPanel } from '@/components/research/AnalystResearchPanel';
import { TechnicalAnalysisPanel } from '@/components/research/TechnicalAnalysisPanel';
import { EarningsIntelligencePanel } from '@/components/research/EarningsIntelligencePanel';
import { ValuationPanel } from '@/components/research/ValuationPanel';
import { PeerResearchPanel } from '@/components/research/PeerResearchPanel';
import { KnowledgeGraphPanel } from '@/components/research/KnowledgeGraphPanel';
import { SignalsPanel } from '@/components/research/SignalsPanel';
import { SavedResearchPanel } from '@/components/research/SavedResearchPanel';
import { WatchlistButton } from '@/components/research/WatchlistButton';
import { downloadFile, toCsv, todayStamp } from '@/lib/settings/export';

/**
 * The Research workspace.
 *
 * ── WHAT THIS REPLACED, AND THE RULE THAT REPLACED IT ──────────────────────
 *
 * The previous version of this route (archived at
 * archive/web-research-fabricated-page-2026-08-23.tsx.txt) rendered an "AI
 * summary" with an invented confidence score, a fixed set of fundamentals shown
 * identically for every symbol, two contradictory market-cap figures on one
 * screen, nine tabs that changed only a highlight colour, and four buttons with
 * no handler. See docs/audits/SIDEBAR-FEATURE-REALITY-AUDIT.md §4.8.
 *
 * Every number on this page now arrives from `GET /research/:symbol` as part of
 * a section that is either `available` with data or `available: false` with a
 * reason. Nothing is defaulted, nothing is filled in, and every control below
 * either performs a real operation or does not exist.
 *
 * ── STATE IN THE URL ───────────────────────────────────────────────────────
 *
 * Symbol, section and reporting basis all live in the query string, so a
 * particular view of a particular company is a link someone can send — which is
 * most of what a research surface is for.
 */

const STATEMENTS: Array<{ key: StatementType; label: string; field: 'income' | 'balance' | 'cashFlow' }> = [
  { key: 'income', label: 'Profit & Loss', field: 'income' },
  { key: 'balance', label: 'Balance Sheet', field: 'balance' },
  { key: 'cash_flow', label: 'Cash Flow', field: 'cashFlow' },
];

/** The symbol shown when none is requested. A widely-covered large cap, so a
 *  first visit lands on a company the provider is most likely to hold. */
const DEFAULT_SYMBOL = 'RELIANCE';

export function ResearchClient() {
  const router = useRouter();
  const params = useSearchParams();
  const signedIn = useSignedIn();

  const symbol = (params.get('symbol') || DEFAULT_SYMBOL).toUpperCase();
  const periodType: PeriodType = params.get('period') === 'quarterly' ? 'quarterly' : 'annual';
  const section = (RESEARCH_SECTIONS.find((s) => s.key === params.get('section'))?.key ?? 'overview') as ResearchSectionKey;
  const [statement, setStatement] = useState<StatementType>('income');
  const [latestAnalysis, setLatestAnalysis] = useState<ResearchAnalysis | null>(null);

  const setParam = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) next.set(k, v);
      router.replace(`/research?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  const query = useQuery({
    queryKey: ['research', 'snapshot', symbol, periodType],
    queryFn: () => fetchResearchSnapshot(symbol, periodType),
    enabled: signedIn,
    // Statements change quarterly and the API caches them; refetching on every
    // focus would spend a credit-metered budget for data that cannot have moved.
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const onSelect = useCallback(
    (hit: SymbolSearchHit) => setParam({ symbol: hit.symbol.toUpperCase() }),
    [setParam],
  );

  useEffect(() => {
    if (!signedIn) return;
    void (async () => {
      try {
        const prefs = await fetchResearchPreferences();
        const nextHistory = [{ symbol, periodType, viewedAt: new Date().toISOString() }, ...prefs.history.filter((entry) => !(entry.symbol === symbol && entry.periodType === periodType))].slice(0, 30);
        await saveResearchPreferences({ ...prefs, history: nextHistory });
      } catch {
        // History tracking is a convenience; a failed write must not block reading.
      }
    })();
  }, [periodType, signedIn, symbol]);

  if (!signedIn) {
    return (
      <Shell symbol={symbol} onSelect={onSelect} periodType={periodType} setParam={setParam} section={section} disabled>
        <Card>
          <p className="text-sm text-muted">Sign in to research companies.</p>
        </Card>
      </Shell>
    );
  }

  if (query.isPending) {
    return (
      <Shell symbol={symbol} onSelect={onSelect} periodType={periodType} setParam={setParam} section={section} disabled>
        <div className="flex justify-center py-16">
          <CandleLoader size="md" label={`Loading research for ${symbol}`} />
        </div>
      </Shell>
    );
  }

  if (query.isError) {
    return (
      <Shell symbol={symbol} onSelect={onSelect} periodType={periodType} setParam={setParam} section={section} disabled>
        <DataUnavailable
          title="Research could not be loaded"
          reason={query.error instanceof Error ? query.error.message : 'The research service did not answer.'}
          action={
            <button
              type="button"
              onClick={() => void query.refetch()}
              className={buttonClasses({ variant: 'outline', size: 'sm' })}
            >
              Try again
            </button>
          }
        />
      </Shell>
    );
  }

  const snapshot = query.data;

  return (
    <Shell symbol={symbol} onSelect={onSelect} periodType={periodType} setParam={setParam} section={section} snapshot={snapshot}>
      <CompanyHeader overview={snapshot.overview} />

      {snapshot.overview.available && (
        <div className="flex justify-end">
          <WatchlistButton
            symbol={snapshot.overview.data.profile.symbol}
            name={snapshot.overview.data.profile.name}
            exchange={snapshot.overview.data.profile.exchange}
          />
        </div>
      )}

      {section === 'overview' && <OverviewPane snapshot={snapshot} onGoTo={(s) => setParam({ section: s })} />}

      {section === 'financials' && (
        <Card
          title="Financial statements"
          subtitle={`· ${periodType}`}
          actions={<ExportButton snapshot={snapshot} statement={statement} />}
        >
          <div role="tablist" aria-label="Statement" className="mb-3 flex flex-wrap gap-1">
            {STATEMENTS.map((s) => (
              <button
                key={s.key}
                role="tab"
                aria-selected={statement === s.key}
                onClick={() => setStatement(s.key)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs font-bold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                  statement === s.key ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          <StatementPane snapshot={snapshot} statement={statement} />
        </Card>
      )}

      {section === 'ratios' && <RatiosSection section={snapshot.ratios} />}
      {section === 'history' && <HistoryChart section={snapshot.history} />}
      {section === 'ownership' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <OwnershipPanel section={snapshot.ownership} />
          <SegmentsPanel section={snapshot.segments} />
        </div>
      )}
      {section === 'news' && <NewsAndEventsPanel symbol={symbol} />}
      {section === 'analyst' && <AnalystResearchPanel symbol={symbol} />}
      {section === 'technicals' && (
        <TechnicalAnalysisPanel
          symbol={symbol}
          exchange={snapshot.overview.available ? snapshot.overview.data.profile.exchange : undefined}
        />
      )}
      {section === 'earnings' && <EarningsIntelligencePanel symbol={symbol} periodType={periodType} />}
      {section === 'valuation' && <ValuationPanel symbol={symbol} periodType={periodType} />}
      {section === 'peers' && <PeerResearchPanel symbol={symbol} periodType={periodType} />}
      {section === 'graph' && <KnowledgeGraphPanel symbol={symbol} />}
      {section === 'signals' && <SignalsPanel snapshot={snapshot} />}
      {section === 'saved' && <SavedResearchPanel symbol={symbol} periodType={periodType} latestAnalysis={latestAnalysis} />}
      {section === 'ai' && <AiResearchPanel symbol={symbol} periodType={periodType} onAnalysisReady={setLatestAnalysis} />}

      <p className="px-1 text-[10.5px] text-faint">
        Fundamental data provided by <span className="font-semibold">{snapshot.provider}</span>. Retrieved{' '}
        {asOf(snapshot.generatedAt)}. TradeW does not adjust, estimate or interpolate reported figures — anything a
        provider did not publish is shown as not reported.
      </p>
    </Shell>
  );
}

/** Header chrome shared by every state, so search stays usable while loading. */
function Shell({
  children,
  symbol,
  onSelect,
  periodType,
  section,
  setParam,
  disabled,
  snapshot,
}: {
  children: React.ReactNode;
  symbol: string;
  onSelect: (hit: SymbolSearchHit) => void;
  periodType: PeriodType;
  section: ResearchSectionKey;
  setParam: (patch: Record<string, string>) => void;
  disabled?: boolean;
  snapshot?: ResearchSnapshot;
}) {
  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold text-text">Research</h1>
          <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
            {symbol}
          </Badge>
        </div>
        <SymbolSearch onSelect={onSelect} currentSymbol={symbol} />
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav role="tablist" aria-label="Research section" className="flex flex-wrap gap-1">
          {RESEARCH_SECTIONS.map((s) => (
            <button
              key={s.key}
              role="tab"
              aria-selected={section === s.key}
              disabled={disabled}
              onClick={() => setParam({ section: s.key })}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-bold transition-colors duration-micro disabled:opacity-40',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                section === s.key ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* Annual / quarterly is a real switch: it re-requests the statements at
            the other cadence, and every downstream ratio and chart follows. */}
        <div role="group" aria-label="Reporting basis" className="flex items-center rounded-lg border border-border2 p-0.5">
          {(['annual', 'quarterly'] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={periodType === p}
              disabled={disabled && !snapshot}
              onClick={() => setParam({ period: p })}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px] font-bold capitalize transition-colors disabled:opacity-40',
                periodType === p ? 'bg-teal-bg text-teal' : 'text-muted hover:text-text',
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {children}
    </div>
  );
}

/** The overview pane: the latest statement at a glance, plus reconciliation. */
function OverviewPane({ snapshot, onGoTo }: { snapshot: ResearchSnapshot; onGoTo: (s: ResearchSectionKey) => void }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
      <Card
        title="Latest reported period"
        subtitle={`· ${snapshot.periodType}`}
        actions={
          <button
            type="button"
            onClick={() => onGoTo('financials')}
            className="text-xs font-semibold text-teal hover:underline"
          >
            All statements →
          </button>
        }
      >
        {snapshot.income.available ? (
          <StatementTable statement={trimTo(snapshot.income.data.statement, 3)} type="income" />
        ) : (
          <DataUnavailable title="Income statement unavailable" reason={snapshot.income.reason} />
        )}
      </Card>

      <div className="space-y-4">
        {snapshot.balance.available && snapshot.balance.data.reconciliation && (
          <ReconciliationBanner check={snapshot.balance.data.reconciliation} />
        )}
        <RatiosSection section={snapshot.ratios} />
      </div>
    </div>
  );
}

function StatementPane({ snapshot, statement }: { snapshot: ResearchSnapshot; statement: StatementType }) {
  const entry = STATEMENTS.find((s) => s.key === statement)!;
  const section = snapshot[entry.field];

  if (!section.available) {
    return <DataUnavailable title={`${entry.label} unavailable`} reason={section.reason} />;
  }

  return (
    <div className="space-y-3">
      {section.data.reconciliation && <ReconciliationBanner check={section.data.reconciliation} />}
      <StatementTable statement={section.data.statement} type={statement} />
    </div>
  );
}

/**
 * CSV of exactly what is on screen.
 *
 * Reuses the Reports page's `toCsv`/`downloadFile`. Only rendered when the
 * statement is actually available — a disabled or absent button is honest; an
 * enabled one that produces an empty file is not.
 */
function ExportButton({ snapshot, statement }: { snapshot: ResearchSnapshot; statement: StatementType }) {
  const entry = STATEMENTS.find((s) => s.key === statement)!;
  const section = snapshot[entry.field];
  if (!section.available) return null;

  const periods = section.data.statement.periods;
  const metrics = Array.from(new Set(periods.flatMap((p) => Object.keys(p.facts))));
  const rows = metrics.map((metric) => {
    const row: Record<string, unknown> = { metric };
    for (const p of periods) {
      const fact = p.facts[metric];
      // An absent fact stays an EMPTY CELL in the export. Writing 0 here would
      // put a fabricated number into a file someone opens in a spreadsheet,
      // where the provenance this UI carries no longer travels with it.
      row[`${p.fiscalYear}${p.fiscalQuarter ? `Q${p.fiscalQuarter}` : ''}`] = fact ? fact.value : '';
    }
    return row;
  });

  const columns = ['metric', ...periods.map((p) => `${p.fiscalYear}${p.fiscalQuarter ? `Q${p.fiscalQuarter}` : ''}`)];

  return (
    <button
      type="button"
      onClick={() =>
        downloadFile(
          `tradew-${snapshot.symbol}-${statement}-${snapshot.periodType}-${todayStamp()}.csv`,
          toCsv(rows, columns),
          'text/csv;charset=utf-8',
        )
      }
      className={buttonClasses({ variant: 'outline', size: 'sm' })}
    >
      Download CSV
    </button>
  );
}

/** Overview shows the three most recent periods; Financials shows all of them. */
function trimTo<T extends { periods: unknown[] }>(statement: T, n: number): T {
  return { ...statement, periods: statement.periods.slice(0, n) };
}
