'use client';

import { useQuery } from '@tanstack/react-query';
import { cn } from '@tradew/ui';
import { api } from '@/lib/api';
import type { RegistryStrategy, StrategyAdvice, StrategyMode } from '@/lib/sentinel/types';

/**
 * Strategy selector + live status, shown directly below Current Market
 * Structure.
 *
 * "Auto (Default)" and manual strategy picks are mutually exclusive: Auto
 * lets Sentinel choose the best-corroborated setup as context; checking one
 * or more strategies below pins them to track simultaneously — each is
 * validated against live conditions independently (Phase 2, multi-strategy).
 * Unchecking the last pinned strategy reverts to Auto rather than leaving a
 * manual mode with nothing selected.
 *
 * The registry (GET /sentinel/strategies/registry) is the only source of
 * strategies shown — nothing is hardcoded here, so flipping `exposed`
 * server-side changes what appears with no frontend change.
 */
export function StrategySelector({
  mode,
  selectedStrategyIds,
  advices,
  onChange,
}: {
  mode: StrategyMode;
  selectedStrategyIds: string[];
  advices?: StrategyAdvice[];
  onChange: (next: { mode: StrategyMode; selectedStrategyIds?: string[] }) => void;
}) {
  // The registry is reference data that changes on deploy, so it takes the
  // default five-minute staleTime and no polling. What it gains from the cache
  // is a failure path: this used to set a boolean that nothing could clear, so
  // a registry request lost to a 502 left the selector permanently empty with
  // no way back short of a reload. Now a transient failure retries itself, and
  // anything that outlives the backoff offers the user a retry.
  const registryQuery = useQuery({
    queryKey: ['sentinel', 'strategy-registry'] as const,
    queryFn: async () => {
      const res = (await api('/sentinel/strategies/registry')) as { strategies: RegistryStrategy[] };
      return res.strategies ?? [];
    },
  });

  const strategies = registryQuery.data ?? [];
  const loadError = registryQuery.isError;

  function selectAuto() {
    onChange({ mode: 'auto' });
  }

  function toggleStrategy(id: string, checked: boolean) {
    const next = checked ? [...selectedStrategyIds, id] : selectedStrategyIds.filter((s) => s !== id);
    if (next.length === 0) {
      onChange({ mode: 'auto' });
    } else {
      onChange({ mode: 'manual', selectedStrategyIds: next });
    }
  }

  const isAuto = mode === 'auto' || selectedStrategyIds.length === 0;

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2 sm:p-6">
      <h2 className="text-[11px] font-bold uppercase tracking-wideTrack text-faint">Strategy</h2>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
        Auto lets Sentinel choose; pin one or more strategies to track them simultaneously, each validated against
        the live market.
      </p>

      <div className="mt-3.5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={selectAuto}
          aria-pressed={isAuto}
          className={cn(
            'rounded-full border px-3.5 py-1.5 text-[12px] font-semibold transition-colors duration-micro',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
            isAuto
              ? 'border-teal bg-teal-bg text-teal'
              : 'border-border2 bg-bg text-muted hover:bg-hover hover:text-text',
          )}
        >
          Auto (Default)
        </button>
        {strategies.map((s) => {
          const checked = selectedStrategyIds.includes(s.id);
          return (
            <label
              key={s.id}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-semibold transition-colors duration-micro',
                'focus-within:ring-2 focus-within:ring-focus',
                checked
                  ? 'border-teal bg-teal-bg text-teal'
                  : 'border-border2 bg-bg text-muted hover:bg-hover hover:text-text',
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => toggleStrategy(s.id, e.target.checked)}
                className="sr-only"
                aria-label={s.name}
              />
              {s.name}
            </label>
          );
        })}
      </div>

      {loadError && strategies.length === 0 && (
        <p className="mt-3 text-[11.5px] text-muted">
          Strategy registry unavailable right now — Auto mode still works.{' '}
          <button
            type="button"
            onClick={() => void registryQuery.refetch()}
            className="font-semibold text-teal underline underline-offset-2 hover:no-underline"
          >
            Try again
          </button>
        </p>
      )}

      {isAuto ? (
        <StrategyStatus mode="auto" advice={advices?.[0]} />
      ) : (
        <div className="mt-4 space-y-2">
          {(advices ?? []).map((advice) => (
            <StrategyStatus key={advice.requestedStrategyId ?? advice.activeStrategyId ?? advice.status} mode="manual" advice={advice} bare />
          ))}
        </div>
      )}
    </section>
  );
}

function StrategyStatus({
  mode,
  advice,
  bare = false,
}: {
  mode: StrategyMode;
  advice?: StrategyAdvice;
  /** true when rendered as one of several stacked entries — skips the outer top margin. */
  bare?: boolean;
}) {
  if (!advice) {
    return (
      <div className={cn('rounded-xl border border-border bg-bg px-4 py-3.5 text-[12.5px] text-muted', !bare && 'mt-4')}>
        {mode === 'auto' ? 'Auto Mode — Sentinel is reading the market.' : 'Manual Mode — validating your selection.'}
      </div>
    );
  }

  const waiting = advice.status.toLowerCase().includes('waiting') || advice.status.toLowerCase().includes('sufficient confirmation');

  return (
    <div className={cn('rounded-xl border border-border bg-bg px-4 py-3.5', !bare && 'mt-4')}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px]">
        <Field label="Mode" value={mode === 'auto' ? 'Auto Mode' : 'Manual Mode'} />
        {advice.activeStrategyName && (
          <Field label={advice.aiSelected ? 'AI Selected' : 'Strategy'} value={advice.activeStrategyName} accent={advice.aiSelected} />
        )}
        {mode === 'manual' && advice.marketSuitability !== 'unknown' && (
          <Field label="Suitability" value={capitalise(advice.marketSuitability)} />
        )}
        {!waiting && <Field label="Confidence" value={`${Math.round(advice.confidence)}%`} accent />}
      </div>
      <p className={cn('mt-2 text-[12px] leading-relaxed', waiting ? 'text-warn' : 'text-muted')}>
        {waiting ? advice.status : advice.message}
      </p>
    </div>
  );
}

function Field({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-faint">{label}</span>
      <span className={cn('font-semibold', accent ? 'text-teal' : 'text-text')}>{value}</span>
    </span>
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
