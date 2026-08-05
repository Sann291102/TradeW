'use client';

import { useMemo, useState } from 'react';
import { cn } from '@tradew/ui';
import type { SafetyCardData } from '@/lib/sentinel/deriveContext';
import type { TimelineEntry, TimelineLevel } from '@/lib/sentinel/types';
import { DownloadIcon, FilterIcon } from './sentinel-icons';

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

const LEVELS: TimelineLevel[] = ['info', 'observation', 'setup', 'guidance', 'transition'];

const LEVEL_LABEL: Record<TimelineLevel, string> = {
  info: 'Info',
  observation: 'Observation',
  setup: 'Setup',
  guidance: 'Guidance',
  transition: 'Transition',
};

/** Dot colour per level — the same severity ordering the old left border carried. */
const LEVEL_DOT: Record<TimelineLevel, string> = {
  info: 'bg-faint',
  observation: 'bg-muted',
  setup: 'bg-teal',
  guidance: 'bg-up',
  transition: 'bg-amber',
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
 *
 * The filter and export controls are presentation-only and operate purely on
 * the `entries` already in the client — neither refetches, and export writes
 * exactly the rows on screen, so a filtered export never claims to be the
 * whole session.
 */
export function SentinelTimeline({ cards, entries }: { cards: SafetyCardData[]; entries?: TimelineEntry[] }) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [hidden, setHidden] = useState<TimelineLevel[]>([]);

  // Memoised so the `?? []` fallback doesn't produce a fresh array identity on
  // every render and re-run the two derivations below for nothing.
  const all = useMemo(() => entries ?? [], [entries]);
  const visible = useMemo(() => all.filter((e) => !hidden.includes(e.level)), [all, hidden]);

  // Which levels the session actually produced — filtering on a level that
  // never occurs is noise, so only real ones get a chip.
  const presentLevels = useMemo(() => LEVELS.filter((l) => all.some((e) => e.level === l)), [all]);

  function toggleLevel(level: TimelineLevel) {
    setHidden((h) => (h.includes(level) ? h.filter((l) => l !== level) : [...h, level]));
  }

  function exportCsv() {
    const rows = [
      ['at', 'time', 'level', 'event', 'confidence'],
      ...visible.map((e) => [
        e.at,
        e.time,
        e.level,
        e.event,
        e.confidence !== undefined ? e.confidence.toFixed(0) : '',
      ]),
    ];
    const csv = rows
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `sentinel-session-timeline-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (all.length > 0) {
    return (
      <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2 sm:p-6">
        <div className="mb-3.5 flex items-center justify-between gap-3">
          <h2 className="text-[11px] font-bold uppercase tracking-wideTrack text-faint">Session Timeline</h2>
          <div className="flex items-center gap-1.5">
            <IconButton
              label={filterOpen ? 'Hide timeline filters' : 'Filter timeline by level'}
              active={filterOpen || hidden.length > 0}
              onClick={() => setFilterOpen((v) => !v)}
            >
              <FilterIcon className="h-4 w-4" />
            </IconButton>
            <IconButton label="Export the timeline shown as CSV" onClick={exportCsv}>
              <DownloadIcon className="h-4 w-4" />
            </IconButton>
          </div>
        </div>

        {filterOpen && presentLevels.length > 1 && (
          <div className="mb-3.5 flex flex-wrap gap-1.5 rounded-xl border border-border bg-bg p-2.5">
            {presentLevels.map((l) => {
              const on = !hidden.includes(l);
              return (
                <button
                  key={l}
                  type="button"
                  onClick={() => toggleLevel(l)}
                  aria-pressed={on}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors duration-micro',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    on ? 'border-teal bg-teal-bg text-teal' : 'border-border2 bg-card text-faint hover:text-muted',
                  )}
                >
                  {LEVEL_LABEL[l]}
                </button>
              );
            })}
          </div>
        )}

        {visible.length === 0 ? (
          <p className="text-[12.5px] text-muted">Every level is filtered out — turn one back on to see the session.</p>
        ) : (
          <ol className="relative space-y-3 pl-5">
            {/* the rail itself */}
            <span aria-hidden="true" className="absolute bottom-1.5 left-[3.5px] top-1.5 w-px bg-border" />
            {visible.map((e, i) => (
              <li key={`${e.at}-${i}`} className="relative">
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute -left-5 top-[5px] h-2 w-2 rounded-full ring-2 ring-card',
                    LEVEL_DOT[e.level],
                  )}
                />
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <span className="font-mono text-[11.5px] tabular-nums text-faint">{e.time}</span>
                  <span className="text-[12.5px] leading-snug text-text">{e.event}</span>
                  {e.confidence !== undefined && (
                    <span className="font-mono text-[11px] font-semibold tabular-nums text-muted">
                      {e.confidence.toFixed(0)}%
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    );
  }

  const stamps = cards.map((c) => formatTime(c.timestamp)).filter((t): t is string => t !== null);
  if (stamps.length === 0) return null;

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2 sm:p-6">
      <h2 className="mb-3 text-[11px] font-bold uppercase tracking-wideTrack text-faint">Timeline</h2>
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

function IconButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-lg border transition-colors duration-micro',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
        active ? 'border-teal bg-teal-bg text-teal' : 'border-border2 bg-bg text-muted hover:bg-hover hover:text-text',
      )}
    >
      {children}
    </button>
  );
}
