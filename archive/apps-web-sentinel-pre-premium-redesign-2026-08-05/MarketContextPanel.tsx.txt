import type { MarketContextDimension } from '@/lib/sentinel/deriveContext';

/**
 * "What is the current market context?" (redesign question 2) — the
 * structural read of the market itself, independent of the trader's own
 * behavior (that's the Live Safety Feed's job). Dimensions with no backing
 * signal today (trend/EMA state, institutional participation — neither
 * exists in the current market-data schema) show honestly as "not enough
 * data yet" rather than a guessed value.
 */
export function MarketContextPanel({ tags, dimensions }: { tags: string[]; dimensions: MarketContextDimension[] }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">Current Market Context</h2>

      {tags.length > 0 ? (
        <div className="mb-5 flex flex-wrap gap-2">
          {tags.map((t) => (
            <span key={t} className="rounded-lg bg-teal-bg px-2.5 py-1 text-[12.5px] font-semibold text-teal">
              {t}
            </span>
          ))}
        </div>
      ) : (
        <p className="mb-5 text-[12.5px] text-muted">No active context signals right now.</p>
      )}

      <dl className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {dimensions.map((d) => (
          <div key={d.label} className="flex items-center justify-between rounded-lg bg-bg px-3 py-2.5">
            <dt className="text-[12.5px] text-muted">{d.label}</dt>
            <dd className={`text-[12.5px] font-semibold ${d.known ? 'text-text' : 'text-faint italic'}`}>{d.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
