'use client';

import { Card, cn } from '@tradew/ui';
import type { RatioGroup, ResearchRatios, ResearchSection } from '@/lib/research/types';
import { asOf, formatRatio } from '@/lib/research/format';
import { DataUnavailable, SourceLine } from './DataUnavailable';

/**
 * Computed ratios, each showing its working.
 *
 * ── WHY THE FORMULA IS ON SCREEN ───────────────────────────────────────────
 *
 * A ratio is a claim about a company. The old page made fourteen such claims
 * with no inputs and no source, and they were false. Every ratio here renders
 * its formula and its operands in a tooltip, so the claim is checkable against
 * the statement table directly above it.
 *
 * ── WHY SKIPPED RATIOS ARE RENDERED AT ALL ─────────────────────────────────
 *
 * Silently omitting a ratio the data cannot support looks identical to that
 * ratio not existing. Showing it greyed with the missing operand named ("P/E —
 * not reported: price, eps") tells the reader the difference between "this
 * company has no P/E" and "we could not compute one", which are not the same
 * fact.
 */

const GROUPS: Array<{ key: RatioGroup; label: string; blurb: string }> = [
  { key: 'valuation', label: 'Valuation', blurb: 'What the market pays for the business today.' },
  { key: 'profitability', label: 'Profitability', blurb: 'What the business earns on what it sells and owns.' },
  { key: 'health', label: 'Financial health', blurb: 'Leverage, liquidity and coverage.' },
  { key: 'growth', label: 'Growth', blurb: 'Change against the prior reporting period of the same length.' },
];

export function RatiosSection({ section }: { section: ResearchSection<ResearchRatios> }) {
  if (!section.available) {
    return (
      <Card title="Ratios">
        <DataUnavailable title="Ratios unavailable" reason={section.reason} />
      </Card>
    );
  }

  const { ratios, skipped, basisPeriodEnd, periodType, currency, marketInputs } = section.data;

  return (
    <Card
      title="Ratios"
      subtitle={
        basisPeriodEnd
          ? `· computed from the ${periodType} statements to ${basisPeriodEnd}`
          : '· computed from the statements above'
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {GROUPS.map((group) => {
          const computed = ratios.filter((r) => r.group === group.key);
          const missing = skipped.filter((s) => s.group === group.key);
          if (computed.length === 0 && missing.length === 0) return null;

          return (
            <section key={group.key} aria-label={group.label}>
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-muted">{group.label}</h3>
              <p className="mb-1.5 text-[10.5px] text-faint">{group.blurb}</p>
              <dl className="divide-y divide-border/60 rounded-lg border border-border">
                {computed.map((r) => (
                  <div
                    key={r.key}
                    className="flex items-baseline justify-between gap-3 px-3 py-1.5"
                    title={`${r.formula}\n${r.inputs.map((i) => `${i.label} = ${i.value.toLocaleString()}`).join('\n')}\nPeriod ending ${r.periodEnd}`}
                  >
                    <dt className="min-w-0 truncate text-xs text-text">
                      {r.label}
                      <span className="ml-1.5 hidden text-[10px] text-faint sm:inline">{r.formula}</span>
                    </dt>
                    <dd
                      className={cn(
                        'shrink-0 font-mono text-xs font-bold tabular-nums',
                        r.unit === 'percent' && r.value < 0 ? 'text-down' : 'text-text',
                      )}
                    >
                      {formatRatio(r.value, r.unit, currency ?? undefined)}
                    </dd>
                  </div>
                ))}
                {missing.map((s) => (
                  <div key={s.key} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                    <dt className="min-w-0 truncate text-xs text-faint">{s.label}</dt>
                    {/* The reason, not a dash. "not reported: price, eps" tells
                        a reader exactly which input is missing. */}
                    <dd className="shrink-0 text-[10.5px] italic text-faint">{s.reason}</dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>

      {marketInputs && (
        <p className="mt-3 text-[10.5px] leading-relaxed text-faint">
          Valuation ratios use a price of{' '}
          {marketInputs.price !== undefined ? (
            <span className="font-mono font-semibold">{marketInputs.price.toFixed(2)}</span>
          ) : (
            'no price'
          )}
          {marketInputs.price !== undefined && currency ? ` ${currency}` : ''}, derived from the provider&apos;s market
          capitalisation ÷ shares outstanding so that price and market cap describe the same instant.{' '}
          {marketInputs.priceAsOf ? `As of ${asOf(marketInputs.priceAsOf)}.` : ''}
        </p>
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
