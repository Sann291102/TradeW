'use client';

import { contextRows } from '@/lib/sentinel/strategyContract';
import type { ObservedContext } from '@/lib/sentinel/strategyContract';

/**
 * Observed context: what the last readable sweep actually measured.
 *
 * Rendered generically from whatever the evaluator recorded. This component
 * has no idea what a pullback, a VWAP deviation or a liquidity stage is — it
 * walks the keys it was given. That is precisely why a new evaluator needs no
 * frontend change to become visible here.
 */

export function ObservedContextPanel({ observation }: { observation: ObservedContext | null }) {
  const rows = contextRows(observation);
  if (rows.length === 0) return null;

  return (
    <section data-testid="observed-context">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
        Observed context
      </h3>
      <dl className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4">
            <dt className="text-xs text-muted">{row.label}</dt>
            <dd className="text-xs tabular-nums text-fg">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
