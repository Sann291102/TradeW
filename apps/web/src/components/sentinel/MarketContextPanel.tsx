import { cn } from '@tradew/ui';
import type { MarketContextDimension } from '@/lib/sentinel/deriveContext';
import { dimensionIcon } from './sentinel-icons';

/**
 * "What is the current market context?" (redesign question 2) — the
 * structural read of the market itself, independent of the trader's own
 * behavior (that's the Live Safety Feed's job). Dimensions with no backing
 * signal today (trend/EMA state, institutional participation — neither
 * exists in the current market-data schema) show honestly as "not enough
 * data yet" rather than a guessed value.
 *
 * Presentation note: an unknown dimension is given a double-width tile. Its
 * honest "not enough data yet" copy is the longest string in the grid, and
 * the reference layout gives it the room — cramming it into a quarter-width
 * tile is what pushes a designer toward shortening it into something vaguer.
 */
export function MarketContextPanel({ tags, dimensions }: { tags: string[]; dimensions: MarketContextDimension[] }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
        <h2 className="text-[11px] font-bold uppercase tracking-wideTrack text-faint">Current Market Context</h2>

        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {tags.map((t) => (
              <span key={t} className="rounded-lg bg-teal-bg px-2.5 py-1 text-[11.5px] font-semibold text-teal">
                {t}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-[12px] text-muted">No active context signals right now.</span>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {dimensions.map((d) => {
          const Icon = dimensionIcon(d.label);
          return (
            <div
              key={d.label}
              className={cn(
                'flex items-center gap-3 rounded-xl border border-border bg-bg px-3.5 py-3',
                !d.known && 'sm:col-span-2',
              )}
            >
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  d.known ? 'bg-teal-bg text-teal' : 'bg-hover text-faint',
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0">
                <dt className="text-[11.5px] leading-tight text-muted">{d.label}</dt>
                <dd
                  className={cn(
                    'mt-0.5 text-[13px] font-bold leading-snug',
                    d.known ? 'text-text' : 'text-faint italic font-medium',
                  )}
                >
                  {d.value}
                </dd>
              </div>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
