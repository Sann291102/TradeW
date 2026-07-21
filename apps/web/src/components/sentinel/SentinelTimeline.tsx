import type { SafetyCardData } from '@/lib/sentinel/deriveContext';

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Chronological session marker list — the quiet closing note on the page,
 *  not a duplicate of the Live Safety Feed above it (no explanation text,
 *  just "something happened at this time" for orientation). */
export function SentinelTimeline({ cards }: { cards: SafetyCardData[] }) {
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
