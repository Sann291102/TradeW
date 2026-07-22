'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn, fadeInUp } from '@tradew/ui';
import { DAY_TYPES, type DayClassification, type DayLabel } from '@/lib/sentinel/deriveContext';
import { ChevronDownIcon } from '../shell/icons';

const LABEL_TONE: Record<DayLabel, string> = {
  'Trend Day': 'text-up border-up bg-up-bg',
  'Selective Day': 'text-teal border-teal bg-teal-bg',
  'Choppy Day': 'text-amber border-amber bg-amber-bg',
  'Trap-Prone Day': 'text-down border-down bg-down-bg',
  'Quiet Day': 'text-muted border-border2 bg-hover',
  // Most severe of the scale. Doubled outline rather than a filled red block:
  // a solid fill needs near-bg-colored text, which only reaches ~3.4:1 against
  // the light theme's red (below AA for text this size). This keeps the vetted
  // text-down/bg-down-bg pairing and still reads as a step beyond Trap-Prone.
  'Sit Out Day': 'text-down border-down bg-down-bg ring-2 ring-inset ring-down',
};

/**
 * The hero card — "what kind of trading day is today?" (redesign question 1).
 * This is the single most important surface on the page: everything below
 * elaborates on this one conclusion, never the reverse.
 */
export function DayClassificationCard({ day, lastUpdated }: { day: DayClassification; lastUpdated: string }) {
  const [legendOpen, setLegendOpen] = useState(false);
  const reduce = useReducedMotion();

  return (
    <motion.section initial="hidden" animate="visible" variants={fadeInUp} className="rounded-2xl border border-border bg-card p-6 shadow-elev3 sm:p-8">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">Today&rsquo;s Market</p>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-3">
        <h1 className={`inline-flex items-center rounded-xl border px-4 py-1.5 text-2xl font-extrabold sm:text-3xl ${LABEL_TONE[day.label]}`}>
          {day.label}
        </h1>

        <button
          type="button"
          onClick={() => setLegendOpen((v) => !v)}
          aria-expanded={legendOpen}
          aria-controls="day-type-legend"
          aria-label="See all day types Sentinel can classify"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors duration-micro hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ChevronDownIcon
            className={cn('h-[18px] w-[18px] transition-transform duration-micro', legendOpen && 'rotate-180')}
            aria-hidden="true"
          />
        </button>

        <span className="font-mono text-sm font-semibold tabular-nums text-muted">Confidence {(day.confidence * 100).toFixed(0)}%</span>
      </div>

      <AnimatePresence initial={false}>
        {legendOpen && (
          <motion.div
            id="day-type-legend"
            initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <DayTypeLegend current={day.label} />
          </motion.div>
        )}
      </AnimatePresence>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">{day.explanation}</p>
      {day.supportingSignals.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {day.supportingSignals.map((s) => (
            <span key={s} className="rounded-full border border-border2 bg-bg px-2.5 py-1 text-[11px] font-medium text-muted">
              {s}
            </span>
          ))}
        </div>
      )}
      <p className="mt-5 text-[11px] text-faint">Last updated {lastUpdated}</p>
    </motion.section>
  );
}

/**
 * The day-classification scale, revealed from the hero card's chevron.
 *
 * A label like "Selective Day" only carries meaning once the trader can see
 * the range it sits within, so this lists every classification Sentinel can
 * reach and marks today's. Descriptions state what conditions look like, not
 * what to do about them (TRADEW-OS.md §1).
 *
 * Expands inline rather than floating: the panel is wide enough that an
 * absolutely-positioned popover clips off-viewport on narrow screens, and
 * the shared Popover has no collision handling. This also matches how
 * SafetyCard's "Why" panel already discloses detail on this page.
 */
function DayTypeLegend({ current }: { current: DayLabel }) {
  return (
    <div className="mt-5 rounded-xl border border-border bg-bg">
      <div className="border-b border-border px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-faint">Day types Sentinel classifies</p>
        <p className="mt-1 text-[12px] leading-snug text-muted">
          Every session is read as one of these. Today&rsquo;s reading is highlighted.
        </p>
      </div>

      <ul className="divide-y divide-border">
        {DAY_TYPES.map((d) => {
          const isCurrent = d.label === current;
          return (
            <li key={d.label} className={cn('px-4 py-3.5', isCurrent && 'bg-hover')}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('inline-flex items-center rounded-lg border px-2.5 py-1 text-[12.5px] font-bold', LABEL_TONE[d.label])}>
                  {d.label}
                </span>
                {isCurrent && (
                  <span className="rounded-full border border-teal px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal">
                    Today
                  </span>
                )}
              </div>
              <p className="mt-2 max-w-2xl text-[12.5px] font-medium leading-snug text-text">{d.summary}</p>
              <p className="mt-1 max-w-2xl text-[12px] leading-snug text-muted">{d.character}</p>
              {d.note && <p className="mt-1.5 max-w-2xl text-[11px] italic leading-snug text-faint">{d.note}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
