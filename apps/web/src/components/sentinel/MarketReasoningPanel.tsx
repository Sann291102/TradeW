'use client';

import { cn } from '@tradew/ui';
import type {
  InstitutionalCrossValidation,
  MarketBehaviourRead,
  StrategyLifecycle,
} from '@/lib/sentinel/types';

/**
 * Market Reasoning — the panel that makes Sentinel's own analysis visible.
 *
 * Phases 2, 3 and 6 all computed real reasoning that the backend returned and
 * nothing rendered: market structure, resting and swept liquidity, each
 * strategy's position in its lifecycle, and whether the independent evidence
 * dimensions agree. The intelligence existed and was invisible, which for an
 * educational product is close to the intelligence not existing.
 *
 * Everything here is descriptive. No element carries an entry, target, stop or
 * size, and the lifecycle labels are the non-directive ones the backend
 * already enforces.
 */

export function MarketReasoningPanel({
  behaviour,
  lifecycles,
  crossValidation,
}: {
  behaviour?: MarketBehaviourRead;
  lifecycles?: StrategyLifecycle[];
  crossValidation?: InstitutionalCrossValidation;
}) {
  // Nothing computed yet (no observation, or the data layer is unavailable) —
  // render nothing rather than an empty shell implying analysis happened.
  if (!behaviour && !lifecycles?.length && !crossValidation) return null;

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2 sm:p-6">
      <header className="mb-4">
        <h2 className="text-[13.5px] font-bold text-text">Market reasoning</h2>
        <p className="text-[11.5px] text-muted">
          What Sentinel is reading right now — structure, liquidity, and whether the evidence agrees.
        </p>
      </header>

      {behaviour && <BehaviourBlock behaviour={behaviour} />}
      {!!lifecycles?.length && <LifecycleBlock lifecycles={lifecycles} />}
      {crossValidation && <CrossValidationBlock cv={crossValidation} />}
    </section>
  );
}

