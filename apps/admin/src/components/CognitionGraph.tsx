'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { LayerRow, PerceptorRow } from '@/lib/api';

/**
 * The dedicated cognition network visualization — a real, interactive node graph
 * of the flow the four-layer network actually runs:
 *
 *   Perceptor domains → L1 Perception → L2 Encoding → L3 Association →
 *   L4 Consolidation → Cognition output
 *
 * Every node is backed by a real API field. Nothing is invented: a domain node's
 * counts come from the perceptor roster, a layer node's throughput is that
 * layer's real `outputs`, and the output node is the live pending-proposal
 * count. An edge only animates ("live") when the network is running AND the
 * source stage actually emitted something — never as decoration.
 *
 * Selecting a node calls `onSelect` with the node's real fields, so the page can
 * render a detail panel beside the graph.
 */

export interface CognitionNode {
  id: string;
  kind: 'domain' | 'layer' | 'output';
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'idle';
  active: boolean;
  metrics: Array<{ label: string; value: string }>;
  description?: string;
}

const TONE_FILL: Record<CognitionNode['tone'], string> = {
  good: '#2dd4bf',
  warn: '#f0a53c',
  bad: '#ef5350',
  idle: '#64748b',
};

const LAYER_ORDER = ['L1_PERCEPTION', 'L2_ENCODING', 'L3_ASSOCIATION', 'L4_CONSOLIDATION'];
const DOMAIN_ORDER = ['market', 'application', 'assistant', 'learning', 'platform'];

const VB_W = 1000;
const VB_H = 380;
const LAYER_X = [285, 455, 625, 795];
const OUTPUT_X = 930;
const MID_Y = 190;
const DOMAIN_X = 72;

export function CognitionGraph({
  perceptors,
  layers,
  running,
  outputCount,
  onSelect,
  selectedId,
}: {
  perceptors: PerceptorRow[];
  layers: LayerRow[];
  running: boolean;
  outputCount: number | null;
  onSelect: (node: CognitionNode | null) => void;
  selectedId: string | null;
}) {
  const model = useMemo(() => buildModel(perceptors, layers, running, outputCount), [perceptors, layers, running, outputCount]);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="w-full min-w-[720px]" style={{ height: 380 }} role="img" aria-label="Cognition network graph">
        {/* edges first, under the nodes */}
        {model.edges.map((e) => (
          <g key={e.id}>
            <line
              x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
              className={e.active ? 'admin-link admin-link--active' : 'admin-link'}
            />
            {e.active && running && (
              <circle r={2.4} fill="#22d3ee">
                <animateMotion dur="1.5s" repeatCount="indefinite" path={`M ${e.x1} ${e.y1} L ${e.x2} ${e.y2}`} />
              </circle>
            )}
          </g>
        ))}

        {model.nodes.map((n) => {
          const pos = model.pos[n.id];
          const fill = TONE_FILL[n.tone];
          const selected = n.id === selectedId;
          return (
            <g key={n.id} transform={`translate(${pos.x} ${pos.y})`} className="cursor-pointer" onClick={() => onSelect(selected ? null : n)}>
              {n.active && <circle r={pos.r + 6} fill={fill} opacity={0.14} className="animate-ping" />}
              <circle r={pos.r} fill={`${fill}22`} stroke={fill} strokeWidth={selected ? 2.4 : 1.4} />
              <circle r={pos.r * 0.42} fill={fill} opacity={n.active ? 0.95 : 0.5} />
              {pos.metric && (
                <text textAnchor="middle" dy={4} className="num" fontSize={12} fontWeight={600} fill="#e6edf3">{pos.metric}</text>
              )}
              <text textAnchor="middle" y={pos.r + 14} fontSize={10.5} fill="#8b98a9">{n.label}</text>
            </g>
          );
        })}

        {/* column captions */}
        <text x={DOMAIN_X} y={22} textAnchor="middle" fontSize={9.5} fill="#5c6773" style={{ textTransform: 'uppercase', letterSpacing: '0.12em' }}>Perceptors</text>
        <text x={(LAYER_X[0] + LAYER_X[3]) / 2} y={22} textAnchor="middle" fontSize={9.5} fill="#5c6773" style={{ letterSpacing: '0.12em' }}>NEURAL LAYERS</text>
        <text x={OUTPUT_X} y={22} textAnchor="middle" fontSize={9.5} fill="#5c6773" style={{ letterSpacing: '0.12em' }}>OUTPUT</text>
      </svg>
    </div>
  );
}

interface PositionedNode { x: number; y: number; r: number; metric?: string }

