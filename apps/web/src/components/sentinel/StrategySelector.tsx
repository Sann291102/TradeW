'use client';

import { useEffect, useState } from 'react';
import { cn } from '@tradew/ui';
import { api } from '@/lib/api';
import type { RegistryStrategy, StrategyAdvice, StrategyMode } from '@/lib/sentinel/types';

const AUTO_VALUE = '__auto__';

/**
 * Strategy selector + live status, shown directly below Current Market
 * Structure.
 *
 * The dropdown's first option is always "Auto (Default)"; below it come the
 * educational strategies loaded dynamically from the registry
 * (GET /sentinel/strategies/registry). Nothing is hardcoded here — adding a
 * strategy server-side (flipping `exposed`) makes it appear with no frontend
 * change.
 *
 * The compact status below the dropdown reflects the Brain's read for the
 * current mode: in Auto it shows what the Brain selected and its confidence;
 * in Manual it shows suitability and, when a pick lacks confirmation, the
 * standard "does not currently have sufficient confirmation" line.
 */
export function StrategySelector({
  mode,
  selectedStrategyId,
  advice,
  onChange,
}: {
  mode: StrategyMode;
  selectedStrategyId?: string;
  advice?: StrategyAdvice;
  onChange: (next: { mode: StrategyMode; selectedStrategyId?: string }) => void;
}) {
  const [strategies, setStrategies] = useState<RegistryStrategy[]>([]);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await api('/sentinel/strategies/registry')) as { strategies: RegistryStrategy[] };
        if (!cancelled) setStrategies(res.strategies ?? []);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = mode === 'manual' && selectedStrategyId ? selectedStrategyId : AUTO_VALUE;

  function handleChange(v: string) {
    if (v === AUTO_VALUE) onChange({ mode: 'auto' });
    else onChange({ mode: 'manual', selectedStrategyId: v });
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">Strategy</h2>
          <p className="mt-0.5 text-[11.5px] text-muted">
            Auto lets Sentinel choose; a manual pick becomes reasoning context, validated against the live market.
          </p>
        </div>

        <div className="relative">
          <select
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            className="min-w-[220px] appearance-none rounded-lg border border-border bg-bg px-3 py-2 pr-9 text-[13px] font-semibold text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            aria-label="Strategy"
          >
            <option value={AUTO_VALUE}>Auto (Default)</option>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <svg className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      {loadError && strategies.length === 0 && (
        <p className="mt-3 text-[11.5px] text-muted">Strategy registry unavailable right now — Auto mode still works.</p>
      )}

      <StrategyStatus mode={mode} advice={advice} />
    </section>
  );
}

function StrategyStatus({ mode, advice }: { mode: StrategyMode; advice?: StrategyAdvice }) {
  if (!advice) {
    return (
      <div className="mt-4 rounded-lg bg-bg px-3.5 py-3 text-[12.5px] text-muted">
        {mode === 'auto' ? 'Auto Mode — Sentinel is reading the market.' : 'Manual Mode — validating your selection.'}
      </div>
    );
  }

  const waiting = advice.status.toLowerCase().includes('waiting') || advice.status.toLowerCase().includes('sufficient confirmation');

  return (
    <div className="mt-4 rounded-lg bg-bg px-3.5 py-3">
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
