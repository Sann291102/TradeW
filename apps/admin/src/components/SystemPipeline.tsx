'use client';

import { useState, type ReactNode } from 'react';

/**
 * The reusable TradeW cognition/system pipeline visualization.
 *
 *   Market / Data → Perceptors → Context/Features → Neural Layers →
 *   AI Brain / Sentinel → Agents → Reasoning → Risk / Safety → OMS / Trading →
 *   Audit / Learning
 *
 * It is a REAL, data-driven component, not a picture. Each stage is supplied by
 * the caller with whatever the backend actually exposes for it. Three honesty
 * rules are baked in:
 *
 *   1. A stage with `metric == null` renders an em dash, never a number.
 *   2. A stage's `status` is the caller's real read: 'live' (green, pulsing),
 *      'idle' (dim, connected but quiet), 'offline' (a real source that is
 *      currently down), or 'unavailable' (no backend capability yet — dashed).
 *   3. A connector only shows flowing data when BOTH stages it joins are live.
 *
 * Future backend services populate more stages without the component changing:
 * pass a longer `stages` array. `DEFAULT_PIPELINE` is the canonical chain, for
 * callers that only want to override the stages they have data for.
 */

export type StageStatus = 'live' | 'idle' | 'offline' | 'unavailable';

export interface PipelineStage {
  id: string;
  label: string;
  /** Real value + optional unit, or null to render "—" honestly. */
  metric?: { value: string; unit?: string } | null;
  status: StageStatus;
  /** One-line explanation shown when the stage is selected. */
  detail?: string;
  group?: 'input' | 'cognition' | 'ai' | 'exec' | 'oversight';
}

/** The canonical stage skeleton. Callers merge real data onto these by id. */
export const DEFAULT_PIPELINE: PipelineStage[] = [
  { id: 'inputs', label: 'Market / Data', status: 'unavailable', group: 'input', detail: 'Market data, news, sentiment and economic feeds entering the platform.' },
  { id: 'perceptors', label: 'Perceptors', status: 'unavailable', group: 'cognition', detail: 'The 17 sensors that turn raw signals into salient percepts.' },
  { id: 'features', label: 'Context / Features', status: 'unavailable', group: 'cognition', detail: 'Encoded features and context assembled from percepts.' },
  { id: 'neural', label: 'Neural Layers', status: 'unavailable', group: 'cognition', detail: 'The four-layer network — perception, encoding, association, consolidation.' },
  { id: 'brain', label: 'AI Brain / Sentinel', status: 'unavailable', group: 'ai', detail: 'Sentinel reasoning over the consolidated network state.' },
  { id: 'agents', label: 'Agents', status: 'unavailable', group: 'ai', detail: 'The specialist agents that run each analysis pass.' },
  { id: 'reasoning', label: 'Reasoning', status: 'unavailable', group: 'ai', detail: 'Traceable agent reasoning, votes and evidence.' },
  { id: 'risk', label: 'Risk / Safety', status: 'unavailable', group: 'oversight', detail: 'Observation-only safety layer. Never gates the order flow (ARCHITECTURE Rule 2).' },
  { id: 'oms', label: 'OMS / Trading', status: 'unavailable', group: 'exec', detail: 'Order management — placement, fills, rejections.' },
  { id: 'audit', label: 'Audit / Learning', status: 'unavailable', group: 'oversight', detail: 'Audit trail and the learning loop that scores outcomes.' },
];

const GROUP_ACCENT: Record<NonNullable<PipelineStage['group']>, string> = {
  input: 'rgb(56 189 248)', // sky
  cognition: 'rgb(139 157 255)', // violet
  ai: 'rgb(45 212 191)', // teal
  exec: 'rgb(52 211 153)', // green
  oversight: 'rgb(240 165 60)', // amber
};

const STATUS_META: Record<StageStatus, { dot: string; ring: string; label: string; text: string }> = {
  live: { dot: 'bg-up', ring: 'border-up/40', label: 'Live', text: 'text-up' },
  idle: { dot: 'bg-teal', ring: 'border-teal/25', label: 'Idle', text: 'text-teal' },
  offline: { dot: 'bg-down', ring: 'border-down/40', label: 'Offline', text: 'text-down' },
  unavailable: { dot: 'bg-slate-600', ring: 'border-dashed border-white/12', label: 'No source', text: 'text-faint' },
};

