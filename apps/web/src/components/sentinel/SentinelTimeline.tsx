import type { SafetyCardData } from '@/lib/sentinel/deriveContext';
import type { TimelineEntry, TimelineLevel } from '@/lib/sentinel/types';

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

const LEVEL_TONE: Record<TimelineLevel, string> = {
  info: 'border-border2',
  observation: 'border-border2',
  setup: 'border-teal',
  guidance: 'border-up',
  transition: 'border-amber',
};

/**
 * The session narrative (SENTINEL_MASTER_PLAN.md §4 Module 8).
 *
 * This used to render bare timestamps derived from safety cards, because the
 * backend had no session narrative to show — only a set of point-in-time
 * observations. The Market Timeline Engine now keeps one continuous, deduped
 * record of the session, so when the response carries it this renders the
 * real thing: what happened, when, and at what confidence.
 *
 * The timestamp strip is kept as the fallback for demo mode and for responses
 * that predate the timeline, so the component has one job with two data
 * sources rather than two components competing for the same slot.
 */
export function SentinelTimeline({ cards, entries }: { cards: SafetyCardData[]; entries?: TimelineEntry[] }) {
  if (entries && entries.length > 0) {
    return (
      <section className="pb-2">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">Session timeline</h2>
        <ol className="space-y-0">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className={`border-l-2 pl-3.5 pb-3 ${LEVEL_TONE[e.level]}`}>
              <div className="flex flex-wrap items-baseline gap-x-2.5">
                <span className="font-mono text-[12px] tabular-nums text-faint">{e.time}</span>
                <span className="text-[12.5px] leading-snug text-text">{e.event}</span>
                {e.confidence !== undefined && (
                  <span className="font-mono text-[11px] tabular-nums text-muted">{e.confidence.toFixed(0)}%</span>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  const stamps = cards.map((c) => formatTime(c.timestamp)).filter((t): t is string => t !== null);
  if (stamps.length === 0) return null;

  return (
    <section className="pb-2">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">Timeline</h2>
      <ol className="flex flex-wrap gap-2">
        {stamps.map((t, i) => (
          <li key={i} className="font-mono text-[12px] tabular-nums text-faint">
            {t}
            {i < stamps.length - 1 && <span className="ml-2 text-border2">·</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
