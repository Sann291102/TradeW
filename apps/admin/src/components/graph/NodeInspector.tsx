'use client';

import { useEffect, useState } from 'react';
import {
  DOMAIN_COLOR,
  KIND_LABEL,
  nodeColor,
  systemGraph,
  type NodeDetail,
  type NodeRelationRow,
} from '@/lib/graph';
import { ago, fmtTime } from '@/components/ui';

/**
 * The node inspector.
 *
 * Shows the REAL fields the projection carries for the selected entity, and
 * nothing else. Where a field is absent it is omitted rather than rendered as
 * a dash: on a screen whose whole claim is "every value here came from
 * somewhere", a placeholder is indistinguishable from a measurement of zero.
 *
 * Relationships are named from the SELECTED node's point of view — "exposes"
 * on a controller, "exposed by" on a route — using the inverse labels from the
 * relation vocabulary. One stored edge, read correctly at both ends.
 *
 * The actions along the bottom are the investigative moves: expand the
 * neighbourhood, focus the camera, follow a relationship, and (where the
 * entity has one) open the underlying operational page. There is deliberately
 * no destructive action here — this surface reads a projection, it does not
 * own anything it could delete.
 */

interface Props {
  nodeId: string | null;
  onFocus: (id: string) => void;
  onExpand: (id: string) => void;
  onSelect: (id: string) => void;
  /** Ask Claude about this node — the page owns how, since the assistant
   *  surface differs between deployments. Absent = the action is not offered. */
  onAsk?: (detail: NodeDetail) => void;
}