function buildModel(perceptors: PerceptorRow[], layers: LayerRow[], running: boolean, outputCount: number | null) {
  const nodes: CognitionNode[] = [];
  const pos: Record<string, PositionedNode> = {};

  // --- domain nodes (real perceptor roster) ---
  const byDomain = new Map<string, { total: number; healthy: number; enabled: number }>();
  for (const p of perceptors) {
    const e = byDomain.get(p.domain) ?? { total: 0, healthy: 0, enabled: 0 };
    e.total += 1;
    if (p.enabled) e.enabled += 1;
    if (p.enabled && p.health?.status === 'healthy') e.healthy += 1;
    byDomain.set(p.domain, e);
  }
  const domains = DOMAIN_ORDER.filter((d) => byDomain.has(d));
  const domainGap = domains.length > 1 ? 300 / (domains.length - 1) : 0;
  domains.forEach((d, i) => {
    const c = byDomain.get(d)!;
    const anyFailing = perceptors.some((p) => p.domain === d && (p.health?.status === 'quarantined' || p.health?.status === 'failing'));
    const anyStale = perceptors.some((p) => p.domain === d && p.health?.status === 'stale');
    const tone: CognitionNode['tone'] = c.enabled === 0 ? 'idle' : anyFailing ? 'bad' : anyStale ? 'warn' : 'good';
    const active = running && c.healthy > 0;
    nodes.push({
      id: `domain:${d}`, kind: 'domain', label: d, tone, active,
      metrics: [
        { label: 'Perceptors', value: String(c.total) },
        { label: 'Enabled', value: String(c.enabled) },
        { label: 'Healthy', value: String(c.healthy) },
      ],
      description: `${c.healthy} of ${c.total} ${d} perceptors are healthy and enabled.`,
    });
    pos[`domain:${d}`] = { x: DOMAIN_X, y: 60 + i * domainGap, r: 12 + Math.min(10, c.total), metric: String(c.total) };
  });

  // --- layer nodes (real throughput) ---
  const ordered = [...layers].sort((a, b) => a.index - b.index).slice(0, 4);
  const peak = Math.max(1, ...ordered.map((l) => l.outputs));
  ordered.forEach((l, i) => {
    const active = running && l.outputs > 0;
    const starved = l.passes > 0 && l.inputs > 0 && l.outputs === 0;
    nodes.push({
      id: `layer:${l.id}`, kind: 'layer', label: l.label,
      tone: starved ? 'bad' : active ? 'good' : 'idle', active,
      metrics: [
        { label: 'Inputs', value: l.inputs.toLocaleString() },
        { label: 'Outputs', value: l.outputs.toLocaleString() },
        { label: 'Passes', value: l.passes.toLocaleString() },
      ],
      description: l.description,
    });
    pos[`layer:${l.id}`] = { x: LAYER_X[i] ?? LAYER_X[3], y: MID_Y, r: 18 + (l.outputs / peak) * 12, metric: l.outputs > 0 ? l.outputs.toLocaleString() : undefined };
  });

  // --- output node (real pending proposals) ---
  const outActive = running && ordered.length > 0 && ordered[ordered.length - 1].outputs > 0 && (outputCount ?? 0) > 0;
  nodes.push({
    id: 'output', kind: 'output', label: 'Proposals',
    tone: (outputCount ?? 0) > 0 ? 'good' : 'idle', active: outActive,
    metrics: [{ label: 'Pending', value: outputCount != null ? String(outputCount) : '—' }],
    description: 'Consolidated hypotheses promoted to operator proposals. The network proposes; it never acts.',
  });
  pos.output = { x: OUTPUT_X, y: MID_Y, r: 20, metric: outputCount != null ? String(outputCount) : '—' };

  // --- edges ---
  const edges: Array<{ id: string; x1: number; y1: number; x2: number; y2: number; active: boolean }> = [];
  const l1 = ordered[0] ? pos[`layer:${ordered[0].id}`] : null;
  const l1Active = ordered[0] ? running && ordered[0].outputs > 0 : false;
  if (l1) {
    for (const d of domains) {
      const dp = pos[`domain:${d}`];
      const dActive = nodes.find((n) => n.id === `domain:${d}`)?.active ?? false;
      edges.push({ id: `e:${d}->l1`, x1: dp.x + dp.r, y1: dp.y, x2: l1.x - l1.r, y2: l1.y, active: dActive && l1Active });
    }
  }
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = pos[`layer:${ordered[i].id}`];
    const b = pos[`layer:${ordered[i + 1].id}`];
    edges.push({ id: `e:l${i}->l${i + 1}`, x1: a.x + a.r, y1: a.y, x2: b.x - b.r, y2: b.y, active: running && ordered[i].outputs > 0 });
  }
  if (ordered.length) {
    const last = pos[`layer:${ordered[ordered.length - 1].id}`];
    edges.push({ id: 'e:l4->out', x1: last.x + last.r, y1: last.y, x2: pos.output.x - pos.output.r, y2: pos.output.y, active: outActive });
  }

  return { nodes, pos, edges };
}

/** The detail panel that pairs with the graph. Renders the selected node's real
 *  fields, or a hint when nothing is selected. */
export function CognitionNodeDetail({ node, hint }: { node: CognitionNode | null; hint?: ReactNode }) {
  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 py-8 text-center">
        <div className="mb-2 h-8 w-8 rounded-full border border-dashed border-white/20" aria-hidden />
        <p className="text-[11.5px] text-faint">{hint ?? 'Select a node to inspect it. Every value here is a live read — dashed/idle nodes have no active signal.'}</p>
      </div>
    );
  }
  const dotClass = node.tone === 'good' ? 'bg-up' : node.tone === 'warn' ? 'bg-amber' : node.tone === 'bad' ? 'bg-down' : 'bg-slate-500';
  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
        <h3 className="text-[13px] font-semibold capitalize">{node.label}</h3>
        <span className="ml-auto rounded border border-white/10 px-1.5 py-px text-[9.5px] uppercase tracking-wide text-faint">{node.kind}</span>
      </div>
      {node.description && <p className="mt-2 text-[11px] leading-relaxed text-muted">{node.description}</p>}
      <div className="mt-3 space-y-1.5">
        {node.metrics.map((m) => (
          <div key={m.label} className="flex items-center justify-between border-b border-white/[0.04] pb-1.5 text-[11.5px]">
            <span className="text-faint">{m.label}</span>
            <span className="num">{m.value}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[10px] text-faint">{node.active ? 'Signal is flowing through this node.' : 'No active signal right now.'}</p>
    </div>
  );
}
