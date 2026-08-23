'use client';

import { Card } from '@tradew/ui';
import type { OwnershipBreakdown, ResearchSection, SegmentBreakdown } from '@/lib/research/types';
import { asOf, asOfDate, compactMoney, percent } from '@/lib/research/format';
import { DataUnavailable, SourceLine } from './DataUnavailable';

/**
 * Shareholding and business segments.
 *
 * Both are OPTIONAL VENDOR COVERAGE, and both are much more likely to be absent
 * than present. The old page filled the gap with "Promoters 50.13% / FIIs 24.71%
 * / DIIs 15.36%" — static, identical for every company, and the kind of figure a
 * reader would act on. So the absent state here is written to be genuinely
 * informative: it names the configured provider and says what it does not
 * publish, rather than implying the company has no register.
 */

export function OwnershipPanel({ section }: { section: ResearchSection<OwnershipBreakdown> }) {
  if (!section.available) {
    return (
      <Card title="Shareholding">
        <DataUnavailable title="Ownership data unavailable" reason={section.reason} />
      </Card>
    );
  }

  const { categories, topHolders, asOf: measuredAt } = section.data;

  return (
    <Card title="Shareholding" subtitle={`· as of ${asOfDate(measuredAt)}`}>
      {categories.length > 0 && (
        <dl className="divide-y divide-border/60 rounded-lg border border-border">
          {categories.map((c) => (
            <div key={c.holder} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
              <dt className="truncate text-xs text-text">{c.holder}</dt>
              <dd className="shrink-0 font-mono text-xs font-bold tabular-nums text-text">{percent(c.percent)}</dd>
            </div>
          ))}
        </dl>
      )}

      {topHolders.length > 0 && (
        <>
          <h3 className="mb-1.5 mt-3 text-[11px] font-bold uppercase tracking-wide text-muted">Largest holders</h3>
          <dl className="divide-y divide-border/60 rounded-lg border border-border">
            {topHolders.map((h) => (
              <div key={h.holder} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                <dt className="truncate text-xs text-text">{h.holder}</dt>
                <dd className="shrink-0 font-mono text-xs tabular-nums text-muted">
                  {percent(h.percent)}
                  {h.shares !== undefined && (
                    <span className="ml-1.5 text-[10px] text-faint">{h.shares.toLocaleString()} sh</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}

      <SourceLine
        className="mt-2"
        source={section.provenance.source}
        sourceTimestamp={asOf(section.provenance.sourceTimestamp)}
        fetchedAt={asOf(section.provenance.fetchedAt)}
      />
    </Card>
  );
}

export function SegmentsPanel({ section }: { section: ResearchSection<SegmentBreakdown[]> }) {
  if (!section.available) {
    return (
      <Card title="Business & segments">
        <DataUnavailable title="Segment data unavailable" reason={section.reason} />
      </Card>
    );
  }

  return (
    <Card title="Business & segments">
      <div className="space-y-4">
        {section.data.map((seg) => (
          <section key={`${seg.dimension}-${seg.periodEnd}`}>
            <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
              Revenue by {seg.dimension === 'business' ? 'business line' : 'geography'} · {seg.periodEnd}
            </h3>
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wide text-faint">
                  <th scope="col" className="py-1.5 text-left font-semibold">
                    Segment
                  </th>
                  <th scope="col" className="py-1.5 font-semibold">
                    Revenue
                  </th>
                  <th scope="col" className="py-1.5 font-semibold">
                    Operating income
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {seg.rows.map((row) => (
                  <tr key={row.name}>
                    <th scope="row" className="py-1.5 text-left font-normal text-text">
                      {row.name}
                    </th>
                    <td className="py-1.5 font-mono tabular-nums text-muted">
                      {row.revenue !== undefined ? compactMoney(row.revenue, seg.currency) : (
                        <span className="text-[10.5px] italic text-faint">not reported</span>
                      )}
                    </td>
                    <td className="py-1.5 font-mono tabular-nums text-muted">
                      {row.operatingIncome !== undefined ? compactMoney(row.operatingIncome, seg.currency) : (
                        <span className="text-[10.5px] italic text-faint">not reported</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>

      <SourceLine
        className="mt-2"
        source={section.provenance.source}
        sourceTimestamp={asOf(section.provenance.sourceTimestamp)}
        fetchedAt={asOf(section.provenance.fetchedAt)}
      />
    </Card>
  );
}
