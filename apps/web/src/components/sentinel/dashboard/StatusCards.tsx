'use client';

import type { ReactNode } from 'react';
import { cn } from '@tradew/ui';
import type { DashboardModel } from '@/lib/sentinel/dashboardModel';
import { toneBar, toneBg, toneText } from './tone';

/**
 * The five status cards across the top of the Sentinel dashboard — Market
 * Regime, Sentinel Confidence, Composite Risk Score, State Machine, Session
 * Observations. Every value comes from the real `/observe` model; a `null`
 * score renders "—" rather than a placeholder number.
 */

function StatCard({
  label,
  value,
  detail,
  detailTone,
  icon,
  iconTone,
  progress,
  highlight,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  detailTone: string;
  icon: ReactNode;
  iconTone: string;
  /** 0..1 progress bar; omitted for cards without one */
  progress?: { value: number; tone: keyof typeof toneBar } | null;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border bg-card p-4 shadow-elev1 transition-colors',
        highlight ? 'border-amber' : 'border-border',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10.5px] font-bold uppercase tracking-wideTrack text-faint">{label}</span>
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', iconTone)}>{icon}</span>
      </div>
      <div className="mt-2.5 flex items-baseline gap-1">
        <span className="text-[24px] font-extrabold leading-none tracking-tightTrack text-text">{value}</span>
      </div>
      <p className={cn('mt-1.5 text-[11.5px] font-semibold', detailTone)}>{detail}</p>
      {progress && (
        <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-hover">
          <div
            className={cn('h-full rounded-full transition-all', toneBar[progress.tone])}
            style={{ width: `${Math.max(4, Math.min(100, progress.value * 100))}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function StatusCards({ model }: { model: DashboardModel }) {
  const { regime, confidence, risk, state, observationCount } = model;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <StatCard
        label="Market Regime"
        value={regime.label}
        detail={regime.detail}
        detailTone={toneText[regime.tone]}
        iconTone={toneBg[regime.tone]}
        icon={<RegimeIcon />}
      />
      <StatCard
        label="Sentinel Confidence"
        value={confidence.score == null ? '—' : <>{confidence.score}<span className="text-[13px] font-semibold text-faint"> /100</span></>}
        detail={confidence.detail}
        detailTone={toneText[confidence.tone]}
        iconTone={toneBg[confidence.tone]}
        icon={<ShieldIcon />}
        progress={confidence.score == null ? null : { value: confidence.score / 100, tone: confidence.tone }}
      />
      <StatCard
        label="Composite Risk Score"
        value={risk.score == null ? '—' : <>{risk.score}<span className="text-[13px] font-semibold text-faint"> /100</span></>}
        detail={risk.detail}
        detailTone={toneText[risk.tone]}
        iconTone={toneBg[risk.tone]}
        icon={<WarnIcon />}
        progress={risk.score == null ? null : { value: risk.score / 100, tone: risk.tone }}
        highlight={risk.tone === 'amber' || risk.tone === 'down'}
      />
      <StatCard
        label="State Machine"
        value={state.label}
        detail={state.detail}
        detailTone={toneText[state.tone]}
        iconTone={toneBg[state.tone]}
        icon={<TargetIcon />}
      />
      <StatCard
        label="Session Observations"
        value={observationCount}
        detail="Today"
        detailTone="text-muted"
        iconTone="bg-teal-bg text-teal"
        icon={<BarsIcon />}
      />
    </div>
  );
}

/* --- inline icons (16px, currentColor) --- */
const ic = { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const RegimeIcon = () => (<svg {...ic}><path d="M3 13.5 7 9l3 2.5L17 5" /><path d="M13 5h4v4" /></svg>);
const ShieldIcon = () => (<svg {...ic}><path d="M10 2.5 4.5 4.8v4.4c0 3.3 2.2 6.3 5.5 7.4 3.3-1.1 5.5-4.1 5.5-7.4V4.8L10 2.5Z" /><path d="m7.6 9.8 1.7 1.7 3.3-3.4" /></svg>);
const WarnIcon = () => (<svg {...ic}><path d="M10 3 2.8 16h14.4L10 3Z" /><path d="M10 8v3.5M10 14v.1" /></svg>);
const TargetIcon = () => (<svg {...ic}><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3.2" /><path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2" /></svg>);
const BarsIcon = () => (<svg {...ic}><path d="M4.5 16v-5M9.5 16V6M14.5 16v-8" /></svg>);
