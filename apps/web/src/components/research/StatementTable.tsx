'use client';

import { Fragment, useState } from 'react';
import { Badge, cn } from '@tradew/ui';
import { linesFor, type StatementLineSpec } from '@tradew/market-data';
import type { FinancialStatement, StatementType } from '@/lib/research/types';
import { defaultScale, periodLabel, scaledAccountingValue, scalesFor } from '@/lib/research/format';
import { NotReported } from './DataUnavailable';

/**
 * Rows that are already per-share or a share count, and must never be scaled.
 * Dividing an EPS of 18.28 by a crore yields 0.0000018 — a true number and a
 * useless one.
 */
const UNSCALED_METRICS = new Set([
  'eps_basic',
  'eps_diluted',
  'basic_shares_outstanding',
  'diluted_shares_outstanding',
]);

/**
 * A financial statement, laid out the way a research terminal lays one out.
 *
 * ── LAYOUT DECISIONS, AND WHY ──────────────────────────────────────────────
 *
 * · The metric column is STICKY. A balance sheet is 25 rows by 8 periods; a
 *   reader scrolling right to FY2022 must not lose which line they are on.
 * · Periods run newest-first, left to right, with the latest column tinted.
 *   That is the reading order of every filing summary and every terminal.
 * · Negatives are parenthesised, not prefixed with a minus. Accounting
 *   convention, and a minus at 11px is genuinely easy to miss on a line where
 *   the sign is the whole meaning.
 * · Numbers are tabular-nums and right-aligned so digits line up vertically and
 *   a magnitude error is visible as a ragged column.
 * · Sections collapse. The full line list is the point of the page, but a reader
 *   comparing gross margin across five years does not want to scroll past
 *   twelve balance-sheet asset lines to do it.
 *
 * ── THE RULE THIS COMPONENT ENFORCES ───────────────────────────────────────
 *
 * A cell renders a number ONLY when `period.facts[metric]` exists. There is no
 * `?? 0`, no `|| '—'` and no default. A line the vendor did not publish renders
 * `not reported`, and a line no period published at all is dropped from the
 * table entirely rather than shown as an empty row that reads like a zero.
 */