function BehaviourBlock({ behaviour }: { behaviour: MarketBehaviourRead }) {
  const { structure, liquidity } = behaviour;
  const unswept = liquidity.pools.filter((p) => !p.swept);

  return (
    <div className="mb-5">
      <p className="text-[12.5px] leading-relaxed text-text">{behaviour.narrative}</p>

      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Structure" value={humanise(structure.state)} />
        <Stat
          label="Behaviour"
          value={humanise(behaviour.behaviour.read)}
          tone={behaviour.behaviour.read === 'reversal-risk' ? 'warn' : 'neutral'}
        />
        <Stat label="Regime" value={behaviour.regime ? humanise(behaviour.regime) : 'Unclassified'} />
      </dl>

      {structure.event && (
        <p
          className={cn(
            'mt-3 rounded-lg border px-3 py-2 text-[11.5px]',
            structure.event === 'change-of-character' ? 'border-down bg-down-bg text-down' : 'border-border text-muted',
          )}
        >
          <strong className="font-semibold">{humanise(structure.event)}</strong>
          {structure.eventDirection ? ` (${structure.eventDirection})` : ''} —{' '}
          {structure.event === 'change-of-character'
            ? 'the prior trend is no longer making the sequence it needs to continue.'
            : 'the existing sequence is continuing.'}
        </p>
      )}

      {liquidity.recentSweep && (
        <p className="mt-2 text-[11.5px] text-muted">
          <span className="font-semibold text-text">
            {liquidity.recentSweep.reclaimed ? 'Liquidity swept' : 'Level accepted'}
          </span>{' '}
          {liquidity.recentSweep.side} {liquidity.recentSweep.price.toFixed(1)}
          {liquidity.recentSweep.reclaimed
            ? ' — price closed back inside, so the move reached resting stops rather than revaluing.'
            : ' — price closed beyond it, so the market accepted the new level.'}
        </p>
      )}

      {unswept.length > 0 && (
        <p className="mt-2 text-[11.5px] text-muted">
          Untested liquidity:{' '}
          {unswept.slice(0, 3).map((p, i) => (
            <span key={p.price}>
              {i > 0 && ', '}
              <span className="font-mono text-text">{p.price.toFixed(1)}</span> ({p.touches} touches, {p.side})
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/** Lifecycle states in narrative order, so the list reads as progress. */
const LIFECYCLE_ORDER = [
  'WATCHING', 'FORMING', 'CONFIRMED', 'SIDE_IN_FOCUS',
  'ACTIVE', 'MOMENTUM_WEAKENING', 'MOVE_COMPLETE', 'INVALIDATED', 'LEARN',
];

function LifecycleBlock({ lifecycles }: { lifecycles: StrategyLifecycle[] }) {
  const sorted = [...lifecycles].sort(
    (a, b) => LIFECYCLE_ORDER.indexOf(b.state) - LIFECYCLE_ORDER.indexOf(a.state),
  );

  return (
    <div className="mb-5 border-t border-border pt-4">
      <h3 className="mb-2 text-[12px] font-bold text-text">Strategy lifecycle</h3>
      <ul className="space-y-2">
        {sorted.map((l) => (
          <li key={l.strategyId} className="flex items-start gap-2.5">
            <span
              className={cn(
                'mt-[2px] shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                lifecycleTone(l.state),
              )}
            >
              {l.label}
            </span>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-text">{l.strategyName}</p>
              <p className="text-[11.5px] leading-relaxed text-muted">{l.reason}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CrossValidationBlock({ cv }: { cv: InstitutionalCrossValidation }) {
  return (
    <div className="border-t border-border pt-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[12px] font-bold text-text">Evidence cross-validation</h3>
        {cv.consensus && (
          <span className="font-mono text-[11px] tabular-nums text-muted">
            {Math.round(cv.agreementScore * 100)}% agreement · {cv.agreeing}/{cv.voting} dimensions
          </span>
        )}
      </div>

      <ul className="space-y-1.5">
        {cv.dimensions.map((d) => (
          <li key={d.id} className="flex items-start gap-2.5">
            <span
              className={cn(
                'mt-[3px] w-[68px] shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-bold uppercase',
                stanceTone(d.stance),
              )}
            >
              {d.stance === 'abstain' ? 'no data' : d.stance}
            </span>
            <div className="min-w-0">
              <p className="text-[11.5px] font-semibold text-text">{d.label}</p>
              <p className="text-[11px] leading-relaxed text-muted">{d.evidence}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-[11.5px] leading-relaxed text-muted">{cv.summary}</p>
    </div>
  );
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'warn' }) {
  return (
    <div className="rounded-lg border border-border px-2.5 py-1.5">
      <dt className="text-[10px] uppercase tracking-wide text-faint">{label}</dt>
      <dd className={cn('text-[12px] font-semibold', tone === 'warn' ? 'text-down' : 'text-text')}>{value}</dd>
    </div>
  );
}

function lifecycleTone(state: string): string {
  switch (state) {
    case 'SIDE_IN_FOCUS':
    case 'ACTIVE':
      return 'border-teal bg-teal-bg text-teal';
    // `amber`, not `warn` — there is no `warn` key in the Tailwind preset, and
    // a missing colour token renders nothing at all with no build warning.
    case 'MOMENTUM_WEAKENING':
      return 'border-amber bg-amber-bg text-amber';
    case 'INVALIDATED':
      return 'border-down bg-down-bg text-down';
    case 'MOVE_COMPLETE':
    case 'LEARN':
      return 'border-border text-muted';
    default:
      return 'border-border text-muted';
  }
}

function stanceTone(stance: string): string {
  switch (stance) {
    case 'bullish':
      return 'bg-up-bg text-up';
    case 'bearish':
      return 'bg-down-bg text-down';
    case 'neutral':
      return 'bg-card text-muted';
    default:
      // Abstain is deliberately muted, not styled like a vote — a dimension
      // with no data must not read as mild agreement.
      return 'bg-card text-faint';
  }
}

function humanise(value: string): string {
  const s = value.replace(/[-_]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