export function NodeInspector({ nodeId, onFocus, onExpand, onSelect, onAsk }: Props) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'overview' | 'relations' | 'history'>('overview');

  useEffect(() => {
    if (!nodeId) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void systemGraph
      .node(nodeId)
      .then((row) => {
        if (cancelled) return;
        setDetail(row);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDetail(null);
        // A node that has fallen out of the snapshot between selection and
        // fetch is a normal race, not a bug — say which, rather than "error".
        setError(err instanceof Error ? err.message : 'Could not load this node.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  if (!nodeId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-[11.5px] text-[#64769c]">
        Select a node to inspect it. Shift-drag to select several; double-click to expand a neighbourhood.
      </div>
    );
  }

  if (loading && !detail) {
    return <div className="p-6 text-center text-[11.5px] text-[#64769c]">Loading…</div>;
  }

  if (error || !detail) {
    return <div className="p-6 text-center text-[11.5px] text-amber">{error ?? 'Not in the current snapshot.'}</div>;
  }

  const { node } = detail;
  const detailEntries = Object.entries(node.detail ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== '');

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-white/[0.06] px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: nodeColor(node) }} />
          <div className="min-w-0 flex-1">
            <div className="break-words text-[13px] font-medium text-[#e2e8f0]">{node.label}</div>
            {node.summary && <div className="mt-0.5 text-[11px] text-[#8ea0c4]">{node.summary}</div>}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Chip color={DOMAIN_COLOR[node.domain]}>{node.domain}</Chip>
          <Chip>{KIND_LABEL[node.kind]}</Chip>
          {node.status && <Chip tone={node.status}>{node.status}</Chip>}
          <Chip title="Where this node's existence was established">{node.source}</Chip>
        </div>
      </div>

      {/* The three published measures, always shown together: they are what the
          radius, halo and opacity on the canvas are encoding. */}
      <div className="grid grid-cols-4 gap-px border-b border-white/[0.06] bg-white/[0.04]">
        <Measure label="Importance" value={node.importance} hint="node radius" />
        <Measure label="Activity" value={node.activity} hint="halo + pulse" />
        <Measure label="Confidence" value={node.confidence} hint="opacity" />
        <div className="bg-[#0d1524] px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-[0.08em] text-[#64769c]">Degree</div>
          <div className="font-mono text-[13px] text-[#e2e8f0]">{node.degree}</div>
          <div className="text-[9px] text-[#4b5b7d]">whole graph</div>
        </div>
      </div>

      <div className="flex border-b border-white/[0.06]">
        {(['overview', 'relations', 'history'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`flex-1 px-2 py-1.5 text-[10.5px] uppercase tracking-[0.08em] transition-colors ${
              tab === value ? 'border-b border-teal text-teal' : 'text-[#64769c] hover:text-[#8ea0c4]'
            }`}
          >
            {value}
            {value === 'relations' && <span className="ml-1 font-mono text-[9px]">{detail.incoming.length + detail.outgoing.length}</span>}
            {value === 'history' && detail.events.length > 0 && <span className="ml-1 font-mono text-[9px]">{detail.events.length}</span>}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'overview' && (
          <div className="space-y-2 px-3 py-2.5">
            {node.glyphs?.length ? (
              <div className="flex flex-wrap gap-1">
                {node.glyphs.map((glyph, index) => (
                  <span
                    key={`${glyph.key}-${index}`}
                    title={glyph.title}
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      glyph.tone === 'bad'
                        ? 'bg-down/15 text-down'
                        : glyph.tone === 'warn'
                          ? 'bg-amber/15 text-amber'
                          : glyph.tone === 'good'
                            ? 'bg-up/15 text-up'
                            : 'bg-white/[0.06] text-[#c6d0e2]'
                    }`}
                  >
                    {glyph.key}{glyph.value ? ` ${glyph.value}` : ''}
                  </span>
                ))}
              </div>
            ) : null}

            <dl className="space-y-1">
              {node.createdAt && <Row label="Created">{fmtTime(node.createdAt)}</Row>}
              {node.updatedAt && <Row label="Updated">{fmtTime(node.updatedAt)}</Row>}
              {node.lastSeen && <Row label="Last seen">{ago(node.lastSeen)}</Row>}
              {detailEntries.map(([key, value]) => (
                <Row key={key} label={humanise(key)}>
                  {renderValue(value)}
                </Row>
              ))}
            </dl>

            <div className="pt-1 font-mono text-[9px] text-[#4b5b7d]">{node.id}</div>
          </div>
        )}

        {tab === 'relations' && (
          <div className="px-1 py-1">
            <RelationList title="Outgoing" rows={detail.outgoing} onSelect={onSelect} />
            <RelationList title="Incoming" rows={detail.incoming} onSelect={onSelect} />
            {detail.outgoing.length === 0 && detail.incoming.length === 0 && (
              <p className="px-3 py-4 text-center text-[11px] text-[#64769c]">No relationships in the current snapshot.</p>
            )}
          </div>
        )}

        {tab === 'history' && (
          <div>
            {detail.events.length === 0 ? (
              <p className="px-3 py-4 text-center text-[11px] text-[#64769c]">
                No event history is recorded for this kind of entity.
              </p>
            ) : (
              <ul className="divide-y divide-white/[0.04]">
                {detail.events.map((event, index) => (
                  <li key={`${event.at}-${index}`} className="px-3 py-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className={`truncate text-[11px] ${event.status === 'error' ? 'text-down' : event.status === 'warn' ? 'text-amber' : 'text-[#c6d0e2]'}`}>
                        {event.label}
                      </span>
                      <span className="shrink-0 font-mono text-[9.5px] text-[#64769c]">{fmtTime(event.at)}</span>
                    </div>
                    {event.detail && <div className="truncate font-mono text-[9.5px] text-[#4b5b7d]">{event.detail}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1 border-t border-white/[0.06] px-3 py-2">
        <Action onClick={() => onExpand(node.id)}>Expand neighbourhood</Action>
        <Action onClick={() => onFocus(node.id)}>Focus</Action>
        {onAsk && <Action onClick={() => onAsk(detail)}>Ask Claude</Action>}
        <SourceLink node={detail} />
      </div>
    </div>
  );
}

/**
 * A link into the operational page that OWNS this entity.
 *
 * Only rendered for kinds where such a page exists. "Inspect source" on a
 * concept means the concept graph; on a route it means the API telemetry page.
 * Offering it everywhere would mean offering dead links, which teaches an
 * operator to stop trying them.
 */
function SourceLink({ node }: { node: NodeDetail }) {
  const target = (() => {
    switch (node.node.kind) {
      case 'route':
      case 'controller':
        return { href: '/observability', label: 'Open API telemetry' };
      case 'agent':
      case 'model':
        return { href: '/ai', label: 'Open AI telemetry' };
      case 'perceptor':
      case 'layer':
      case 'episode':
      case 'proposal':
      case 'signal':
        return { href: '/cognition', label: 'Open the network' };
      case 'note':
        return { href: '/knowledge', label: 'Open the vault' };
      case 'experiment':
      case 'decision':
      case 'outcome':
        return { href: '/orders', label: 'Open execution' };
      case 'finding':
        return { href: '/audit', label: 'Open the audit trail' };
      case 'job':
      case 'deployment':
        return { href: '/health', label: 'Open system health' };
      default:
        return null;
    }
  })();
  if (!target) return null;
  return (
    <a
      href={target.href}
      className="rounded border border-white/10 px-1.5 py-0.5 text-[10.5px] text-[#8ea0c4] transition-colors hover:border-white/25 hover:text-white"
    >
      {target.label}
    </a>
  );
}

function RelationList({ title, rows, onSelect }: { title: string; rows: NodeRelationRow[]; onSelect: (id: string) => void }) {
  if (rows.length === 0) return null;
  // Group by relation so "12 routes exposed by this controller" reads as one
  // heading and twelve rows, not twelve repetitions of the same phrase.
  const grouped = new Map<string, NodeRelationRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.label) ?? [];
    list.push(row);
    grouped.set(row.label, list);
  }
  return (
    <div className="mb-1">
      <div className="px-3 pt-2 text-[9px] uppercase tracking-[0.1em] text-[#4b5b7d]">{title}</div>
      {Array.from(grouped.entries()).map(([label, group]) => (
        <div key={label} className="mt-1">
          <div className="px-3 text-[10px] text-[#64769c]">
            {label} <span className="font-mono">({group.length})</span>
          </div>
          <ul>
            {group.slice(0, 25).map((row) => (
              <li key={row.edge.id}>
                <button
                  type="button"
                  onClick={() => onSelect(row.node.id)}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-white/[0.04]"
                  title={row.edge.evidence}
                >
                  <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: nodeColor(row.node) }} />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[#c6d0e2]">{row.node.label}</span>
                  {row.edge.state !== 'normal' && (
                    <span className={`text-[9px] ${row.edge.state === 'contradiction' ? 'text-down' : 'text-amber'}`}>{row.edge.state}</span>
                  )}
                  {/* Edge strength as a miniature bar — the same quantity the
                      canvas renders as line width. */}
                  <span className="h-1 w-6 shrink-0 overflow-hidden rounded-full bg-white/[0.08]">
                    <span className="block h-full rounded-full bg-teal" style={{ width: `${Math.round(row.edge.strength * 100)}%` }} />
                  </span>
                </button>
              </li>
            ))}
            {group.length > 25 && <li className="px-3 py-1 text-[10px] text-[#4b5b7d]">…and {group.length - 25} more</li>}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Measure({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="bg-[#0d1524] px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-[0.08em] text-[#64769c]">{label}</div>
      <div className="font-mono text-[13px] text-[#e2e8f0]">{value.toFixed(2)}</div>
      <div className="text-[9px] text-[#4b5b7d]">{hint}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-white/[0.03] py-0.5">
      <dt className="shrink-0 text-[10.5px] text-[#64769c]">{label}</dt>
      <dd className="min-w-0 break-words text-right text-[11px] text-[#c6d0e2]">{children}</dd>
    </div>
  );
}

function Chip({ children, color, tone, title }: { children: React.ReactNode; color?: string; tone?: string; title?: string }) {
  const toneClass =
    tone && /fail|error|quarantin/.test(tone)
      ? 'border-down/40 text-down'
      : tone && /degrad|stale|armed|warn|undeclared/.test(tone)
        ? 'border-amber/40 text-amber'
        : tone && /health|running|ok/.test(tone)
          ? 'border-up/40 text-up'
          : 'border-white/12 text-[#8ea0c4]';
  return (
    <span title={title} className={`rounded border px-1.5 py-px text-[10px] ${toneClass}`} style={color ? { borderColor: `${color}66`, color } : undefined}>
      {children}
    </span>
  );
}

function Action({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-white/10 px-1.5 py-0.5 text-[10.5px] text-[#8ea0c4] transition-colors hover:border-white/25 hover:text-white"
    >
      {children}
    </button>
  );
}

/** `avgLatencyMs` → `Avg latency ms`. Field names come from the backend and are
 *  rendered as-is elsewhere; here they are read by a person. */
function humanise(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function renderValue(value: unknown): React.ReactNode {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return <span className="font-mono text-[10px]">{value.slice(0, 8).map(String).join(', ')}{value.length > 8 ? ` +${value.length - 8}` : ''}</span>;
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return <span className="font-mono">{Number.isInteger(value) ? value.toLocaleString() : value.toFixed(3)}</span>;
  if (typeof value === 'object') return <span className="font-mono text-[10px]">{JSON.stringify(value).slice(0, 120)}</span>;
  return <span className="font-mono text-[10px]">{String(value)}</span>;
}
