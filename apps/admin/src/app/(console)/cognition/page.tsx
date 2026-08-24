'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { admin, type PerceptorRow, type ProposalRow } from '@/lib/api';
import { GraphCanvas, type GraphCanvasHandle } from '@/components/graph/GraphCanvas';
import { GraphControls } from '@/components/graph/GraphControls';
import { GraphLegend } from '@/components/graph/GraphLegend';
import { NodeInspector } from '@/components/graph/NodeInspector';
import { SignalPathStrip } from '@/components/graph/SignalPathStrip';
import { NeuralLayers, WeightBar, perceptorTone } from '@/components/NeuralLayers';
import { DOMAIN_COLOR, NEURAL_VIEW_KINDS, type GraphEvent } from '@/lib/graph';
import { useSystemGraph } from '@/lib/useSystemGraph';
import {
  Empty, MetricCard, Panel, Pill, StatusIndicator, Table, Td, Th,
  ago, fmtMs, fmtNum, fmtTime, usePolling,
} from '@/components/ui';

/**
 * Perceptrons & Neural Network — the live projection of the system graph.
 *
 * ## What changed, and why
 *
 * The old page drew the network as five boxes with arrows between them:
 * domains → L1 → L2 → L3 → L4 → proposals. That diagram was accurate and it
 * was also the whole picture, which made the network look like a pipeline with
 * four stages rather than a system with hundreds of live parts. It also had no
 * connection to the platform the network is watching: the routes, the agents,
 * the market data, the errors — none of it appeared.
 *
 * The four layers are still here and still meaningful; the `NeuralLayers`
 * panel below renders their real counters, and the layer nodes are on the
 * canvas with their real throughput. What changed is that they now sit inside
 * the actual topology, in the column that matches their place in the signal
 * path, wired to the perceptors that feed them and the concepts they associate.
 *
 * ## The signal path is real
 *
 *   external source → route → controller → service → agent → perceptor →
 *   neural layer → concept → proposal → outcome
 *
 * Those columns are not a drawing. Each node is placed by its kind, and each
 * edge between them was recorded: the route→agent edge comes from
 * `AiCallLog.requestId` correlating back to `ApiCallLog`, the agent→agent edge
 * from `AgentActivity.peer`, the perceptor→layer edge from percepts actually
 * counted, the layer→layer edge from one layer's outputs being the next
 * layer's inputs. A pulse travels an edge only when a real event says so.
 *
 * ## Same data as /knowledge
 *
 * One graph, two projections. This page opens in signal columns; the Knowledge
 * Graph opens in the free layout. Every node id, filter and inspector field is
 * shared, and a node selected here is the same node there.
 */

