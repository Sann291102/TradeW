'use client';

import { useState } from 'react';
import Link from 'next/link';
import { admin } from '@/lib/api';
import { SystemPipeline, type PipelineStage } from '@/components/SystemPipeline';
import {
  ActivityFeed, BarChart, MetricCard, Panel, SectionTitle, StatusIndicator, SystemHealthList,
  WindowPicker, fmtMs, fmtNum, fmtUsd, usePolling,
} from '@/components/ui';

/**
 * The TradeW Operator Command Center.
 *
 * Every number on this page is a real read from the admin API through the
 * standalone proxy. Stages of the pipeline the backend does not yet expose are
 * shown honestly (dashed, "—", "no source") rather than filled with plausible
 * values — see SystemPipeline and the design brief.
 */
export default function DashboardPage() {
  const [hours, setHours] = useState(24);
  const overview = usePolling(() => admin.overview(hours), [hours], 10_000);
  const traffic = usePolling(() => admin.apiTimeseries(hours), [hours], 30_000);
  const health = usePolling(() => admin.health(), [], 15_000);
  const cognition = usePolling(() => admin.cognition.overview(), [], 15_000);
  const agents = usePolling(() => admin.agentStates('sentinel'), [], 12_000);
  const runs = usePolling(() => admin.runs({ hours, limit: 8 }), [hours], 12_000);

  const o = overview.data;
  const errorRate = o ? o.api.errorRate * 100 : 0;
  const anyDown = health.data?.services.some((s) => s.status === 'down') ?? false;
  const recentErrors = health.data?.serverErrorsLast5m ?? 0;
  const systemTone = anyDown ? 'bad' : recentErrors > 0 ? 'warn' : health.data ? 'good' : 'idle';
  const systemLabel = anyDown ? 'Degraded — service down' : recentErrors > 0 ? `${recentErrors} recent errors` : health.data ? 'All systems operational' : 'Checking…';

  const cog = cognition.data;
  const cogRunning = Boolean(cog?.enabled && cog?.isLeader);
  const liveAgents = (agents.data ?? []).filter((a) => a.state !== 'idle').length;
  const healthyPerceptors = (cog?.perceptors ?? []).filter((p) => p.status === 'healthy').length;

  // Real data merged onto the canonical pipeline. metric === null renders "—".
  const cogStatus: PipelineStage['status'] = cog ? (cogRunning ? 'live' : 'idle') : 'unavailable';
  const stages: PipelineStage[] = [
    { id: 'inputs', label: 'Market / Data', status: 'unavailable', group: 'input', metric: null, detail: 'Market, news, sentiment and economic feeds. No ingestion metric is exposed to the console yet.' },
    { id: 'perceptors', label: 'Perceptors', status: cogStatus, group: 'cognition', metric: cog ? { value: fmtNum(cog.perceptors.length), unit: 'sensors' } : null, detail: `${healthyPerceptors} healthy of ${cog?.perceptors.length ?? 0}. ${cogRunning ? 'Running.' : 'Registered but the network is not running (COGNITION_ENABLED).'}` },
    { id: 'features', label: 'Context / Features', status: cogStatus, group: 'cognition', metric: null, detail: 'Encoded features/context. Percept counts are on the Perceptors & Neural page, not summarised here.' },
    { id: 'neural', label: 'Neural Layers', status: cogStatus, group: 'cognition', metric: cog ? { value: fmtNum(cog.synapses.total), unit: 'syn' } : null, detail: `${cog?.layers.length ?? 4} layers, ${cog?.synapses.proven ?? 0} proven of ${cog?.synapses.total ?? 0} synapses.` },
    { id: 'brain', label: 'AI Brain / Sentinel', status: o ? (o.agents.runs > 0 ? 'live' : 'idle') : 'unavailable', group: 'ai', metric: o ? { value: fmtNum(o.agents.runs), unit: 'runs' } : null, detail: `${o?.agents.surfaced ?? 0} runs surfaced a message in this window.` },
    { id: 'agents', label: 'Agents', status: agents.data ? (liveAgents > 0 ? 'live' : 'idle') : 'unavailable', group: 'ai', metric: agents.data ? { value: fmtNum(agents.data.length), unit: 'agents' } : null, detail: `${liveAgents} currently active.` },
    { id: 'reasoning', label: 'Reasoning', status: 'unavailable', group: 'ai', metric: null, detail: 'Per-run reasoning traces exist per agent run, but no aggregate metric is exposed. The Reasoning Inspector module is scaffolded.' },
    { id: 'risk', label: 'Risk / Safety', status: 'unavailable', group: 'oversight', metric: null, detail: 'Observation-only. Sentinel never gates the order flow (ARCHITECTURE Rule 2); there is intentionally no live risk-gate metric.' },
    { id: 'oms', label: 'OMS / Trading', status: o ? (o.orders.total > 0 ? 'live' : 'idle') : 'unavailable', group: 'exec', metric: o ? { value: fmtNum(o.orders.total), unit: 'orders' } : null, detail: `${o?.orders.trades ?? 0} fills, ${o?.orders.rejected ?? 0} rejected.` },
    { id: 'audit', label: 'Audit / Learning', status: 'idle', group: 'oversight', metric: null, detail: 'The audit trail and learning loop are live on the Users / System and Perceptors pages; no summary count is fetched here.' },
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Operator Command Center</h1>
          <p className="text-[12px] text-muted">Live platform state over the last {hours >= 24 ? `${hours / 24}d` : `${hours}h`}.</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusIndicator label={systemLabel} tone={systemTone} pulse={systemTone === 'good'} />
          <WindowPicker hours={hours} onChange={setHours} />
        </div>
      </header>

      {overview.error && (
        <div className="rounded-lg border border-down/40 bg-down-bg px-4 py-2.5 text-[12px] text-down">{overview.error}</div>
      )}

      {/* Top — global KPIs. Real values, no fabricated deltas. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="API calls" accent="teal" live value={o ? fmtNum(o.api.total) : '—'} sub={o ? `${fmtMs(o.api.avgLatencyMs)} avg` : undefined} tone={errorRate > 5 ? 'bad' : errorRate > 1 ? 'warn' : 'neutral'} />
        <MetricCard label="Error rate" accent={errorRate > 1 ? 'red' : 'green'} value={o ? `${errorRate.toFixed(2)}%` : '—'} sub={o ? `${fmtNum(o.api.errors)} of ${fmtNum(o.api.total)}` : undefined} tone={errorRate > 5 ? 'bad' : errorRate > 1 ? 'warn' : 'good'} />
        <MetricCard label="AI spend" accent="violet" value={o ? fmtUsd(o.ai.costUsd) : '—'} sub={o ? `${fmtNum(o.ai.calls)} calls` : undefined} />
        <MetricCard label="Sentinel runs" accent="teal" value={o ? fmtNum(o.agents.runs) : '—'} sub={o ? `${fmtNum(o.agents.surfaced)} surfaced` : undefined} />
        <MetricCard label="Orders" accent="green" value={o ? fmtNum(o.orders.total) : '—'} sub={o ? `${fmtNum(o.orders.trades)} fills` : undefined} tone={o && o.orders.rejected > o.orders.total * 0.1 ? 'warn' : 'neutral'} />
        <MetricCard label="Users" accent="slate" value={o ? fmtNum(o.users.total) : '—'} sub={o ? `+${fmtNum(o.users.new)} new` : undefined} />
      </div>

      {/* Middle — the cognition/system pipeline. */}
      <SystemPipeline stages={stages} title="Cognition & System Signal Flow" subtitle="Data → perceptors → neural layers → Sentinel → agents → OMS → audit" />

      {/* Middle-lower — traffic + health + cognition summary. */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Panel title="Request traffic" subtitle="Hourly, by response class" className="lg:col-span-2">
          <div className="p-4">
            <BarChart
              data={(traffic.data ?? []).map((row) => ({ bucket: row.bucket, ok: Number(row.ok ?? 0), client: Number(row.client ?? 0), server: Number(row.server ?? 0) }))}
              series={[
                { key: 'ok', color: 'rgb(38 166 154)', label: '2xx/3xx' },
                { key: 'client', color: 'rgb(240 165 60)', label: '4xx' },
                { key: 'server', color: 'rgb(239 83 80)', label: '5xx' },
              ]}
            />
          </div>
        </Panel>
        <Panel title="Infrastructure health" subtitle={health.data ? `${health.data.services.filter((s) => s.status === 'up').length}/${health.data.services.length} up` : 'checking…'}>
          <SystemHealthList services={health.data?.services ?? []} />
        </Panel>
      </div>

      {/* Lower — cognition status + recent agent activity. */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Panel title="Perceptors & Neural" subtitle={cog ? (cogRunning ? 'network running' : 'registered — not running') : 'loading…'} right={<Link href="/cognition" className="text-[11px] text-teal hover:underline">Open →</Link>}>
          <div className="grid grid-cols-2 gap-px bg-white/[0.04]">
            <MiniStat label="Perceptors" value={cog ? fmtNum(cog.perceptors.length) : '—'} sub={cog ? `${healthyPerceptors} healthy` : undefined} />
            <MiniStat label="Synapses" value={cog ? fmtNum(cog.synapses.total) : '—'} sub={cog ? `${fmtNum(cog.synapses.proven)} proven` : undefined} />
            <MiniStat label="Layers" value={cog ? fmtNum(cog.layers.length) : '—'} sub="perception → consolidation" />
            <MiniStat label="Mean weight" value={cog ? cog.synapses.meanWeight.toFixed(2) : '—'} sub={cogRunning ? 'learning' : 'idle'} />
          </div>
        </Panel>

        <Panel title="Recent Sentinel runs" subtitle="Live agent activity" className="lg:col-span-2" right={<Link href="/ai" className="text-[11px] text-teal hover:underline">AI room →</Link>}>
          <ActivityFeed
            emptyLabel="No Sentinel runs in this window."
            items={(runs.data ?? []).map((r) => ({
              id: r.runId,
              title: <><span className="font-medium">{r.symbol ?? r.system}</span> <span className="text-faint">· {r.trigger}</span></>,
              meta: `${r.status}${r.surfaced ? ' · surfaced' : ''}${r.confidence != null ? ` · ${(r.confidence * 100).toFixed(0)}% conf` : ''}`,
              at: r.startedAt,
              tone: r.status === 'error' ? 'bad' : r.surfaced ? 'good' : 'idle',
            }))}
          />
        </Panel>
      </div>

      {/* Quick access to the working surfaces. */}
      <div>
        <SectionTitle>Consoles</SectionTitle>
        <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Tile href="/ai" title="AI & Sentinel" blurb="Agent orbit, live traces, model spend and latency." metric={o ? `${fmtNum(o.ai.calls)} AI calls` : '—'} />
          <Tile href="/cognition" title="Perceptors & Neural" blurb="The four-layer cognition network and its learned weights." metric={cog ? `${fmtNum(cog.perceptors.length)} perceptors` : '—'} />
          <Tile href="/orders" title="Orders / OMS" blurb="Order flow, fills and rejections across the platform." metric={o ? `${fmtNum(o.orders.total)} orders` : '—'} />
          <Tile href="/system" title="Users / System" blurb="Accounts, the auth audit trail and service health." metric={o ? `${fmtNum(o.users.total)} users` : '—'} />
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-[#070b12] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.12em] text-faint">{label}</div>
      <div className="num mt-1 text-[17px] font-semibold leading-none">{value}</div>
      {sub && <div className="mt-1 text-[10.5px] text-muted">{sub}</div>}
    </div>
  );
}

function Tile({ href, title, blurb, metric }: { href: string; title: string; blurb: string; metric: string }) {
  return (
    <Link href={href} className="admin-tile group relative block overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 backdrop-blur-sm hover:border-teal/30">
      <span className="admin-tile__sheen" aria-hidden />
      <div className="relative">
        <div className="flex items-center gap-2">
          <span className="admin-orb admin-orb--idle block h-2.5 w-2.5 transition-none group-hover:hidden" aria-hidden />
          <span className="admin-orb admin-orb--thinking hidden h-2.5 w-2.5 group-hover:block" aria-hidden />
          <h3 className="text-[13px] font-semibold">{title}</h3>
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{blurb}</p>
        <p className="num mt-3 text-[12px] text-teal">{metric}</p>
      </div>
    </Link>
  );
}
