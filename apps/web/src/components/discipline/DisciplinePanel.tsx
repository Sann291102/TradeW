'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { buttonClasses, cn } from '@tradew/ui';
import { useDisciplineStore } from '@/lib/store/disciplineStore';

/**
 * The discipline panel — first app open of a trading day, before the dashboard.
 *
 * Blocking by construction: no backdrop click, no Esc, no close control, and
 * the submit stays disabled until all three required limits are set. The
 * optional profit target never gates it.
 *
 * Whether it appears at all is decided by the server (`GET /discipline/today`),
 * never by a client flag — see `disciplineStore`. Backgrounding and reopening
 * the app inside the same trading day resolves to `session_exists` and the
 * panel stays down.
 *
 * Mobile-first: a bottom sheet on a phone, a centred dialog from `sm` up. Sized
 * in `dvh` rather than `vh` so the iOS URL bar collapsing does not clip the
 * submit, and padded against the home indicator with `safe-area-inset-bottom`.
 *
 * Observation only — nothing here reads market data or mentions an instrument.
 */

const MINUTE_PRESETS = [
  { label: '30m', value: 30 },
  { label: '1h', value: 60 },
  { label: '2h', value: 120 },
  { label: '4h', value: 240 },
];
const TRADE_PRESETS = [3, 5, 10, 20];
const LOSS_PRESETS = [1000, 2500, 5000, 10000];

export function DisciplinePanel() {
  const gate = useDisciplineStore((s) => s.gate());
  const submit = useDisciplineStore((s) => s.submit);
  const submitting = useDisciplineStore((s) => s.submitting);
  const submitError = useDisciplineStore((s) => s.submitError);
  const reduce = useReducedMotion();

  const [maxMinutes, setMaxMinutes] = useState<number | ''>('');
  const [maxTrades, setMaxTrades] = useState<number | ''>('');
  const [maxLoss, setMaxLoss] = useState<number | ''>('');
  const [targetProfit, setTargetProfit] = useState<number | ''>('');

  const complete = maxMinutes !== '' && maxTrades !== '' && maxLoss !== '';

  async function onSubmit() {
    if (!complete || submitting) return;
    await submit({
      maxMinutes: Number(maxMinutes),
      maxTrades: Number(maxTrades),
      maxLoss: Number(maxLoss),
      targetProfit: targetProfit === '' ? null : Number(targetProfit),
    });
  }

  return (
    <AnimatePresence>
      {gate === 'blocked' && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          // No onClick — the backdrop is deliberately inert.
          className="fixed inset-0 z-[110] flex items-end justify-center bg-black/60 sm:items-center"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="discipline-panel-title"
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
              {/* Grab-handle affordance on phones; the sheet is not actually
                  draggable, because it cannot be dismissed. */}
              <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-border2 sm:hidden" aria-hidden="true" />
              <h2 id="discipline-panel-title" className="text-base font-bold text-text">
                Set your limits for today
              </h2>
              <p className="mt-1 text-xs text-muted">
                Takes a few seconds. You can go past any of these later, but you&apos;ll have to write down why.
              </p>
            </header>

            <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
              <Field
                label="How long do you plan to trade today?"
                suffix="min"
                value={maxMinutes}
                onChange={setMaxMinutes}
                presets={MINUTE_PRESETS}
              />
              <Field
                label="How many trades will you take at most?"
                suffix="trades"
                value={maxTrades}
                onChange={setMaxTrades}
                presets={TRADE_PRESETS.map((v) => ({ label: String(v), value: v }))}
              />
              <Field
                label="How much loss are you willing to take today?"
                prefix="₹"
                value={maxLoss}
                onChange={setMaxLoss}
                presets={LOSS_PRESETS.map((v) => ({ label: inr0(v), value: v }))}
              />

              {/* Advisory — never a gate. */}
              <section className="rounded-card border border-border2 bg-bg p-3">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-sm font-semibold text-text">Also set a profit target?</h3>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">optional</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  Most people plan for losses and leave gains open-ended. A move can reverse in seconds, and giving
                  back a good day costs the same as a bad one. Naming a number now, while you&apos;re calm, makes it
                  easier to recognise later.
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-faint">
                  Leave it blank if you&apos;d rather not — nothing here blocks you either way.
                </p>
                <label className="mt-3 block">
                  <span className="text-xs font-semibold text-muted">Profit target</span>
                  <NumberInput prefix="₹" value={targetProfit} onChange={setTargetProfit} placeholder="optional" />
                </label>
              </section>

              {/* Amber, not red: DESIGN-SYSTEM.md §1 reserves green/red strictly
                  for market direction and sentiment, never decoration. A failed
                  save is neither. */}
              {submitError && (
                <p role="alert" className="rounded-lg bg-amber-bg px-3 py-2 text-xs text-amber">
                  {submitError}
                </p>
              )}
            </div>

            <footer
              className="shrink-0 border-t border-border px-4 pt-3"
              style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
            >
              <button
                type="button"
                onClick={onSubmit}
                disabled={!complete || submitting}
                className={cn(buttonClasses({ variant: 'primary', size: 'md' }), 'w-full disabled:opacity-40')}
              >
                {submitting ? 'Saving…' : 'Start the session'}
              </button>
              {!complete && (
                <p className="mt-2 text-center text-[11px] text-faint">All three are needed before you can start.</p>
              )}
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// --------------------------------------------------------------- primitives

function Field({
  label,
  value,
  onChange,
  presets,
  prefix,
  suffix,
}: {
  label: string;
  value: number | '';
  onChange: (v: number | '') => void;
  presets: { label: string; value: number }[];
  prefix?: string;
  suffix?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-semibold text-text">{label}</label>
      {/* Chips first: tapping is the common path on a phone, typing is the
          escape hatch. `flex-wrap` keeps four chips on one row at 375px and
          reflows rather than scrolling horizontally on anything narrower. */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.value}
            type="button"
            aria-pressed={value === p.value}
            onClick={() => onChange(p.value)}
            className={cn(
              'min-h-[36px] rounded-lg border px-3 text-xs font-semibold transition-colors duration-micro',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              value === p.value
                ? 'border-teal bg-teal-bg text-teal'
                : 'border-border2 bg-bg text-muted hover:bg-hover hover:text-text',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <NumberInput prefix={prefix} suffix={suffix} value={value} onChange={onChange} placeholder="or type a number" />
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  placeholder,
  prefix,
  suffix,
}: {
  value: number | '';
  onChange: (v: number | '') => void;
  placeholder?: string;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <div className="relative mt-2">
      {prefix && (
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-faint">{prefix}</span>
      )}
      <input
        // `inputMode` (not type="number") gives the numeric keypad on mobile
        // without the desktop spinner and its scroll-to-change misfires.
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          const digits = e.target.value.replace(/[^\d]/g, '');
          onChange(digits === '' ? '' : Number(digits));
        }}
        className={cn(
          'min-h-[44px] w-full rounded-lg border border-border2 bg-bg py-2 text-sm text-text',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
          prefix ? 'pl-7' : 'pl-3',
          suffix ? 'pr-14' : 'pr-3',
        )}
      />
      {suffix && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">
          {suffix}
        </span>
      )}
    </div>
  );
}

function inr0(n: number): string {
  return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}