export function StatementTable({
  statement,
  type,
}: {
  statement: FinancialStatement;
  type: StatementType;
}) {
  const specs = linesFor(type) as StatementLineSpec[];
  const periods = statement.periods;

  // A line no period reports is not a line this company files. Showing it empty
  // across eight columns implies eight zeros.
  const visible = specs.filter((spec) => periods.some((p) => p.facts[spec.metric] !== undefined));

  const currency = periods[0]?.currency ?? 'INR';
  const scaleOptions = scalesFor(currency);
  // The largest SCALABLE magnitude on the table decides the default unit — a
  // per-share figure must not drag a statement of billions down to "full".
  const magnitude = Math.max(
    0,
    ...periods.flatMap((p) =>
      Object.values(p.facts)
        .filter((f) => !UNSCALED_METRICS.has(f.metric))
        .map((f) => Math.abs(f.value)),
    ),
  );
  const [scaleKey, setScaleKey] = useState(() => defaultScale(currency, magnitude).key);
  const scale = scaleOptions.find((s) => s.key === scaleKey) ?? scaleOptions[0]!;

  const sections = groupBySection(visible);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (name: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  if (visible.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-xs text-faint">
        The provider returned this statement but none of its standard line items, so there is nothing
        to tabulate.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10.5px] text-faint">
          Figures in <span className="font-semibold text-muted">{currency}{scale.suffix ? ` ${scale.suffix}` : ''}</span>
          {scale.divisor !== 1 && ' · per-share figures and share counts are unscaled'}
        </p>
        <div role="group" aria-label="Display units" className="flex items-center rounded-lg border border-border2 p-0.5">
          {scaleOptions.map((opt) => (
            <button
              key={opt.key}
              type="button"
              aria-pressed={scale.key === opt.key}
              onClick={() => setScaleKey(opt.key)}
              className={cn(
                'rounded-md px-2 py-0.5 text-[10.5px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                scale.key === opt.key ? 'bg-teal-bg text-teal' : 'text-muted hover:text-text',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-right text-xs">
        <caption className="sr-only">
          {type === 'income' ? 'Income statement' : type === 'balance' ? 'Balance sheet' : 'Cash flow statement'} for{' '}
          {statement.symbol}
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th
              scope="col"
              className="sticky left-0 z-10 bg-card px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-faint"
            >
              metric
            </th>
            {periods.map((p, i) => (
              <th
                key={p.periodEnd}
                scope="col"
                className={cn(
                  'whitespace-nowrap px-3 py-2 text-[11px] font-bold',
                  i === 0 ? 'text-teal' : 'text-muted',
                )}
              >
                {periodLabel(p)}
                <span className="block text-[9.5px] font-normal text-faint">to {p.periodEnd}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.map(({ name, lines }) => {
            const isCollapsed = name !== null && collapsed.has(name);
            return (
              // Keyed Fragment: a bare <> in a .map() has no key, which React
              // warns about and which breaks reconciliation when a section is
              // collapsed or the statement is switched.
              <Fragment key={name ?? `group-${lines[0]?.metric ?? 'first'}`}>
                {name && (
                  <tr className="border-b border-border/60 bg-hover/40">
                    <th
                      scope="colgroup"
                      colSpan={periods.length + 1}
                      className="sticky left-0 px-2 py-1.5 text-left"
                    >
                      <button
                        type="button"
                        onClick={() => toggle(name)}
                        aria-expanded={!isCollapsed}
                        className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wide text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        <span aria-hidden="true" className={cn('transition-transform', isCollapsed && '-rotate-90')}>
                          ▾
                        </span>
                        {name}
                      </button>
                    </th>
                  </tr>
                )}
                {!isCollapsed &&
                  lines.map((spec) => (
                    <tr key={spec.metric} className="border-b border-border/40 last:border-0 hover:bg-hover/40">
                      <th
                        scope="row"
                        className={cn(
                          'sticky left-0 z-10 max-w-[240px] truncate bg-card px-2 py-1.5 text-left font-normal',
                          spec.indent && 'pl-5',
                          spec.total ? 'font-bold text-text' : 'text-muted',
                        )}
                      >
                        {spec.label}
                      </th>
                      {periods.map((p, i) => {
                        const fact = p.facts[spec.metric];
                        return (
                          <td
                            key={p.periodEnd}
                            className={cn(
                              'whitespace-nowrap px-3 py-1.5 font-mono tabular-nums',
                              spec.total && 'font-bold',
                              i === 0 ? 'bg-teal-bg/30 text-text' : 'text-muted',
                              fact && fact.value < 0 && 'text-down',
                            )}
                          >
                            {fact ? (
                              <span
                                title={
                                  fact.basis === 'derived'
                                    ? 'Derived by TradeW from other reported lines — not a figure the filing states directly.'
                                    : `Reported by ${fact.provenance.source}`
                                }
                              >
                                {scaledAccountingValue(
                                  fact.value,
                                  fact.currency,
                                  scale,
                                  !UNSCALED_METRICS.has(spec.metric),
                                )}
                                {fact.basis === 'derived' && (
                                  <sup className="ml-0.5 text-[8px] font-bold text-amber" aria-label="derived">
                                    d
                                  </sup>
                                )}
                              </span>
                            ) : (
                              <NotReported />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      </div>

      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10.5px] text-faint">
        <span>Negatives in parentheses.</span>
        <span className="flex items-center gap-1">
          <Badge tone="warning" className="px-1 py-0 text-[8px]">
            d
          </Badge>
          derived by TradeW, not stated in the filing
        </span>
        <span className="italic">&ldquo;not reported&rdquo; means the provider published no value for that period.</span>
      </p>
    </div>
  );
}

/** Keep spec order; open a new group whenever a line declares a section. */
function groupBySection(lines: StatementLineSpec[]): Array<{ name: string | null; lines: StatementLineSpec[] }> {
  const out: Array<{ name: string | null; lines: StatementLineSpec[] }> = [];
  for (const line of lines) {
    if (line.section || out.length === 0) {
      out.push({ name: line.section ?? null, lines: [line] });
    } else {
      out[out.length - 1]!.lines.push(line);
    }
  }
  return out;
}
