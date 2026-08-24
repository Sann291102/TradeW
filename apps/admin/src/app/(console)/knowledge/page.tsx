'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { GraphCanvas, type GraphCanvasHandle } from '@/components/graph/GraphCanvas';
import { GraphControls } from '@/components/graph/GraphControls';
import { GraphLegend } from '@/components/graph/GraphLegend';
import { NodeInspector } from '@/components/graph/NodeInspector';
import { DOMAIN_COLOR, KNOWLEDGE_VIEW_KINDS, type GraphEvent } from '@/lib/graph';
import { useSystemGraph } from '@/lib/useSystemGraph';
import { MetricCard, Panel, StatusIndicator, ago, fmtNum, fmtTime } from '@/components/ui';

/**
 * The Knowledge Graph — the investigative projection of the system graph.
 *
 * ## What changed, and why
 *
 * This page used to draw the markdown link graph of `knowledge/` and nothing
 * else: 105 notes, one relationship type ("this file links to that file"), no
 * connection to anything the platform actually does. It was a picture of the
 * engineering vault, labelled as the knowledge graph of a trading system.
 *
 * It now draws the whole system: the services and modules that booted, the
 * routes they serve and the traffic over them, the agents and models that
 * traffic reaches, the perceptors watching it, the concepts the network has
 * learned, the experiments the execution loop is running and the outcomes that
 * scored them — and the vault, which is now one cluster inside that rather
 * than the entire picture.
 *
 * Every node comes from code that is running, a row that was persisted, or a
 * file on disk. The three origins are labelled on every node (`source`), and
 * there is no fourth.
 *
 * ## Its relationship to the Neural Network page
 *
 * The same data, laid out differently. This page opens on the free force
 * layout, where structure finds its own shape and domains separate into
 * clusters — the view for "what is connected to what". `/cognition` opens the
 * same graph in signal columns, for "what is moving through it right now".
 * Switching the projection here is one control, and a node id means the same
 * thing on both.
 */

