'use client';

import { motion } from 'framer-motion';
import { fadeInUp } from '@tradew/ui';
import type { DayClassification } from '@/lib/sentinel/deriveContext';

const LABEL_TONE: Record<DayClassification['label'], string> = {
  'Trend Day': 'text-up border-up bg-up-bg',
  'Selective Day': 'text-teal border-teal bg-teal-bg',
  'Choppy Day': 'text-amber border-amber bg-amber-bg',
  'Trap-Prone Day': 'text-down border-down bg-down-bg',
  'Quiet Day': 'text-muted border-border2 bg-hover',
};

/**
 * The hero card — "what kind of trading day is today?" (redesign question 1).
 * This is the single most important surface on the page: everything below
 * elaborates on this one conclusion, never the reverse.
 */
export function DayClassificationCard({ day, lastUpdated }: { day: DayClassification; lastUpdated: string }) {
  return (
    <motion.section initial="hidden" animate="visible" variants={fadeInUp} className="rounded-2xl border border-border bg-card p-6 shadow-elev3 sm:p-8">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">Today&rsquo;s Market</p>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className={`inline-flex items-center rounded-xl border px-4 py-1.5 text-2xl font-extrabold sm:text-3xl ${LABEL_TONE[day.label]}`}>
          {day.label}
        </h1>
        <span className="font-mono text-sm font-semibold tabular-nums text-muted">Confidence {(day.confidence * 100).toFixed(0)}%</span>
      </div>
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
