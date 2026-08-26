'use client';

import { Badge, Card } from '@tradew/ui';
import type { ResearchSnapshot } from '@/lib/research/types';
import { asOf, percent, ratio } from '@/lib/research/format';
import { DataUnavailable } from './DataUnavailable';

export function SignalsPanel({ snapshot }: { snapshot: ResearchSnapshot }) {
  if (!snapshot.ratios.available) {
    return <DataUnavailable title="Signals unavailable" reason={`Signals require ratio inputs that are currently unavailable (${snapshot.ratios.reason}).`} />;
  }

  const lookup = new Map(snapshot.ratios.data.ratios.map((ratioItem) => [ratioItem.key, ratioItem.value]));
  const reasons: string[] = [];
  const risks: string[] = [];
  const invalidation: string[] = [];
  let bullish = 0;
  let bearish = 0;

  const revenueGrowth = lookup.get('revenue_growth');
  if (revenueGrowth !== undefined) {
    if (revenueGrowth > 8) {
      bullish += 1;
      reasons.push(`Revenue growth is positive at ${percent(revenueGrowth)}.`);
    } else if (revenueGrowth < 0) {
      bearish += 1;
      reasons.push(`Revenue growth is negative at ${percent(revenueGrowth)}.`);
      invalidation.push('Growth needs to stabilize for a bullish thesis.');
    }
  }

  const netMargin = lookup.get('net_margin');
  if (netMargin !== undefined) {
    if (netMargin > 10) {
      bullish += 1;
      reasons.push(`Net margin is healthy at ${percent(netMargin)}.`);
    } else if (netMargin < 5) {
      bearish += 1;
      risks.push(`Net margin is thin at ${percent(netMargin)}.`);
    }
  }

  const roe = lookup.get('roe');
  if (roe !== undefined) {
    if (roe > 12) bullish += 1;
    else if (roe < 8) bearish += 1;
  }

  const debtEquity = lookup.get('debt_equity');
  if (debtEquity !== undefined && debtEquity > 1.5) {
    bearish += 1;
    risks.push(`Debt/equity is elevated at ${ratio(debtEquity)}.`);
    invalidation.push('Leverage needs to improve materially.');
  }

  const signal = bullish > bearish ? 'Constructive bias' : bearish > bullish ? 'Caution bias' : 'Balanced bias';
  const direction = bullish > bearish ? 'bullish' : bearish > bullish ? 'bearish' : 'neutral';
  const confidence = Math.abs(bullish - bearish) >= 2 ? 'medium' : 'low';

  if (reasons.length === 0) {
    return (
      <DataUnavailable
        title="Signals unavailable"
        reason="The available research data did not provide enough grounded inputs to produce a research signal without inventing assumptions."
      />
    );
  }

  return (
    <Card title="Signals / trade ideas" subtitle="· deterministic, evidence-backed and non-guaranteed">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={direction === 'bullish' ? 'positive' : direction === 'bearish' ? 'negative' : 'neutral'}>{signal}</Badge>
          <Badge tone="neutral">{direction}</Badge>
          <Badge tone="neutral">{confidence} confidence</Badge>
          <span className="text-[10.5px] text-faint">Generated {asOf(new Date().toISOString())}</span>
        </div>

        <section>
          <h3 className="text-[11px] font-bold uppercase tracking-wide text-teal">Supporting evidence</h3>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-muted">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="text-[11px] font-bold uppercase tracking-wide text-teal">Risk factors</h3>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-muted">
            {(risks.length > 0 ? risks : ['No major ratio-derived risk factors were triggered, but absence of a flag is not a guarantee.']).map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="text-[11px] font-bold uppercase tracking-wide text-teal">Invalidation conditions</h3>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-muted">
            {(invalidation.length > 0
              ? invalidation
              : ['A materially weaker growth profile or deteriorating margins would invalidate this constructive read.']).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <p className="text-[10.5px] leading-relaxed text-faint">
          This is a rules-based research signal derived from the financial data on this page. It is not a forecast, not an execution instruction, and not investment advice.
        </p>
      </div>
    </Card>
  );
}
