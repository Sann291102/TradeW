'use client';

import { Badge, Card, Surface, cn } from '@tradew/ui';
import type { ResearchOverview, ResearchSection } from '@/lib/research/types';
import { asOf, compactMoney, percent, ratio } from '@/lib/research/format';
import { DataUnavailable, NotReported, SourceLine } from './DataUnavailable';

/**
 * The company header.
 *
 * ── WHY EVERY FIELD IS INDIVIDUALLY GUARDED ────────────────────────────────
 *
 * The old header printed a market cap beside a Key Metrics card printing a
 * DIFFERENT market cap, because both were constants nobody reconciled. Here
 * there is one source for each figure and each is rendered only if present — so
 * a contradiction of that kind cannot be constructed, and a field the vendor
 * omitted says "not reported" instead of borrowing a neighbour's number.
 *
 * Price is derived from market cap ÷ shares outstanding on the server, so the
 * price and the market cap beside it are the SAME point in time. Pairing a live
 * tick with a vendor market cap would put two mutually inconsistent valuations
 * on one line.
 */
export function CompanyHeader({ overview }: { overview: ResearchSection<ResearchOverview> }) {
  if (!overview.available) {
    return (
      <DataUnavailable
        title="Company information unavailable"
        reason={overview.reason}
      />
    );
  }

  const { profile, statistics } = overview.data;
  const currency = statistics.currency || profile.currency;

  return (
    <Surface elevation={2} className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold text-text">{profile.name}</h1>
            <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
              {profile.symbol} · {profile.exchange}
            </Badge>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
            {profile.sector ? <span>{profile.sector}</span> : <NotReported title="Sector not published" />}
            {profile.industry && (
              <>
                <span aria-hidden="true" className="text-faint">
                  ·
                </span>
                <span>{profile.industry}</span>
              </>
            )}
            {profile.country && (
              <>
                <span aria-hidden="true" className="text-faint">
                  ·
                </span>
                <span>{profile.country}</span>
              </>
            )}
          </p>
        </div>

        <dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-2 text-right sm:grid-cols-3">
          <Metric label="Market cap" value={statistics.marketCap} currency={currency} />
          <Metric label="Enterprise value" value={statistics.enterpriseValue} currency={currency} />
          <Metric label="Shares outstanding" value={statistics.sharesOutstanding} currency={currency} />
        </dl>
      </div>

      <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-4">
        <RangeCell
          label="52-week range"
          low={statistics.fiftyTwoWeekLow}
          high={statistics.fiftyTwoWeekHigh}
          currency={currency}
        />
        <PlainCell label="Beta" value={statistics.beta !== undefined ? ratio(statistics.beta) : null} />
        <PlainCell
          label="Dividend yield"
          value={statistics.dividendYield !== undefined ? percent(statistics.dividendYield) : null}
        />
        <PlainCell
          label={`P/E (${statistics.provenance.source})`}
          value={statistics.vendorTrailingPe !== undefined ? `${statistics.vendorTrailingPe.toFixed(2)}×` : null}
          hint="As published by the data provider. TradeW's own P/E, computed from the statements below, is in the Ratios section."
        />
      </div>

      <div className="border-t border-border px-5 py-2">
        <SourceLine
          source={profile.provenance.source}
          sourceTimestamp={asOf(profile.provenance.sourceTimestamp)}
          fetchedAt={asOf(profile.provenance.fetchedAt)}
        />
        {profile.description && (
          <p className="mt-2 max-w-3xl text-[11.5px] leading-relaxed text-muted">{profile.description}</p>
        )}
      </div>
    </Surface>
  );
}

function Metric({ label, value, currency }: { label: string; value: number | undefined; currency: string }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</dt>
      <dd className="font-mono text-sm font-bold tabular-nums text-text">
        {value !== undefined ? compactMoney(value, currency) : <NotReported />}
      </dd>
    </div>
  );
}

function RangeCell({
  label,
  low,
  high,
  currency,
}: {
  label: string;
  low: number | undefined;
  high: number | undefined;
  currency: string;
}) {
  return (
    <div className="bg-card px-4 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</div>
      <div className="font-mono text-xs font-bold tabular-nums text-text">
        {/* Both halves or neither — half a range is not a range. */}
        {low !== undefined && high !== undefined ? (
          `${compactMoney(low, currency)} – ${compactMoney(high, currency)}`
        ) : (
          <NotReported />
        )}
      </div>
    </div>
  );
}

function PlainCell({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <div className="bg-card px-4 py-2.5" title={hint}>
      <div className={cn('text-[10px] font-semibold uppercase tracking-wide text-faint')}>{label}</div>
      <div className="font-mono text-xs font-bold tabular-nums text-text">{value ?? <NotReported />}</div>
    </div>
  );
}
