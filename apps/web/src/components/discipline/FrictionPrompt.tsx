'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { buttonClasses, cn } from '@tradew/ui';
import { DisciplineBreachError, frictionBody, frictionHeading, priorAttemptMessage } from '@/lib/discipline';
import { useDisciplineStore } from '@/lib/store/disciplineStore';

/**
 * The friction prompt — shown when an order would cross a limit the trader set.
 *
 * It does not block the order. It costs time and a written reason, and then
 * lets it through. That cost is the feature.
 *
 * The wait and the minimum reason length are enforced in the API
 * (`discipline-limits.ts`: `MIN_DWELL_MS`, `MIN_REASON_LENGTH`, re-checked on
 * every retry against a signed, single-use token). Everything here is a MIRROR
 * of that, driven by the figures in the server's own 409 payload so the two can
 * never drift. Nothing on this screen is the source of truth: if the server
 * refuses a retry anyway, `onConfirm` throws a fresh breach, the prompt
 * replaces itself, and the reason it was refused is shown verbatim rather than
 * being smoothed over.
 *
 * Mounted by whichever surface places orders; it takes the retry as a prop
 * because the prompt has no business knowing what an order is.
 *
 * Observation only — it restates the trader's own limit and their own figures.
 */

/** Client-side padding on the countdown so ordinary request latency cannot
 *  land a retry a few milliseconds inside the server's window and bounce as
 *  `too_fast`. Being slightly stricter than the server is safe; the reverse
 *  would produce a confusing rejection the trader did nothing to earn. */
const LATENCY_MARGIN_MS = 750;

export interface FrictionPromptProps {
  /**
   * Re-place the order carrying the override. Expected to throw
   * `DisciplineBreachError` if the server refuses the retry — the prompt
   * handles that itself.
   */
  onConfirm: (override: { overrideToken: string; overrideReason: string }) => Promise<void>;
}

export function FrictionPrompt({ onConfirm }: FrictionPromptProps) {
  const breach = useDisciplineStore((s) => s.breach);
  const openedAt = useDisciplineStore((s) => s.breachOpenedAt);
  const draft = useDisciplineStore((s) => s.breachDraft);
  const setDraft = useDisciplineStore((s) => s.setBreachDraft);
  const closeBreach = useDisciplineStore((s) => s.closeBreach);
  const openBreach = useDisciplineStore((s) => s.openBreach);
  const refresh = useDisciplineStore((s) => s.refresh);
  const reduce = useReducedMotion();

  const [remainingMs, setRemainingMs] = useState(0);
  const [placing, setPlacing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const dwellMs = breach ? breach.minDwellMs + LATENCY_MARGIN_MS : 0;

  // Re-ticks against `openedAt`, which `openBreach` resets every time a
  // refused retry replaces the prompt — so a new token gets a full new wait.
  useEffect(() => {
    if (!breach || openedAt === null) return;
    const tick = () => setRemainingMs(Math.max(0, openedAt + dwellMs - Date.now()));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [breach, openedAt, dwellMs]);

  // A fresh prompt clears the previous failure banner; the server's own
  // `priorAttempt` takes over as the explanation.
  useEffect(() => setFailure(null), [openedAt]);

  if (!breach) return null;

  const minLength = breach.minReasonLength;
  const reason = draft.trim();
  const waited = remainingMs <= 0;
  const longEnough = reason.length >= minLength;
  const ready = waited && longEnough && !placing;
  const secondsLeft = Math.ceil(remainingMs / 1000);

  async function confirm() {
    if (!ready || !breach) return;
    setPlacing(true);
    setFailure(null);
    try {
      await onConfirm({ overrideToken: breach.overrideToken, overrideReason: draft.trim() });
      closeBreach();
      // The override just moved the counters; make the budget view honest.
      void refresh();
    } catch (err) {
      if (err instanceof DisciplineBreachError) {
        // The server refused this retry and issued a fresh prompt. Replace in
        // place — the draft survives, the wait restarts against the new token.
        openBreach(err);
      } else {
        setFailure(err instanceof Error ? err.message : 'That order could not be placed. Try again.');
      }
    } finally {
      setPlacing(false);
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[115] flex items-end justify-center bg-black/60 sm:items-center"
      >
        <motion.div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="friction-title"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
          transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
          className={cn(
            'flex max-h-[92dvh] w-full flex-col overflow-hidden border border-border bg-card shadow-card',
            'rounded-t-card sm:max-w-md sm:rounded-card',
          )}
        >
          <header className="shrink-0 border-b border-border px-4 pb-3 pt-4">
            <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-border2 sm:hidden" aria-hidden="true" />
            <h2 id="friction-title" className="text-base font-bold text-text">
              {frictionHeading(breach.limitType)}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {frictionBody(breach.limitType, breach.detail)}
            </p>
          </header>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {breach.priorAttempt && (
              <p role="status" className="rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">
                {priorAttemptMessage(breach.priorAttempt)}
              </p>
            )}

            <p className="text-sm font-semibold text-text">You can still place this order.</p>
            <p className="text-xs leading-relaxed text-muted">
              Take a moment first, and write down why you&apos;re going past the limit you set — in your own words, at
              least {minLength} characters. It&apos;s saved, and shown back to you later alongside your other
              overrides.
            </p>

            <div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
                placeholder="Why am I going past this limit?"
                aria-label="Why am I going past this limit?"
                aria-describedby="friction-counter"
                className={cn(
                  'w-full resize-none rounded-lg border border-border2 bg-bg px-3 py-2 text-sm leading-relaxed text-text',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                )}
              />
              <p
                id="friction-counter"
                className={cn('mt-1 text-right text-[11px] tabular-nums', longEnough ? 'text-muted' : 'text-faint')}
              >
                {reason.length}/{minLength} characters
              </p>
            </div>

            {/* Amber rather than red — DESIGN-SYSTEM.md §1 keeps green/red for
                market direction only. A placement failure is not a price move. */}
            {failure && (
              <p role="alert" className="rounded-lg bg-amber-bg px-3 py-2 text-xs text-amber">
                {failure}
              </p>
            )}
          </div>

          <footer
            className="shrink-0 space-y-2 border-t border-border px-4 pt-3"
            style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
          >
            <button
              type="button"
              onClick={confirm}
              disabled={!ready}
              // aria-live so a screen reader hears the countdown finish rather
              // than discovering a silently-enabled button.
              aria-live="polite"
              className={cn(buttonClasses({ variant: 'primary', size: 'md' }), 'w-full disabled:opacity-40')}
            >
              {placing ? 'Placing…' : waited ? 'Place order anyway' : `Wait ${secondsLeft}s`}
            </button>
            <button
              type="button"
              onClick={closeBreach}
              disabled={placing}
              className={cn(buttonClasses({ variant: 'outline', size: 'md' }), 'w-full disabled:opacity-40')}
            >
              Not now — keep my limit
            </button>
          </footer>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