export default function AdminCognitionPage() {
  const graph = useSystemGraph({
    kinds: NEURAL_VIEW_KINDS,
    // Full detail from the start: the point of this page is density, and the
    // signal path runs through routes and signals, which are tier-2 nodes.
    maxTier: 2,
    limit: 500,
  });
  const [mode, setMode] = useState<'force' | 'layered'>('layered');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [proposalStatus, setProposalStatus] = useState('pending');

  const canvasRef = useRef<GraphCanvasHandle | null>(null);
  const onReady = useCallback((handle: GraphCanvasHandle) => {
    canvasRef.current = handle;
  }, []);

  // The network's own state, from the cognition endpoints. Kept separate from
  // the graph because these are the network's INTERNAL counters — layer
  // throughput, synapse weights, pending traces — which are not graph
  // entities and would be a poor fit for one.
  const overview = usePolling(() => admin.cognition.overview(), [], 10_000);
  const perceptors = usePolling(() => admin.cognition.perceptors(), [], 15_000);
  const domains = usePolling(() => admin.cognition.domains(24), [], 20_000);
  const synapses = usePolling(() => admin.cognition.synapses({ limit: 40 }), [], 30_000);
  const proposals = usePolling(() => admin.cognition.proposals({ status: proposalStatus || undefined, limit: 50 }), [proposalStatus], 15_000);
  const episodes = usePolling(() => admin.cognition.episodes({ limit: 20, hours: 24 }), [], 15_000);

  const snap = overview.data;
  const sensors = useMemo(() => perceptors.data ?? [], [perceptors.data]);
  const running = Boolean(snap?.enabled && snap.isLeader);
  const totalPerHour = (domains.data ?? []).reduce((sum, row) => sum + row.perHour, 0);
  const pendingCount = proposalStatus === 'pending' ? (proposals.data?.length ?? null) : null;

  const { slice, meta, events, selected, setSelected } = graph;

  const focus = useCallback((id: string) => {
    setFocusId(id);
    setSelected([id]);
    setTimeout(() => setFocusId(null), 400);
  }, [setSelected]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      overview.refresh();
      proposals.refresh();
      synapses.refresh();
      perceptors.refresh();
      graph.refresh();
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  // Live throughput, counted from the real event stream rather than polled.
  const [eventsPerMinute, setEventsPerMinute] = useState(0);
  useEffect(() => {
    const window = 60_000;
    const recount = () => {
      const cutoff = Date.now() - window;
      setEventsPerMinute(events.filter((event) => event.at >= cutoff).length);
    };
    recount();
    const timer = setInterval(recount, 4_000);
    return () => clearInterval(timer);
  }, [events]);

  const errorEvents = events.filter((event) => event.status === 'error').length;

  return (
    <div className="mx-auto flex min-h-[calc(100vh-1px)] max-w-[1900px] flex-col gap-3 p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold uppercase tracking-tight">Perceptrons &amp; Neural Network</h1>
          <p className="text-[12px] text-muted">
            The same graph as the Knowledge Centre, laid out along the real signal path — sources, routes, services, agents,
            perceptors, the four layers, and what they produce. Pulses are real backend events.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <StatusIndicator
            label={running ? 'Network running' : snap?.enabled ? 'Not leader' : 'Registered — idle'}
            tone={running ? 'good' : snap?.enabled ? 'warn' : 'idle'}
            pulse={running}
          />
          <StatusIndicator
            label={graph.live ? `${eventsPerMinute} events/min` : 'Stream offline'}
            tone={graph.live ? 'good' : 'bad'}
            pulse={graph.live && !graph.paused}
          />
          <button
            type="button"
            disabled={!snap?.enabled || busy !== null}
            onClick={() => void act('run', () => admin.cognition.run())}
            className="rounded-md border border-white/10 px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-white/20 hover:text-text disabled:opacity-40"
          >
            {busy === 'run' ? 'Running…' : 'Run a pass'}
          </button>
        </div>
      </header>

      {snap && !running && (
        <div className="rounded-xl border border-amber/30 bg-amber/[0.06] px-4 py-2.5 text-[12px] text-amber">
          {!snap.enabled ? (
            <>
              The network is <strong>registered but not running</strong> — {sensors.length} perceptors declared, no passes being
              made. Set <code className="text-[11px]">COGNITION_ENABLED=true</code> to start it. The topology below is still
              real; the perceptor and layer nodes simply have no activity to show.
            </>
          ) : (
            <>This instance holds the roster but is <strong>not the leader</strong>. Weights and episodes are shared; live layer counters are not.</>
          )}
        </div>
      )}

      <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <MetricCard label="Graph nodes" accent="violet" value={meta ? fmtNum(meta.totals.nodes) : '—'} sub={`${fmtNum(slice?.nodes.length ?? 0)} in view`} />
        <MetricCard label="Perceptors" accent="violet" value={fmtNum(sensors.length)} sub={`${sensors.filter((sensor) => sensor.enabled).length} enabled`} />
        <MetricCard label="Percepts / hr" accent="teal" live={running} value={domains.data ? fmtNum(Math.round(totalPerHour)) : '—'} sub="derived, 24h" />
        <MetricCard label="Synapses" accent="teal" value={fmtNum(snap?.synapses.total ?? 0)} sub={`${fmtNum(snap?.synapses.proven ?? 0)} proven`} />
        <MetricCard label="Mean weight" accent="green" value={snap ? snap.synapses.meanWeight.toFixed(2) : '—'} sub="not per-node activation" />
        <MetricCard label="Live events" accent="teal" live={graph.live} value={fmtNum(eventsPerMinute)} sub="per minute, real" />
        <MetricCard
          label="Errors seen"
          accent={errorEvents > 0 ? 'red' : 'slate'}
          value={fmtNum(errorEvents)}
          sub="in the live buffer"
          tone={errorEvents > 0 ? 'bad' : 'neutral'}
        />
      </div>

      {/* The living topology. Given the tallest panel on the page because it is
          the page — everything below it is a table view of the same facts. */}
      <div className="grid min-h-[620px] gap-3 xl:grid-cols-[264px_1fr_330px]">
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
              availableKinds={NEURAL_VIEW_KINDS}
              loadedCount={slice?.nodes.length ?? 0}
            />
          </div>
        </Panel>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/[0.06] bg-card">
          <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
            <div className="text-[11.5px] text-muted">
              {mode === 'layered'
                ? 'Signal columns — left to right is the real request path'
                : 'Free layout — the same nodes, clustered by domain'}
            </div>
            <div className="text-[10.5px] text-faint">
              {slice ? `${fmtNum(slice.nodes.length)} nodes · ${fmtNum(slice.edges.length)} edges` : ''}
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
          <Panel title="Node inspector" subtitle="Real fields for the selected node" className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1">
              <NodeInspector nodeId={selected[0] ?? null} onFocus={focus} onExpand={graph.expand} onSelect={(id) => setSelected([id])} />
            </div>
          </Panel>

          <Panel title="Signal feed" subtitle="Every row is one real backend event" className="flex h-[220px] shrink-0 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-auto">
              <SignalFeed events={events} paused={graph.paused} onSelect={(id) => setSelected([id])} />
            </div>
          </Panel>
        </div>
      </div>

      {/* One real request, traced hop by hop through the nodes above. */}
      <SignalPathStrip onSelectNode={focus} />

      {/* The network's own internals. Not graph entities — these are counters
          the network keeps about itself, and they belong in a table. */}
      <div className="grid gap-3 lg:grid-cols-3">
        <div>{snap && <NeuralLayers layers={snap.layers} perceptors={sensors} running={running} />}</div>

        <Panel title="Learned weights" subtitle="Strongest first. Unproven = no outcome has scored it.">
          {(synapses.data ?? []).length === 0 ? (
            <Empty>{synapses.loading ? 'Loading…' : 'Nothing learned yet.'}</Empty>
          ) : (
            <div className="max-h-[300px] overflow-auto">
              <Table head={<><Th>Association</Th><Th className="text-right">Weight</Th><Th className="text-right">Fired / scored</Th></>}>
                {(synapses.data ?? []).map((synapse) => (
                  <tr key={synapse.id} className="hover:bg-white/[0.02]">
                    <Td className="max-w-[240px]">
                      <div className="truncate text-[11.5px]" title={`${synapse.source} → ${synapse.target}`}>
                        <span className="text-muted">{shorten(synapse.source)}</span>
                        <span className="px-1 text-faint">→</span>
                        <span>{shorten(synapse.target)}</span>
                      </div>
                      <div className="text-[10px] text-faint">
                        {synapse.layer.replace(/^L\d_/, '')} · {synapse.lastActivatedAt ? `fired ${ago(synapse.lastActivatedAt)}` : 'never fired'}
                      </div>
                    </Td>
                    <Td className="text-right"><WeightBar weight={synapse.weight} reinforcements={synapse.reinforcements} /></Td>
                    <Td className="num text-right text-[11px] text-muted">{fmtNum(synapse.activations)} / {fmtNum(synapse.reinforcements)}</Td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
        </Panel>

        <Panel
          title="Proposals"
          subtitle="The network never acts. It proposes, and an operator decides."
          right={
            <select
              value={proposalStatus}
              onChange={(event) => setProposalStatus(event.target.value)}
              className="rounded-md border border-white/10 bg-black/40 px-2 py-0.5 text-[11px] outline-none focus:border-teal"
            >
              <option value="pending">Pending</option>
              <option value="accepted">Accepted</option>
              <option value="dismissed">Dismissed</option>
              <option value="done">Done</option>
              <option value="">All</option>
            </select>
          }
        >
          {(proposals.data ?? []).length === 0 ? (
            <Empty>{proposals.loading ? 'Loading…' : 'Nothing proposed. A quiet queue is normal.'}</Empty>
          ) : (
            <div className="max-h-[300px] divide-y divide-white/[0.04] overflow-auto">
              {(proposals.data ?? []).map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  busy={busy === proposal.id}
                  onInspect={() => focus(`proposal:${proposal.id}`)}
                  onResolve={(status) => void act(proposal.id, () => admin.cognition.resolveProposal(proposal.id, status))}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Perceptors" subtitle="Every registered sensor, including the disabled and the silent.">
        {sensors.length === 0 ? (
          <Empty>{perceptors.loading ? 'Loading…' : 'No perceptors registered.'}</Empty>
        ) : (
          <Table
            head={<>
              <Th>Sensor</Th><Th>Domain</Th><Th>Status</Th><Th>Cadence</Th>
              <Th className="text-right">Last percept</Th><Th className="text-right">Mean salience</Th><Th className="text-right">Total</Th><Th />
            </>}
          >
            {sensors.map((sensor) => (
              <PerceptorRowView
                key={sensor.id}
                sensor={sensor}
                busy={busy === sensor.id}
                onInspect={() => focus(`perceptor:${sensor.id}`)}
                onToggle={() => void act(sensor.id, () => admin.cognition.setPerceptorEnabled(sensor.id, !sensor.enabled))}
              />
            ))}
          </Table>
        )}
      </Panel>

      <Panel title="Recent passes" subtitle="Every pass the network has made in the last 24 hours">
        {(episodes.data ?? []).length === 0 ? (
          <Empty>{episodes.loading ? 'Loading…' : 'No passes in the last 24 hours.'}</Empty>
        ) : (
          <Table
            head={<>
              <Th>Started</Th><Th>Trigger</Th><Th>Domain</Th><Th>Status</Th>
              <Th className="text-right">Sensed</Th><Th className="text-right">Promoted</Th><Th className="text-right">Duration</Th><Th>Outcome</Th>
            </>}
          >
            {(episodes.data ?? []).map((episode) => {
              const durationMs = episode.finishedAt
                ? new Date(episode.finishedAt).getTime() - new Date(episode.startedAt).getTime()
                : null;
              return (
                <tr key={episode.id} className="cursor-pointer hover:bg-white/[0.02]" onClick={() => focus(`episode:${episode.episodeId}`)}>
                  <Td className="text-[11px] text-muted">{fmtTime(episode.startedAt)}</Td>
                  <Td className="text-[11px]">{episode.trigger}</Td>
                  <Td className="text-[11px] text-muted">{episode.domain ?? 'all'}</Td>
                  <Td>
                    <Pill tone={episode.status === 'ok' ? 'good' : episode.status === 'degraded' ? 'warn' : episode.status === 'error' ? 'bad' : 'neutral'}>
                      {episode.status}
                    </Pill>
                  </Td>
                  <Td className="num text-right">{fmtNum(episode.perceptCount)}</Td>
                  <Td className="num text-right">{fmtNum(episode.promotedCount)}</Td>
                  <Td className="num text-right text-muted">{fmtMs(durationMs)}</Td>
                  <Td>
                    {episode.reward === null ? (
                      <span className="text-[10.5px] text-faint">unscored</span>
                    ) : (
                      <Pill tone={episode.reward >= 0.7 ? 'good' : episode.reward <= 0.3 ? 'bad' : 'neutral'}>{episode.reward.toFixed(2)}</Pill>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Panel>
    </div>
  );
}

function SignalFeed({ events, paused, onSelect }: { events: GraphEvent[]; paused: boolean; onSelect: (id: string) => void }) {
  if (paused) {
    return <p className="p-4 text-center text-[11px] text-faint">Paused. Events keep arriving; the network is not lighting them up.</p>;
  }
  if (events.length === 0) {
    return <p className="p-4 text-center text-[11px] text-faint">Connected. No signal yet — a still network means a still system.</p>;
  }
  return (
    <ul className="divide-y divide-white/[0.04]">
      {events.map((event) => (
        <li key={event.id} className="admin-row-flash px-3 py-1.5">
          <button
            type="button"
            onClick={() => event.nodeIds[0] && onSelect(event.nodeIds[0])}
            disabled={event.nodeIds.length === 0}
            className="block w-full text-left disabled:cursor-default"
          >
            <div className="flex items-baseline gap-1.5">
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: event.status === 'error' ? '#ef5350' : DOMAIN_COLOR[event.domain] }}
              />
              <span className={`truncate text-[11px] ${event.status === 'error' ? 'text-down' : 'text-[#c6d0e2]'}`}>{event.summary}</span>
              <span className="num ml-auto shrink-0 text-[9.5px] text-faint">{fmtTime(event.at)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PerceptorRowView({
  sensor,
  busy,
  onToggle,
  onInspect,
}: {
  sensor: PerceptorRow;
  busy: boolean;
  onToggle: () => void;
  onInspect: () => void;
}) {
  const status = sensor.enabled ? (sensor.health?.status ?? 'healthy') : 'disabled';
  return (
    <tr className="hover:bg-white/[0.02]">
      <Td className="max-w-[280px]">
        <button type="button" onClick={onInspect} className="block max-w-full text-left" title="Show this sensor on the network">
          <div className="truncate text-[12px] hover:text-teal">{sensor.label}</div>
          <div className="truncate text-[10px] text-faint" title={sensor.description}>{sensor.description}</div>
        </button>
      </Td>
      <Td className="text-[11px] text-muted">{sensor.domain}</Td>
      <Td>
        <Pill tone={perceptorTone(status)}>{status}</Pill>
        {sensor.health?.lastError && (
          <div className="mt-0.5 max-w-[200px] truncate text-[10px] text-down" title={sensor.health.lastError}>{sensor.health.lastError}</div>
        )}
      </Td>
      <Td className="text-[11px] text-muted">
        {sensor.cadence === 'interval' && sensor.expectedIntervalMs ? `every ${Math.round(sensor.expectedIntervalMs / 1000)}s` : sensor.cadence}
      </Td>
      <Td className="text-right text-[11px] text-muted">{ago(sensor.health?.lastPerceptAt ?? null)}</Td>
      <Td className="num text-right text-[11px] text-muted">{(sensor.health?.meanSalience ?? 0).toFixed(2)}</Td>
      <Td className="num text-right text-[11px]">{fmtNum(sensor.health?.totalPercepts ?? 0)}</Td>
      <Td className="text-right">
        <button
          type="button"
          disabled={busy}
          onClick={onToggle}
          className="rounded border border-white/10 px-1.5 py-px text-[10.5px] text-muted transition-colors hover:border-white/25 hover:text-text disabled:opacity-40"
        >
          {busy ? '…' : sensor.enabled ? 'Disable' : 'Enable'}
        </button>
      </Td>
    </tr>
  );
}

function ProposalCard({
  proposal,
  busy,
  onResolve,
  onInspect,
}: {
  proposal: ProposalRow;
  busy: boolean;
  onResolve: (status: 'accepted' | 'dismissed' | 'done') => void;
  onInspect: () => void;
}) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={onInspect} className="min-w-0 text-left" title="Show this proposal on the network">
          <div className="flex items-center gap-2">
            <Pill tone={proposal.kind === 'investigate' ? 'warn' : 'info'}>{proposal.kind}</Pill>
            <span className="text-[10.5px] text-faint">{proposal.domain}</span>
            <span className="num text-[10.5px] text-faint">{(proposal.confidence * 100).toFixed(0)}%</span>
          </div>
          <div className="mt-1 text-[12px] hover:text-teal">{proposal.title}</div>
          <div className="mt-0.5 text-[10.5px] text-faint">
            {proposal.perceptIds.length} percept{proposal.perceptIds.length === 1 ? '' : 's'} · {ago(proposal.createdAt)}
          </div>
        </button>
        {proposal.status === 'pending' ? (
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => onResolve('accepted')}
              className="rounded border border-up/40 px-1.5 py-px text-[10.5px] text-up transition-colors hover:bg-up/10 disabled:opacity-40"
            >
              Useful
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onResolve('dismissed')}
              title="Tells the network this finding was wrong — the only negative signal it gets"
              className="rounded border border-down/40 px-1.5 py-px text-[10.5px] text-down transition-colors hover:bg-down/10 disabled:opacity-40"
            >
              Wrong
            </button>
          </div>
        ) : (
          <Pill tone={proposal.status === 'dismissed' ? 'bad' : 'good'}>{proposal.status}</Pill>
        )}
      </div>
    </div>
  );
}

function shorten(endpoint: string): string {
  const [, ...rest] = endpoint.split(':');
  return rest.join(':') || endpoint;
}