export function SystemPipeline({ stages, title = 'System Signal Flow', subtitle }: { stages: PipelineStage[]; title?: string; subtitle?: ReactNode }) {
  const [selected, setSelected] = useState<string | null>(null);
  const active = stages.find((s) => s.id === selected) ?? null;

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] backdrop-blur-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <div>
          <h2 className="text-[12.5px] font-semibold tracking-wide">{title}</h2>
          {subtitle && <p className="text-[11px] text-muted">{subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-faint">
          <Legend dot="bg-up" label="Live" />
          <Legend dot="bg-teal" label="Idle" />
          <Legend dot="bg-down" label="Offline" />
          <Legend dot="bg-slate-600" label="No source yet" />
        </div>
      </header>

      <div className="overflow-x-auto px-4 py-4">
        <div className="flex min-w-max items-stretch gap-0">
          {stages.map((stage, i) => {
            const next = stages[i + 1];
            const flowing = next && stage.status === 'live' && next.status === 'live';
            return (
              <div key={stage.id} className="flex items-stretch">
                <StageNode stage={stage} selected={stage.id === selected} onSelect={() => setSelected(stage.id === selected ? null : stage.id)} />
                {next && <Connector flowing={Boolean(flowing)} />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-white/[0.06] px-4 py-2.5">
        {active ? (
          <p className="text-[11.5px] text-muted">
            <span className="font-semibold text-text">{active.label}. </span>
            {active.detail ?? 'No detail available.'}
            {active.status === 'unavailable' && <span className="text-faint"> — no backend source is wired to this stage yet.</span>}
          </p>
        ) : (
          <p className="text-[11px] text-faint">Select a stage to inspect it. Nodes without a live source are shown dashed and read “—”, never a fabricated value.</p>
        )}
      </div>
    </div>
  );
}

function StageNode({ stage, selected, onSelect }: { stage: PipelineStage; selected: boolean; onSelect: () => void }) {
  const meta = STATUS_META[stage.status];
  const accent = GROUP_ACCENT[stage.group ?? 'cognition'];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`admin-tile relative flex w-[132px] flex-col overflow-hidden rounded-lg border bg-white/[0.02] px-3 py-2.5 text-left transition-colors ${meta.ring} ${selected ? 'ring-1 ring-teal/50' : 'hover:border-white/20'}`}
    >
      <span className="pointer-events-none absolute inset-y-0 left-0 w-0.5" style={{ background: accent, opacity: stage.status === 'unavailable' ? 0.25 : 0.9 }} aria-hidden />
      <div className="flex items-center justify-between gap-1">
        <span className="relative inline-flex" aria-hidden>
          {stage.status === 'live' && <span className={`absolute inset-0 animate-ping rounded-full opacity-60 ${meta.dot}`} />}
          <span className={`relative inline-block h-1.5 w-1.5 rounded-full ${meta.dot}`} />
        </span>
        <span className={`text-[9px] uppercase tracking-wide ${meta.text}`}>{meta.label}</span>
      </div>
      <div className="mt-1.5 text-[11.5px] font-semibold leading-tight">{stage.label}</div>
      <div className="num mt-1 text-[15px] font-semibold leading-none">
        {stage.metric ? (
          <>
            {stage.metric.value}
            {stage.metric.unit && <span className="ml-0.5 text-[10px] font-normal text-faint">{stage.metric.unit}</span>}
          </>
        ) : (
          <span className="text-faint">—</span>
        )}
      </div>
    </button>
  );
}

function Connector({ flowing }: { flowing: boolean }) {
  return (
    <div className="relative flex w-7 items-center self-center" aria-hidden>
      <div className={`h-px w-full ${flowing ? 'bg-teal/50' : 'bg-white/10'}`} />
      {flowing && <span className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full bg-teal" />}
      <span className={`absolute right-0 top-1/2 -translate-y-1/2 border-y-[3px] border-l-[4px] border-y-transparent ${flowing ? 'border-l-teal/60' : 'border-l-white/15'}`} />
    </div>
  );
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
