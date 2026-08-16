'use client';

import { cn } from '@tradew/ui';
import { fmt } from '@/lib/format';
import type { Timeline } from '@/lib/sentinel/sentinelPy';

/**
 * "Your Conditions" — the contract the user wrote, read back to them, with a
 * live count of how much of it the market currently satisfies.
 *
 * ── WHAT THIS PANEL MAY AND MAY NOT SAY ────────────────────────────────────
 * Every line here originates with the user. The conditions are the rules they
 * defined (evaluated by `services/sentinel-py`, which parses their text
 * deterministically — no model opinion enters). The prices are the levels they
 * typed when they recorded a position. That is what makes a panel full of
 * price levels compliant with Rule 2: nothing on it is Sentinel proposing an
 * entry, an invalidation, a target or a size. Sentinel's entire contribution
 * is the ✓/○ beside each row.
 *
 * The reference design has a "Position size — Dynamic (based on volatility)"
 * row and a feed line reading "Position size recommended: 75%". Those are not
 * implemented and deliberately so: a position-size recommendation is advice,
 * and Sentinel does not give advice (root CLAUDE.md Rule 2, SENTINEL.md §3).
 * The slot is used for the optional confirmations instead — real data, and the
 * genuine fourth part of a strategy contract.
 *
 * The progress bar counts MANDATORY conditions only. Filling it with optional
 * ones would let a setup read as nearly-confirmed on rules the user marked as
 * "nice to have", which is the number the whole feed thresholds on.
 */

export function StrategyConditionsPanel({
  timeline,
  onEdit,
}: {
  timeline: Timeline | null;
  /** Opens the strategy workspace, where the rules are actually editable. */
  onEdit?: () => void;
}) {
  if (!timeline) {
    return (
      <Shell onEdit={onEdit}>
        <p className="py-6 text-center text-[12px] leading-relaxed text-faint">
          No watch selected. Write a strategy and apply it to an instrument — the conditions you define appear here, and
          Sentinel checks them against the market every 15 seconds.
        </p>
      </Shell>
    );
  }

  const { conditions, watch } = timeline;
  const mandatory = conditions.filter((c) => c.mandatory);
  const optional = conditions.filter((c) => !c.mandatory);
  const met = mandatory.filter((c) => c.met).length;
  const ratio = mandatory.length > 0 ? met / mandatory.length : 0;

  // Risk per unit is the distance between two numbers the USER typed. It is
  // arithmetic on their own contract, not a level Sentinel derived — which is
  // why it may be shown at all.
  const risk =
    watch.entryPrice != null && watch.invalidationPrice != null
      ? Math.abs(watch.entryPrice - watch.invalidationPrice)
      : null;
  const reward =
    watch.entryPrice != null && watch.projectedPrice != null
      ? Math.abs(watch.projectedPrice - watch.entryPrice)
      : null;

  return (
    <Shell onEdit={onEdit}>
      <p className="mb-3.5 text-[11.5px] text-muted">All conditions are evaluated in real time</p>

      <Section label="Primary setup">
        {mandatory.length === 0 ? (
          <Absent>This strategy defines no mandatory conditions yet.</Absent>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {mandatory.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                <span className={cn('mt-px shrink-0 text-[11px]', c.met ? 'text-up' : 'text-faint')}>
                  {c.met ? '✓' : '○'}
                </span>
                <span className="min-w-0">
                  <span className={cn('text-[12.5px]', c.met ? 'text-text' : 'text-muted')}>
                    {c.name.replace(/_/g, ' ')}
                  </span>
                  {c.detail && <span className="block text-[11px] leading-snug text-faint">{c.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section label="Invalidation">
        {watch.invalidationPrice != null ? (
          <p className="text-[12.5px] text-text">
            <span className="font-mono">{fmt(watch.invalidationPrice)}</span>
            <span className="ml-1.5 text-[11px] text-faint">the level you called this idea wrong at</span>
          </p>
        ) : (
          <Absent>
            You declare this when you record a position. Sentinel never sets one — it only tracks the one you give it.
          </Absent>
        )}
      </Section>

      <Section label="Risk scale">
        {risk != null ? (
          <div className="flex flex-col gap-0.5 text-[12.5px] text-text">
            <p>
              <span className="text-faint">1R = </span>
              <span className="font-mono">{fmt(risk)}</span>
              <span className="text-[11px] text-faint"> from your entry to your invalidation</span>
            </p>
            {reward != null && (
              <p>
                <span className="text-faint">Projected = </span>
                <span className="font-mono">{(reward / risk).toFixed(2)}R</span>
                <span className="text-[11px] text-faint"> ({fmt(watch.projectedPrice!)}, your level)</span>
              </p>
            )}
          </div>
        ) : (
          <Absent>
            The scale progress is measured on. It comes from your own entry and invalidation, so it exists once you
            record a position.
          </Absent>
        )}
      </Section>

      <Section label="Optional confirmations" last>
        {optional.length === 0 ? (
          <Absent>None defined — every rule in this strategy is mandatory.</Absent>
        ) : (
          <ul className="flex flex-col gap-1">
            {optional.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-[12px]">
                <span className={cn('mt-px shrink-0 text-[11px]', c.met ? 'text-teal' : 'text-faint')}>
                  {c.met ? '✓' : '○'}
                </span>
                <span className={c.met ? 'text-text' : 'text-muted'}>{c.name.replace(/_/g, ' ')}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {mandatory.length > 0 && (
        <div className="mt-4 border-t border-border pt-3.5">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[12px] font-semibold text-text">Conditions matched</span>
            <span className="font-mono text-[12.5px] font-bold text-text">
              {met} / {mandatory.length}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-hover">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                ratio >= 1 ? 'bg-up' : ratio > 0 ? 'bg-amber' : 'bg-border2',
              )}
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          </div>
          {/* Naming what the bar is NOT: it is a count of the user's own rules,
              which is the one thing this service measures. It has never been a
              probability, and a bar at 80% must not be read as one. */}
          <p className="mt-2 text-[10.5px] leading-relaxed text-faint">
            How many of your required rules the market satisfies right now — not a probability, and not a score.
          </p>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children, onEdit }: { children: React.ReactNode; onEdit?: () => void }) {
  return (
    <section className="flex h-full flex-col rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-bold text-text">Your Conditions</h2>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="rounded-lg border border-border2 bg-bg px-2.5 py-1 text-[11px] font-semibold text-muted transition-colors hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Edit
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function Section({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={cn('py-3', !last && 'border-b border-border')}>
      <p className="mb-1.5 text-[9.5px] font-bold uppercase tracking-wideTrack text-faint">{label}</p>
      {children}
    </div>
  );
}

function Absent({ children }: { children: React.ReactNode }) {
  return <p className="text-[11.5px] leading-relaxed text-faint">{children}</p>;
}
