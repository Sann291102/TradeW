'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn, fadeInUp } from '@tradew/ui';
import { DAY_TYPES, type DayClassification, type DayLabel } from '@/lib/sentinel/deriveContext';
import type { ConfidenceExplanation } from '@/lib/sentinel/types';
import { ChevronDownIcon } from '../shell/icons';
import { ClockIcon } from './sentinel-icons';
import { ShieldHeroArt } from './SentinelArt';

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
export function DayClassificationCard({
  day,
  lastUpdated,
  explanation,
}: {
  day: DayClassification;
  lastUpdated: string;
  /** Master Plan §5 — the full basis for the confidence figure, when the server sent one. */
  explanation?: ConfidenceExplanation;
}) {
  const [legendOpen, setLegendOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const reduce = useReducedMotion();

  return (
    <motion.section
      initial="hidden"
      animate="visible"
      variants={fadeInUp}
      className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-elev3"
    >
      {/* ambient brand wash behind the hero — decorative, token-driven */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_18%,var(--teal-bg),transparent_58%)]"
      />

      <div className="relative grid grid-cols-1 gap-3 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_200px] lg:items-center lg:gap-5">
        <div className="min-w-0">
          <p className="mb-2 text-[10.5px] font-bold uppercase tracking-wideTrack text-faint">Today&rsquo;s Market</p>
          <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
            <h2
              className={cn(
                'inline-flex items-center rounded-lg border px-3 py-1.5 text-[20px] font-extrabold leading-none tracking-tightTrack sm:text-[24px]',
                LABEL_TONE[day.label],
              )}
            >
              {day.label}
            </h2>

            <button
              type="button"
              onClick={() => setLegendOpen((v) => !v)}
              aria-expanded={legendOpen}
              aria-controls="day-type-legend"
              aria-label="See all day types Sentinel can classify"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors duration-micro hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ChevronDownIcon
                className={cn('h-4 w-4 transition-transform duration-micro', legendOpen && 'rotate-180')}
                aria-hidden="true"
              />
            </button>

            <span className="text-[12px] font-semibold text-muted">Confidence</span>
            <span className="rounded-lg border border-teal bg-teal-bg px-2 py-0.5 font-mono text-[12px] font-bold tabular-nums text-teal">
              {(day.confidence * 100).toFixed(0)}%
            </span>

            {explanation && (
              <button
                type="button"
                onClick={() => setWhyOpen((v) => !v)}
                aria-expanded={whyOpen}
                aria-controls="confidence-explainer"
                className="rounded-lg border border-border2 px-2.5 py-1 text-[11px] font-semibold text-muted transition-colors duration-micro hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Why?
              </button>
            )}
          </div>

          <HeroBody
            day={day}
            lastUpdated={lastUpdated}
          />
        </div>

        <ShieldHeroArt className="hidden h-[130px] w-full justify-self-end lg:block" />
      </div>

      {/* Disclosure panels sit full-bleed below the hero grid so they get the
          card's whole width rather than the narrower text column. */}
      <div className="relative px-5 sm:px-6">
        <AnimatePresence initial={false}>
          {whyOpen && explanation && (
            <motion.div
              id="confidence-explainer"
              initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
              className="overflow-hidden"
            >
              <ConfidenceExplainer explanation={explanation} />
            </motion.div>
          )}
        </AnimatePresence>

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
      </div>

      {/* bottom padding, only when neither disclosure is open the grid already
          supplies it — keeps the card from ending flush against a panel */}
      <div className={cn('h-0', (whyOpen || legendOpen) && 'h-4 sm:h-5')} aria-hidden="true" />
    </motion.section>
  );
}

/**
 * The hero's prose column — the classification's reasoning, the signals that
 * support it, and the freshness stamp. Split out only so the header row above
 * stays readable; every value is the same `day`/`lastUpdated` data as before.
 */
function HeroBody({ day, lastUpdated }: { day: DayClassification; lastUpdated: string }) {
  return (
    <>
      <p className="mt-2.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">{day.explanation}</p>

      {day.supportingSignals.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {day.supportingSignals.map((s) => (
            <span
              key={s}
              className="rounded-md border border-border2 bg-bg px-2 py-1 text-[11px] font-medium text-muted"
            >
              {s}
            </span>
          ))}
        </div>
      )}

      <p className="mt-3 flex items-center gap-1.5 text-[10.5px] text-faint">
        <ClockIcon className="h-3.5 w-3.5" />
        Last updated {lastUpdated}
      </p>
    </>
  );
}

/**
 * Confidence Explainability — the "Why?" inspector (SENTINEL_MASTER_PLAN.md §5).
 *
 * Master Plan principle 7: every surfaced observation must let the trader
 * inspect every matching strategy, indicator value, historical precedent,
 * news impact and confidence deduction behind it. This renders exactly what
 * the server computed — the payload is built deterministically from the same
 * factors that produced the score, so nothing here is a restatement or a
 * client-side approximation of the number above it.
 */
function ConfidenceExplainer({ explanation: e }: { explanation: ConfidenceExplanation }) {
  const sections: { title: string; items: string[] }[] = [
    { title: 'Matched strategies', items: e.matchedStrategies },
    { title: 'Confirming indicators', items: e.confirmingIndicators },
    { title: 'Historical precedent', items: [e.historicalPrecedent] },
    { title: 'News & environment', items: [e.newsEnvironment] },
    { title: 'Risk factors', items: e.riskNotes },
    { title: 'Confidence deductions', items: e.deductions },
    { title: 'From the Learning Hub', items: e.learningReferences },
    { title: 'Timing rationale', items: [e.timingRationale] },
  ].filter((s) => s.items.length > 0 && s.items.some(Boolean));

  const factors = Object.entries(e.factorScores);

  return (
    <div className="mt-5 rounded-xl border border-border bg-bg">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-faint">Why this reading</p>
        <p className="font-mono text-[12px] tabular-nums text-muted">
          {e.score}% vs {e.threshold}% threshold ·{' '}
          <span className={e.meetsThreshold ? 'text-up' : 'text-amber'}>{e.meetsThreshold ? 'met' : 'not met'}</span>
        </p>
      </div>

      {factors.length > 0 && (
        <div className="border-b border-border px-4 py-3.5">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Factor breakdown</p>
          <ul className="space-y-2">
            {factors.map(([label, score]) => (
              <li key={label} className="flex items-center gap-3">
                <span className="w-52 shrink-0 text-[12px] text-muted">{label}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover">
                  <span className="block h-full rounded-full bg-teal" style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
                </span>
                <span className="w-12 shrink-0 text-right font-mono text-[11.5px] tabular-nums text-muted">{score}/100</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="divide-y divide-border">
        {sections.map((s) => (
          <div key={s.title} className="px-4 py-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">{s.title}</p>
            <ul className="mt-1.5 space-y-1">
              {s.items.filter(Boolean).map((item, i) => (
                <li key={i} className="max-w-3xl text-[12.5px] leading-snug text-muted">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
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
