'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Card, buttonClasses, cn } from '@tradew/ui';
import { useSessionStore } from '@/lib/store/sessionStore';
import { fetchHoldings, fetchOrders, fetchPositions, fetchTrades } from '@/lib/oms';
import { downloadFile, toCsv, todayStamp } from '@/lib/settings/export';

/**
 * Reports.
 *
 * ── WHAT THIS IS, AND WHAT IT REFUSES TO BE ────────────────────────────────
 *
 * There is no reporting service in TradeW: no report definitions, no
 * generation job, no scheduling, no PDF renderer, no stored artefacts. The
 * brief for this area explicitly warned against inventing one, and a catalogue
 * of report cards that 404 on click would be exactly that.
 *
 * What the account genuinely has is queryable data — orders, fills, positions
 * and holdings, all already read by the Portfolio workspace. So the page
 * exports THOSE, as CSV, built in the browser from the same authenticated
 * endpoints. Every row in a downloaded file is a row the API returned for this
 * account; nothing is synthesised.
 *
 * Everything a real reporting system would add — periods, P&L statements,
 * tax-year summaries, scheduled delivery — is listed below as absent rather
 * than mocked up.
 */

type ExportId = 'orders' | 'trades' | 'positions' | 'holdings';

const EXPORTS: Array<{
  id: ExportId;
  label: string;
  hint: string;
  columns: string[];
  load: () => Promise<Array<Record<string, unknown>>>;
}> = [
  {
    id: 'orders',
    label: 'Order book',
    hint: 'Every order on your paper account: status, product, quantity, price, reject reason.',
    columns: [
      'placedAt', 'symbol', 'side', 'type', 'productType', 'validity', 'status',
      'quantity', 'filledQuantity', 'price', 'triggerPrice', 'avgFillPrice', 'charges', 'rejectReason',
    ],
    load: async () =>
      (await fetchOrders()).map((o) => ({ ...o, symbol: o.symbol ?? o.instrument?.symbol ?? o.instrumentId })),
  },
  {
    id: 'trades',
    label: 'Executed fills',
    hint: 'Each fill, with charges and the realised P&L it produced.',
    columns: ['executedAt', 'symbol', 'side', 'quantity', 'fillPrice', 'charges', 'realizedPnl', 'orderId'],
    load: async () =>
      (await fetchTrades()).map((t) => ({ ...t, symbol: t.instrument?.symbol ?? t.instrumentId })),
  },
  {
    id: 'positions',
    label: 'Open positions',
    hint: 'Current positions with average price, mark and unrealised P&L.',
    columns: [
      'symbol', 'productType', 'quantity', 'avgPrice', 'currentPrice',
      'unrealizedPnl', 'realizedPnl', 'dailyPnl', 'positionValue', 'marginUsed', 'positionStatus',
    ],
    load: async () => fetchPositions() as Promise<unknown[]> as Promise<Array<Record<string, unknown>>>,
  },
  {
    id: 'holdings',
    label: 'Holdings',
    hint: 'Settled holdings with cost, value and overall P&L.',
    columns: ['symbol', 'quantity', 'avgCost', 'ltp', 'investedValue', 'currentValue', 'overallPnl', 'overallPnlPct'],
    load: async () => fetchHoldings() as Promise<unknown[]> as Promise<Array<Record<string, unknown>>>,
  },
];

const NOT_BUILT = [
  'Period P&L statements (daily, monthly, financial year)',
  'Tax-ready capital-gains summaries',
  'Scheduled reports delivered by email',
  'PDF rendering and stored, re-downloadable artefacts',
  'Research reports and AI Sentinel session reports',
];

export function ReportsClient() {
  const signedIn = useSessionStore((s) => s.status === 'authenticated');
  const [busy, setBusy] = useState<ExportId | null>(null);
  const [result, setResult] = useState<{ id: ExportId; ok: boolean; text: string } | null>(null);

  async function run(entry: (typeof EXPORTS)[number]) {
    setBusy(entry.id);
    setResult(null);
    try {
      const rows = await entry.load();
      if (rows.length === 0) {
        // Not an error, and NOT a downloaded empty file pretending to be a
        // report: say there is nothing to export and stop.
        setResult({ id: entry.id, ok: false, text: 'Nothing to export — this list is empty on your account.' });
        return;
      }
      downloadFile(
        `tradew-${entry.id}-${todayStamp()}.csv`,
        toCsv(rows, entry.columns),
        'text/csv;charset=utf-8',
      );
      setResult({ id: entry.id, ok: true, text: `Exported ${rows.length} row${rows.length === 1 ? '' : 's'}.` });
    } catch (err) {
      setResult({ id: entry.id, ok: false, text: err instanceof Error ? err.message : 'Export failed.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-[1000px] space-y-4 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold text-text">Reports</h1>
        <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">PARTIAL</Badge>
      </header>
      <p className="max-w-2xl text-sm text-muted">
        Export your account&apos;s real records. Each file is built from the same authenticated
        endpoints the Portfolio workspace reads — no sample rows, no placeholder totals.
      </p>

      {!signedIn ? (
        <Card>
          <p className="text-sm text-muted">
            Sign in to export your account data. There is nothing to report on for a signed-out
            visitor.
          </p>
        </Card>
      ) : (
        <Card title="Export account data" subtitle="· CSV">
          <ul className="grid gap-2 sm:grid-cols-2">
            {EXPORTS.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-border p-3">
                <div className="text-xs font-bold text-text">{entry.label}</div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{entry.hint}</p>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run(entry)}
                  className={cn('mt-2', buttonClasses({ variant: 'outline', size: 'sm' }))}
                >
                  {busy === entry.id ? 'Exporting…' : 'Download CSV'}
                </button>
                {result?.id === entry.id && (
                  <p className={cn('mt-1.5 text-[11px] font-medium', result.ok ? 'text-up' : 'text-amber')}>
                    {result.text}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Not built yet" className="border-amber bg-amber-bg">
        <p className="text-xs text-muted">
          A reporting system would generate, store and re-serve documents. TradeW has no such
          service — no report definitions, no generation job, no stored artefacts. These are absent,
          not hidden:
        </p>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {NOT_BUILT.map((item) => (
            <li key={item} className="flex items-start gap-2 text-xs text-muted">
              <span aria-hidden="true" className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-border2" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </Card>

      <p className="text-[11px] text-faint">
        Looking for performance figures rather than raw rows?{' '}
        <Link href="/portfolio" className="text-teal hover:underline">
          Portfolio → Performance
        </Link>{' '}
        computes them server-side from the same account.
      </p>
    </div>
  );
}
