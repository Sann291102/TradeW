'use client';

import { useEffect, useMemo, useState } from 'react';
import { admin, type PerceptDomain, type PerceptorRow, type ProposalRow } from '@/lib/api';
import { NeuralLayers, WeightBar, perceptorTone } from '@/components/NeuralLayers';
import { CognitionGraph, CognitionNodeDetail, type CognitionNode } from '@/components/CognitionGraph';
import {
  Donut, Empty, MetricCard, Panel, Pill, SectionTitle, StatusDot, StatusIndicator, Table, Td, Th,
  ago, fmtMs, fmtNum, fmtTime, usePolling,
} from '@/components/ui';

const DOMAIN_ORDER = ['market', 'application', 'assistant', 'learning', 'platform'];

export default function AdminCognitionPage() {
  const [domain, setDomain] = useState<PerceptDomain | ''>('');
  const [proposalStatus, setProposalStatus] = useState('pending');
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<CognitionNode | null>(null);
  const [stamp, setStamp] = useState<number | null>(null);

  const overview = usePolling(() => admin.cognition.overview(), [], 10_000);
  const perceptors = usePolling(() => admin.cognition.perceptors(), [], 15_000);
  const domains = usePolling(() => admin.cognition.domains(24), [], 20_000);
  const episodes = usePolling(() => admin.cognition.episodes({ limit: 30, domain: domain || undefined, hours: 24 }), [domain], 15_000);
  const synapses = usePolling(() => admin.cognition.synapses({ limit: 60 }), [], 30_000);
  const percepts = usePolling(() => admin.cognition.percepts({ limit: 12, domain: domain || undefined, hours: 24 }), [domain], 15_000);
  const proposals = usePolling(() => admin.cognition.proposals({ status: proposalStatus || undefined, limit: 50 }), [proposalStatus], 15_000);

  useEffect(() => { if (overview.data) setStamp(Date.now()); }, [overview.data]);

  const snap = overview.data;
  const sensors = perceptors.data ?? [];
  const running = Boolean(snap?.enabled && snap.isLeader);
  const pendingCount = proposalStatus === 'pending' ? (proposals.data?.length ?? null) : null;
  const totalPerHour = (domains.data ?? []).reduce((s, d) => s + d.perHour, 0);

  const statusValue = running ? 'Running' : snap?.enabled ? 'Not leader' : snap ? 'Idle' : '—';
  const statusTone = running ? 'good' : snap?.enabled ? 'warn' : 'idle';

  // Perceptor domains: merge real roster health with the real percept-rate endpoint.
  const domainRows = useMemo(() => {
    const rate = new Map((domains.data ?? []).map((d) => [d.domain, d]));
    const byDom = new Map<string, { total: number; healthy: number; enabled: number; anyFail: boolean; anyStale: boolean }>();
    for (const p of sensors) {
      const e = byDom.get(p.domain) ?? { total: 0, healthy: 0, enabled: 0, anyFail: false, anyStale: false };
      e.total += 1;
      if (p.enabled) e.enabled += 1;
      if (p.enabled && p.health?.status === 'healthy') e.healthy += 1;
      if (p.health?.status === 'quarantined' || p.health?.status === 'failing') e.anyFail = true;
      if (p.health?.status === 'stale') e.anyStale = true;
      byDom.set(p.domain, e);
    }
    return DOMAIN_ORDER.filter((d) => byDom.has(d)).map((d) => {
      const c = byDom.get(d)!;
      const r = rate.get(d);
      const tone = c.enabled === 0 ? 'idle' : c.anyFail ? 'bad' : c.anyStale ? 'warn' : 'good';
      return { domain: d, ...c, tone: tone as 'good' | 'warn' | 'bad' | 'idle', percepts: r?.percepts ?? 0, perHour: r?.perHour ?? 0, meanSalience: r?.meanSalience ?? 0, lastAt: r?.lastAt ?? null };
    });
  }, [sensors, domains.data]);

  // Synapse distribution: authoritative whole-population split from the overview.
  const synapseSegments = snap ? [
    { label: 'Proven', value: snap.synapses.proven, color: '#2dd4bf' },
    { label: 'Unproven', value: snap.synapses.unproven, color: '#64748b' },
  ] : [];

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      overview.refresh(); proposals.refresh(); synapses.refresh(); perceptors.refresh();
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-[1700px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold uppercase tracking-tight">Perceptors &amp; Neural Network</h1>
          <p className="text-[12px] text-muted">Live perception signals flow through neural layers to generate proposals.</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusIndicator label={running ? 'Network running' : snap?.enabled ? 'Not leader' : 'Registered — idle'} tone={statusTone} pulse={running} />
          <span className="num text-[11px] text-faint">updated {stamp ? fmtTime(stamp) : '—'}</span>
          <select value={domain} onChange={(e) => setDomain(e.target.value as PerceptDomain | '')}
            className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal">
            <option value="">All domains</option>
            <option value="market">Market</option><option value="application">Application</option>
            <option value="assistant">Assistant</option><option value="learning">Learning</option><option value="platform">Platform</option>
          </select>
          <button type="button" disabled={!snap?.enabled || busy !== null}
            onClick={() => void act('run', () => admin.cognition.run(domain || undefined))}
            className="rounded-md border border-white/10 px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-white/20 hover:text-text disabled:opacity-40">
            {busy === 'run' ? 'Running…' : 'Run a pass'}
          </button>
        </div>
      </header>

      {snap && !running && (
        <div className="rounded-xl border border-amber/30 bg-amber/[0.06] px-4 py-2.5 text-[12px] text-amber">
          {!snap.enabled
            ? <>The network is <strong>registered but not running</strong> — {sensors.length} perceptors declared, no passes being made. Set <code className="text-[11px]">COGNITION_ENABLED=true</code> to start it.</>
            : <>This instance holds the roster but is <strong>not the leader</strong>. Weights and episodes are shared; live layer counters are not.</>}
        </div>
      )}

      {/* Top KPIs — every value real; gaps labelled honestly. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <MetricCard label="Perceptors" accent="violet" value={fmtNum(sensors.length)} sub={`${sensors.filter((s) => s.enabled).length} enabled`} />
        <MetricCard label="Percepts / hr" accent="teal" live={running} value={domains.data ? fmtNum(Math.round(totalPerHour)) : '—'} sub="derived, 24h" />
        <MetricCard label="Neural layers" accent="violet" value={fmtNum(snap?.layers.length ?? 0)} />
        <MetricCard label="Synapses" accent="teal" value={fmtNum(snap?.synapses.total ?? 0)} sub={`${fmtNum(snap?.synapses.proven ?? 0)} proven`} />
        <MetricCard label="Mean weight" accent="green" value={snap ? snap.synapses.meanWeight.toFixed(2) : '—'} sub="not per-node activation" />
        <MetricCard label="Outcomes" accent="slate" value={fmtNum(snap?.synapses.totalReinforcements ?? 0)} sub="reinforcements" />
        <MetricCard label="Awaiting" accent={(snap?.synapses.pendingTraces ?? 0) > 5000 ? 'amber' : 'slate'} value={fmtNum(snap?.synapses.pendingTraces ?? 0)} sub="pending traces" tone={(snap?.synapses.pendingTraces ?? 0) > 5000 ? 'warn' : 'neutral'} />
      </div>

      {/* Main: domains → topology → node inspector. */}
      <div className="grid gap-3 xl:grid-cols-[300px_1fr_300px]">
        <Panel title="Perceptor domains" subtitle="Live ingestion sources">
          {domainRows.length ? (
            <ul className="divide-y divide-white/[0.04]">
              {domainRows.map((d) => (
                <li key={d.domain} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-[12px] capitalize">
                      <StatusDot tone={d.tone} pulse={d.tone === 'good' && running} />{d.domain}
                    </span>
                    <span className="num text-[11px] text-muted">{d.healthy}/{d.total}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[10.5px] text-faint">
                    <span className="num">{d.perHour ? `${fmtNum(d.perHour)}/hr` : '—'} · sal {d.meanSalience.toFixed(2)}</span>
                    <span>{d.lastAt ? ago(d.lastAt) : 'no percepts'}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : <Empty>{perceptors.loading ? 'Loading…' : 'No perceptor domains.'}</Empty>}
        </Panel>

        <Panel title="Neural network topology" subtitle="Domains → four layers → proposals. Edges animate only on live signal.">
          <div className="p-3">
            {snap ? (
              <CognitionGraph perceptors={sensors} layers={snap.layers} running={running} outputCount={pendingCount} onSelect={setSelectedNode} selectedId={selectedNode?.id ?? null} />
            ) : <Empty>{overview.loading ? 'Loading the network…' : 'Network state unavailable.'}</Empty>}
          </div>
        </Panel>

        <Panel title="Node inspector" subtitle="Live fields for the selected node">
          <CognitionNodeDetail node={selectedNode} />
        </Panel>
      </div>

      {/* Lower: layer overview | synapse distribution | recent signal events. */}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-1">{snap && <NeuralLayers layers={snap.layers} perceptors={sensors} running={running} />}</div>

        <Panel title="Synapse distribution" subtitle="Whole-population, from the network snapshot">
          {snap && snap.synapses.total > 0 ? (
            <div className="flex items-center gap-4 p-4">
              <Donut segments={synapseSegments} centerValue={fmtNum(snap.synapses.total)} centerLabel="synapses" />
              <ul className="flex-1 space-y-2 text-[11.5px]">
                <li className="flex items-center justify-between"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-up" />Proven</span><span className="num">{fmtNum(snap.synapses.proven)}</span></li>
                <li className="flex items-center justify-between"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-slate-500" />Unproven</span><span className="num">{fmtNum(snap.synapses.unproven)}</span></li>
                <li className="flex items-center justify-between border-t border-white/[0.06] pt-1.5 text-faint"><span>Mean weight</span><span className="num">{snap.synapses.meanWeight.toFixed(2)}</span></li>
              </ul>
            </div>
          ) : <Empty>{overview.loading ? 'Loading…' : 'Nothing learned yet.'}</Empty>}
        </Panel>

        <Panel title="Recent signal events" subtitle="Latest percepts, newest first">
          {(percepts.data ?? []).length ? (
            <ul className="max-h-[280px] divide-y divide-white/[0.04] overflow-auto">
              {(percepts.data ?? []).map((p) => (
                <li key={p.id} className="px-4 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-[11.5px]">{p.summary || p.kind}</span>
                    <span className="num shrink-0 text-[10px] text-faint">{fmtTime(p.observedAt)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-faint">
                    <Pill tone="info">{p.domain}</Pill><span className="num">sal {p.salience.toFixed(2)}</span>
                    {p.occurrences > 1 && <span className="num">×{p.occurrences}</span>}
                  </div>
                </li>
              ))}
            </ul>
          ) : <Empty>{percepts.loading ? 'Loading…' : running ? 'No percepts in this window.' : 'Network idle — no percepts.'}</Empty>}
        </Panel>
      </div>

      {/* Live signal propagation path (real layer outputs). */}
      <Panel title="Signal propagation path" subtitle="Live stage activity across the four layers">
        <div className="flex flex-wrap items-center gap-2 p-4 text-[11px]">
          <FlowStage label="Data sources" value={domains.data ? `${fmtNum(Math.round(totalPerHour))}/hr` : '—'} active={running && totalPerHour > 0} />
          {(snap?.layers ?? []).slice().sort((a, b) => a.index - b.index).map((l) => (
            <FlowStage key={l.id} label={l.label} value={l.outputs > 0 ? fmtNum(l.outputs) : '—'} active={running && l.outputs > 0} arrow />
          ))}
          <FlowStage label="Proposals" value={pendingCount != null ? fmtNum(pendingCount) : '—'} active={running && (pendingCount ?? 0) > 0} arrow />
        </div>
      </Panel>

      {/* Perceptor roster + weights + proposals + passes. */}
      <Panel title="Perceptors" subtitle="Every registered sensor, including the disabled and the silent.">
        {sensors.length === 0 ? <Empty>{perceptors.loading ? 'Loading…' : 'No perceptors registered.'}</Empty> : (
          <Table head={<>
            <Th>Sensor</Th><Th>Domain</Th><Th>Status</Th><Th>Cadence</Th>
            <Th className="text-right">Last percept</Th><Th className="text-right">Mean salience</Th><Th className="text-right">Total</Th><Th />
          </>}>
            {sensors.map((sensor) => (
              <PerceptorRowView key={sensor.id} sensor={sensor} busy={busy === sensor.id}
                onToggle={() => void act(sensor.id, () => admin.cognition.setPerceptorEnabled(sensor.id, !sensor.enabled))} />
            ))}
          </Table>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Learned weights" subtitle="Strongest first. Unproven = no outcome has scored it.">
          {(synapses.data ?? []).length === 0 ? <Empty>{synapses.loading ? 'Loading…' : 'Nothing learned yet.'}</Empty> : (
            <Table head={<><Th>Association</Th><Th>Layer</Th><Th className="text-right">Weight</Th><Th className="text-right">Fired / scored</Th></>}>
              {(synapses.data ?? []).map((s) => (
                <tr key={s.id} className="hover:bg-white/[0.02]">
                  <Td className="max-w-[260px]">
                    <div className="truncate text-[11.5px]" title={`${s.source} → ${s.target}`}>
                      <span className="text-muted">{shorten(s.source)}</span><span className="px-1 text-faint">→</span><span>{shorten(s.target)}</span>
                    </div>
                    <div className="text-[10px] text-faint">{s.lastActivatedAt ? `fired ${ago(s.lastActivatedAt)}` : 'never fired'}</div>
                  </Td>
                  <Td className="text-[10.5px] text-faint">{s.layer.replace(/^L\d_/, '')}</Td>
                  <Td className="text-right"><WeightBar weight={s.weight} reinforcements={s.reinforcements} /></Td>
                  <Td className="num text-right text-[11px] text-muted">{fmtNum(s.activations)} / {fmtNum(s.reinforcements)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        <Panel title="Proposals" subtitle="The network never acts. It proposes, and an operator decides."
          right={
            <select value={proposalStatus} onChange={(e) => setProposalStatus(e.target.value)}
              className="rounded-md border border-white/10 bg-black/40 px-2 py-0.5 text-[11px] outline-none focus:border-teal">
              <option value="pending">Pending</option><option value="accepted">Accepted</option>
              <option value="dismissed">Dismissed</option><option value="done">Done</option><option value="">All</option>
            </select>
          }>
          {(proposals.data ?? []).length === 0 ? <Empty>{proposals.loading ? 'Loading…' : 'Nothing proposed. A quiet queue is normal.'}</Empty> : (
            <div className="max-h-[420px] divide-y divide-white/[0.04] overflow-auto">
              {(proposals.data ?? []).map((proposal) => (
                <ProposalCard key={proposal.id} proposal={proposal} busy={busy === proposal.id}
                  onResolve={(status) => void act(proposal.id, () => admin.cognition.resolveProposal(proposal.id, status))} />
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div>
        <SectionTitle>Recent passes</SectionTitle>
        <Panel className="mt-2" title="" subtitle="">
          {(episodes.data ?? []).length === 0 ? <Empty>{episodes.loading ? 'Loading…' : 'No passes in the last 24 hours.'}</Empty> : (
            <Table head={<>
              <Th>Started</Th><Th>Trigger</Th><Th>Domain</Th><Th>Status</Th>
              <Th className="text-right">Sensed</Th><Th className="text-right">Promoted</Th><Th className="text-right">Duration</Th><Th>Outcome</Th>
            </>}>
              {(episodes.data ?? []).map((e) => {
                const durationMs = e.finishedAt ? new Date(e.finishedAt).getTime() - new Date(e.startedAt).getTime() : null;
                return (
                  <tr key={e.id} className="hover:bg-white/[0.02]">
                    <Td className="text-[11px] text-muted">{fmtTime(e.startedAt)}</Td>
                    <Td className="text-[11px]">{e.trigger}</Td>
                    <Td className="text-[11px] text-muted">{e.domain ?? 'all'}</Td>
                    <Td><Pill tone={e.status === 'ok' ? 'good' : e.status === 'degraded' ? 'warn' : e.status === 'error' ? 'bad' : 'neutral'}>{e.status}</Pill></Td>
                    <Td className="num text-right">{fmtNum(e.perceptCount)}</Td>
                    <Td className="num text-right">{fmtNum(e.promotedCount)}</Td>
                    <Td className="num text-right text-muted">{fmtMs(durationMs)}</Td>
                    <Td>{e.reward === null ? <span className="text-[10.5px] text-faint">unscored</span> : <Pill tone={e.reward >= 0.7 ? 'good' : e.reward <= 0.3 ? 'bad' : 'neutral'}>{e.reward.toFixed(2)}</Pill>}</Td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Panel>
      </div>
    </div>
  );
}

function FlowStage({ label, value, active, arrow }: { label: string; value: string; active: boolean; arrow?: boolean }) {
  return (
    <>
      {arrow && <span className={`text-[13px] ${active ? 'text-teal' : 'text-white/15'}`}>→</span>}
      <div className={`rounded-lg border px-3 py-1.5 ${active ? 'border-teal/40 bg-teal/[0.06]' : 'border-white/[0.08] bg-white/[0.02]'}`}>
        <div className="flex items-center gap-1.5">
          <StatusDot tone={active ? 'good' : 'idle'} pulse={active} size={6} />
          <span className="text-[10.5px] text-muted">{label}</span>
        </div>
        <div className="num mt-0.5 text-[12px] font-semibold">{value}</div>
      </div>
    </>
  );
}

function PerceptorRowView({ sensor, busy, onToggle }: { sensor: PerceptorRow; busy: boolean; onToggle: () => void }) {
  const status = sensor.enabled ? (sensor.health?.status ?? 'healthy') : 'disabled';
  return (
    <tr className="hover:bg-white/[0.02]">
      <Td className="max-w-[280px]">
        <div className="truncate text-[12px]">{sensor.label}</div>
        <div className="truncate text-[10px] text-faint" title={sensor.description}>{sensor.description}</div>
      </Td>
      <Td className="text-[11px] text-muted">{sensor.domain}</Td>
      <Td>
        <Pill tone={perceptorTone(status)}>{status}</Pill>
        {sensor.health?.lastError && <div className="mt-0.5 max-w-[200px] truncate text-[10px] text-down" title={sensor.health.lastError}>{sensor.health.lastError}</div>}
      </Td>
      <Td className="text-[11px] text-muted">{sensor.cadence === 'interval' && sensor.expectedIntervalMs ? `every ${Math.round(sensor.expectedIntervalMs / 1000)}s` : sensor.cadence}</Td>
      <Td className="text-right text-[11px] text-muted">{ago(sensor.health?.lastPerceptAt ?? null)}</Td>
      <Td className="num text-right text-[11px] text-muted">{(sensor.health?.meanSalience ?? 0).toFixed(2)}</Td>
      <Td className="num text-right text-[11px]">{fmtNum(sensor.health?.totalPercepts ?? 0)}</Td>
      <Td className="text-right">
        <button type="button" disabled={busy} onClick={onToggle}
          className="rounded border border-white/10 px-1.5 py-px text-[10.5px] text-muted transition-colors hover:border-white/25 hover:text-text disabled:opacity-40">
          {busy ? '…' : sensor.enabled ? 'Disable' : 'Enable'}
        </button>
      </Td>
    </tr>
  );
}

function ProposalCard({ proposal, busy, onResolve }: { proposal: ProposalRow; busy: boolean; onResolve: (status: 'accepted' | 'dismissed' | 'done') => void }) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Pill tone={proposal.kind === 'investigate' ? 'warn' : 'info'}>{proposal.kind}</Pill>
            <span className="text-[10.5px] text-faint">{proposal.domain}</span>
            <span className="num text-[10.5px] text-faint">{(proposal.confidence * 100).toFixed(0)}%</span>
          </div>
          <div className="mt-1 text-[12px]">{proposal.title}</div>
          <div className="mt-0.5 text-[10.5px] text-faint">{proposal.perceptIds.length} percept{proposal.perceptIds.length === 1 ? '' : 's'} · {ago(proposal.createdAt)}</div>
        </div>
        {proposal.status === 'pending' ? (
          <div className="flex shrink-0 gap-1">
            <button type="button" disabled={busy} onClick={() => onResolve('accepted')}
              className="rounded border border-up/40 px-1.5 py-px text-[10.5px] text-up transition-colors hover:bg-up/10 disabled:opacity-40">Useful</button>
            <button type="button" disabled={busy} onClick={() => onResolve('dismissed')}
              title="Tells the network this finding was wrong — the only negative signal it gets"
              className="rounded border border-down/40 px-1.5 py-px text-[10.5px] text-down transition-colors hover:bg-down/10 disabled:opacity-40">Wrong</button>
          </div>
        ) : <Pill tone={proposal.status === 'dismissed' ? 'bad' : 'good'}>{proposal.status}</Pill>}
      </div>
    </div>
  );
}

function shorten(endpoint: string): string {
  const [, ...rest] = endpoint.split(':');
  return rest.join(':') || endpoint;
}