export default function AdminKnowledgePage() {
  const graph = useSystemGraph({
    // Opens at the middle tier — services, agents and concepts, not four
    // hundred routes. The camera and the controls take it from there.
    maxTier: 1,
    limit: 260,
    kinds: [],
  });
  const [mode, setMode] = useState<'force' | 'layered'>('force');
  const [focusId, setFocusId] = useState<string | null>(null);
  const canvasRef = useRef<GraphCanvasHandle | null>(null);
  const onReady = useCallback((handle: GraphCanvasHandle) => {
    canvasRef.current = handle;
  }, []);

  const { slice, meta, events, selected, setSelected } = graph;

  const focus = useCallback((id: string) => {
    setFocusId(id);
    setSelected([id]);
    // Cleared so a repeat search for the same node fires the camera again.
    setTimeout(() => setFocusId(null), 400);
  }, [setSelected]);

  const stats = useMemo(() => {
    const nodes = slice?.nodes ?? [];
    const edges = slice?.edges ?? [];
    const contradictions = edges.filter((edge) => edge.state === 'contradiction').length;
    const warnings = edges.filter((edge) => edge.state === 'warning').length;
    const activeNodes = nodes.filter((node) => node.activity > 0.15).length;
    return { contradictions, warnings, activeNodes, loaded: nodes.length, edges: edges.length };
  }, [slice]);

  const degraded = meta?.degraded ?? [];

  return (
    <div className="mx-auto flex h-[calc(100vh-1px)] max-w-[1900px] flex-col gap-3 p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Knowledge Graph</h1>
          <p className="text-[12px] text-muted">
            Everything this platform knows about itself — services, routes, agents, concepts, experiments and outcomes, as one
            connected graph. Every node comes from running code, a persisted row, or the vault.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusIndicator
            label={graph.live ? 'Live — streaming real events' : graph.error ? 'Stream disconnected' : 'Connecting…'}
            tone={graph.live ? 'good' : graph.error ? 'bad' : 'idle'}
            pulse={graph.live && !graph.paused}
          />
          <span className="num text-[11px] text-faint">
            snapshot {slice ? ago(slice.builtAt) : '—'}
            {graph.lastLoadedAt ? ` · loaded ${fmtTime(graph.lastLoadedAt)}` : ''}
          </span>
        </div>
      </header>

      {graph.error && (
        <div className="rounded-lg border border-down/40 bg-down/[0.06] px-4 py-2 text-[12px] text-down">{graph.error}</div>
      )}
      {degraded.length > 0 && (
        <div className="rounded-lg border border-amber/40 bg-amber/[0.06] px-4 py-2 text-[12px] text-amber">
          Could not read {degraded.join(', ')} on the last build. Those parts of the graph are missing because a query failed —
          not because there is nothing there.
        </div>
      )}

      <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="Nodes" accent="teal" value={meta ? fmtNum(meta.totals.nodes) : '—'} sub={`${fmtNum(stats.loaded)} loaded here`} live={graph.live} />
        <MetricCard label="Relationships" accent="violet" value={meta ? fmtNum(meta.totals.edges) : '—'} sub={`${fmtNum(stats.edges)} drawn`} />
        <MetricCard label="Active now" accent="green" value={fmtNum(stats.activeNodes)} sub="nodes with recent activity" live={graph.live} />
        <MetricCard
          label="Contradictions"
          accent={stats.contradictions > 0 ? 'amber' : 'slate'}
          value={fmtNum(stats.contradictions)}
          sub="refuted or losing edges"
          tone={stats.contradictions > 0 ? 'warn' : 'neutral'}
        />
        <MetricCard label="Build time" accent="slate" value={meta ? `${meta.buildMs}ms` : '—'} sub={meta ? `refreshes every ${Math.round(meta.refreshMs / 1000)}s` : undefined} />
      </div>

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[264px_1fr_330px]">
        <Panel title="Explore" subtitle="Filters apply server-side" className="flex min-h-0 flex-col overflow-hidden">
          <div className="min-h-0 flex-1">
          <GraphControls
            meta={meta}
            filter={graph.filter}
            onFilterChange={graph.setFilter}
            live={graph.live}
            paused={graph.paused}
            onPausedChange={graph.setPaused}
            mode={mode}
            onModeChange={setMode}
            onFocusNode={focus}
            onFit={() => canvasRef.current?.fit()}
            onReset={() => {
              graph.collapseAll();
              canvasRef.current?.reset();
            }}
            availableKinds={KNOWLEDGE_VIEW_KINDS}
            loadedCount={stats.loaded}
          />
          </div>
        </Panel>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/[0.06] bg-card">
          <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
            <div className="text-[11.5px] text-muted">
              {graph.expanded.length > 0 ? (
                <>
                  {graph.expanded.length} expanded neighbourhood{graph.expanded.length === 1 ? '' : 's'} ·{' '}
                  <button type="button" onClick={graph.collapseAll} className="underline-offset-2 hover:underline">
                    collapse all
                  </button>
                </>
              ) : (
                'Drag to pan · wheel to zoom · double-click a node to expand · shift-drag to select'
              )}
            </div>
            <div className="text-[10.5px] text-faint">
              {slice ? `${fmtNum(slice.nodes.length)} of ${fmtNum(slice.totals.nodes)} nodes` : ''}
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <GraphCanvas
              slice={slice}
              mode={mode}
              selected={selected}
              onSelectionChange={setSelected}
              onExpand={graph.expand}
              onCollapse={graph.collapse}
              events={events}
              truncated={slice?.truncated ?? []}
              focusId={focusId}
              paused={graph.paused}
              onReady={onReady}
            />
          </div>
          <GraphLegend meta={meta} />
        </div>

        <div className="flex min-h-0 flex-col gap-3">
          <Panel
            title="Inspector"
            subtitle={selected.length > 1 ? `${selected.length} selected — inspecting the first` : 'Real fields for the selected node'}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <div className="min-h-0 flex-1">
              <NodeInspector
                nodeId={selected[0] ?? null}
                onFocus={focus}
                onExpand={graph.expand}
                onSelect={(id) => setSelected([id])}
              />
            </div>
          </Panel>

          <Panel title="Live activity" subtitle="Real backend events, newest first" className="flex h-[228px] shrink-0 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-auto">
              <EventFeed events={events} paused={graph.paused} onSelect={(id) => setSelected([id])} />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/**
 * The live feed.
 *
 * Every row is one real platform event: an HTTP request served, an LLM call
 * settled, an agent transition, a vault write. There is no synthetic heartbeat
 * in this list, which is what makes "nothing is moving" readable as "nothing
 * is happening" rather than "the feed is broken".
 */
function EventFeed({ events, paused, onSelect }: { events: GraphEvent[]; paused: boolean; onSelect: (id: string) => void }) {
  if (paused) {
    return <p className="p-4 text-center text-[11px] text-faint">Paused. Events are still arriving; the graph is not lighting them up.</p>;
  }
  if (events.length === 0) {
    return <p className="p-4 text-center text-[11px] text-faint">Connected. Nothing has happened yet — a quiet feed means a quiet system.</p>;
  }
  return (
    <ul className="divide-y divide-white/[0.04] overflow-auto">
      {events.map((event) => (
        <li key={event.id} className="admin-row-flash px-3 py-1.5">
          <button
            type="button"
            onClick={() => event.nodeIds[0] && onSelect(event.nodeIds[0])}
            disabled={event.nodeIds.length === 0}
            className="block w-full text-left disabled:cursor-default"
          >
            <div className="flex items-baseline gap-1.5">
              <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: event.status === 'error' ? '#ef5350' : DOMAIN_COLOR[event.domain] }} />
              <span className={`truncate text-[11px] ${event.status === 'error' ? 'text-down' : 'text-[#c6d0e2]'}`}>{event.summary}</span>
              <span className="num ml-auto shrink-0 text-[9.5px] text-faint">{fmtTime(event.at)}</span>
            </div>
            <div className="pl-3 font-mono text-[9.5px] text-faint">{event.kind}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}
