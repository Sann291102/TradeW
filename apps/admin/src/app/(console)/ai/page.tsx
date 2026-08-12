'use client';

import { useEffect, useMemo, useState } from 'react';
import { admin, type AiCallRow, type AiModelRow } from '@/lib/api';
import { SentinelOrbit } from '@/components/SentinelOrbit';
import {
  ActivityFeed, BarChart, Donut, Empty, MetricCard, Panel, Pill, SectionTitle, Sparkline,
  StatusIndicator, SystemHealthList, Table, Td, Th, WindowPicker, fmtMs, fmtNum, fmtTime, fmtUsd, usePolling,
} from '@/components/ui';

// The Sentinel subsystems a mockup shows are NOT instrumented in services/api.
// Rather than fabricate their health, we name them and state the truth.
const SENTINEL_SUBSYSTEMS = ['Reasoning', 'Safety', 'Compliance', 'Memory', 'Tooling', 'Data pipeline'];
const MODEL_COLORS = ['#2dd4bf', '#8b9dff', '#38bdf8', '#f0a53c', '#34d399', '#64748b'];

export default function AdminAiPage() {
  const [hours, setHours] = useState(24);
  const [system, setSystem] = useState('sentinel');
  const [callFilter, setCallFilter] = useState('');
  const [stamp, setStamp] = useState<number | null>(null);

  const overview = usePolling(() => admin.overview(hours), [hours], 10_000);
  const byAgent = usePolling(() => admin.aiByAgent(hours), [hours], 15_000);
  const byModel = usePolling(() => admin.aiByModel(hours), [hours], 20_000);
  const series = usePolling(() => admin.aiTimeseries(hours), [hours], 30_000);
  const pulse = usePolling(() => admin.apiPulse(30), [], 15_000);
  const health = usePolling(() => admin.health(), [], 15_000);
  const states = usePolling(() => admin.agentStates(system), [system], 10_000);
  const runs = usePolling(() => admin.runs({ hours, system, limit: 40 }), [hours, system], 10_000);
  const calls = usePolling(() => admin.aiCalls({ hours, status: callFilter || undefined, limit: 150 }), [hours, callFilter], 10_000);

  useEffect(() => { if (overview.data) setStamp(Date.now()); }, [overview.data]);

  const o = overview.data;
  const agents = byAgent.data ?? [];
  const totalCalls = agents.reduce((s, a) => s + a.calls, 0);
  const totalFailures = agents.reduce((s, a) => s + a.failures, 0);
  const weightedLatency = totalCalls ? Math.round(agents.reduce((s, a) => s + a.avgLatencyMs * a.calls, 0) / totalCalls) : null;
  const successRate = totalCalls ? ((totalCalls - totalFailures) / totalCalls) * 100 : null;

  const roster = states.data ?? [];
  const activeAgents = roster.filter((a) => a.state !== 'idle').length;

  const anyDown = health.data?.services.some((s) => s.status === 'down') ?? false;
  const streamTone = overview.error || anyDown ? 'bad' : o ? 'good' : 'idle';
  const streamLabel = overview.error ? 'Degraded' : anyDown ? 'Service down' : o ? 'Live' : 'Connecting…';

  // Model usage: real GROUP BY, top 5 + Other. Segments only from real calls.
  const modelSegments = useMemo(() => {
    const rows = (byModel.data ?? []).slice();
    const top = rows.slice(0, 5);
    const otherCalls = rows.slice(5).reduce((s, r) => s + r.calls, 0);
    const segs: Array<{ label: string; value: number; color: string; row: AiModelRow | null }> =
      top.map((r, i) => ({ label: `${r.provider}/${r.model}`, value: r.calls, color: MODEL_COLORS[i], row: r }));
    if (otherCalls > 0) segs.push({ label: 'Other', value: otherCalls, color: MODEL_COLORS[5], row: null });
    return segs;
  }, [byModel.data]);
  const modelCallTotal = modelSegments.reduce((s, x) => s + x.value, 0);

  const pulseRows = pulse.data ?? [];

  return (
    <div className="mx-auto max-w-[1700px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold uppercase tracking-tight">AI &amp; Sentinel Command Center</h1>
          <p className="text-[12px] text-muted">Live agent activity, model spend, and every call the AI made.</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusIndicator label={streamLabel} tone={streamTone} pulse={streamTone === 'good'} />
          <span className="num text-[11px] text-faint">updated {stamp ? fmtTime(stamp) : '—'}</span>
          <select value={system} onChange={(e) => setSystem(e.target.value)}
            className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal">
            <option value="sentinel">Sentinel</option>
            <option value="tradew-ai">TradeW AI</option>
          </select>
          <WindowPicker hours={hours} onChange={setHours} />
        </div>
      </header>

      {/* Header KPIs — real values, no fabricated deltas. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Agents online" accent="teal" live={activeAgents > 0} value={roster.length ? `${activeAgents}/${roster.length}` : '—'} sub="active / roster" />
        <MetricCard label="AI calls" accent="violet" value={o ? fmtNum(o.ai.calls) : '—'} sub={`${hours >= 24 ? hours / 24 + 'd' : hours + 'h'} window`} />
        <MetricCard label="Avg latency" accent={weightedLatency && weightedLatency > 8000 ? 'red' : 'teal'} value={weightedLatency != null ? fmtMs(weightedLatency) : '—'} tone={weightedLatency && weightedLatency > 8000 ? 'warn' : 'neutral'} />
        <MetricCard label="Model spend" accent="green" value={o ? fmtUsd(o.ai.costUsd) : '—'} sub="local rate card" />
        <MetricCard label="Success rate" accent={successRate != null && successRate < 95 ? 'amber' : 'green'} value={successRate != null ? `${successRate.toFixed(1)}%` : '—'} sub={totalCalls ? `${fmtNum(totalFailures)} failed` : undefined} tone={successRate != null && successRate < 95 ? 'warn' : 'good'} />
        <MetricCard label="Tokens" accent="slate" value={o ? fmtNum(o.ai.promptTokens + o.ai.completionTokens) : '—'} />
      </div>

      {/* The command-room centerpiece: the real live orbit (states, peer edges, SSE). */}
      <SentinelOrbit system={system} />

      {/* Agent performance + model usage + sentinel health. */}
      <div className="grid gap-3 xl:grid-cols-3">
        <Panel title="Agent performance" subtitle="Per-agent volume, success and latency">
          {agents.length ? (
            <Table head={<><Th>Agent</Th><Th className="text-right">Calls</Th><Th className="text-right">Success</Th><Th className="text-right">Avg</Th><Th className="text-right">Fails</Th></>}>
              {agents.map((a) => {
                const succ = a.calls ? ((a.calls - a.failures) / a.calls) * 100 : 0;
                return (
                  <tr key={`${a.system}-${a.agent}`} className="hover:bg-white/[0.03]">
                    <Td className="font-medium">{a.agent}</Td>
                    <Td className="num text-right">{fmtNum(a.calls)}</Td>
                    <Td className={`num text-right ${succ < 95 ? 'text-amber' : 'text-up'}`}>{succ.toFixed(1)}%</Td>
                    <Td className="num text-right text-muted">{fmtMs(a.avgLatencyMs)}</Td>
                    <Td className="num text-right">{a.failures ? <span className="text-down">{a.failures}</span> : <span className="text-faint">0</span>}</Td>
                  </tr>
                );
              })}
            </Table>
          ) : <Empty>{byAgent.loading ? 'Loading…' : 'No AI calls in this window.'}</Empty>}
        </Panel>

        <Panel title="Model usage" subtitle="Real GROUP BY on the AI call log">
          {modelCallTotal > 0 ? (
            <div className="flex items-center gap-4 p-4">
              <Donut segments={modelSegments} centerValue={fmtNum(modelCallTotal)} centerLabel="calls" />
              <ul className="min-w-0 flex-1 space-y-1.5">
                {modelSegments.map((s) => (
                  <li key={s.label} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: s.color }} />
                      <span className="truncate">{s.label}</span>
                    </span>
                    <span className="num shrink-0 text-muted">{((s.value / modelCallTotal) * 100).toFixed(1)}% · {s.row ? fmtNum(s.row.promptTokens + s.row.completionTokens) : '—'} tok</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : <Empty>{byModel.loading ? 'Loading…' : 'No AI calls in this window.'}</Empty>}
        </Panel>

        <Panel title="Sentinel health" subtitle="Infrastructure is probed; AI subsystems are not">
          <SystemHealthList services={health.data?.services ?? []} />
          <div className="border-t border-white/[0.06] px-4 py-2">
            <div className="mb-1.5 text-[9.5px] uppercase tracking-[0.13em] text-faint">Sentinel subsystems</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {SENTINEL_SUBSYSTEMS.map((s) => (
                <div key={s} className="flex items-center justify-between text-[11px]">
                  <span className="text-muted">{s}</span>
                  <span className="text-faint">Unavailable</span>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] text-faint">Per-subsystem health is not instrumented in services/api.</p>
          </div>
        </Panel>
      </div>

      {/* System pulse (per-minute, real) + AI volume. */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="System pulse" subtitle="API requests per minute · last 30 min (real)">
          <div className="grid grid-cols-3 gap-px bg-white/[0.04]">
            <PulseTile label="Requests / min" value={pulseRows.length ? fmtNum(pulseRows[pulseRows.length - 1].total) : '—'} series={pulseRows.map((r) => r.total)} color="rgb(45 212 191)" />
            <PulseTile label="Errors / min" value={pulseRows.length ? fmtNum(pulseRows[pulseRows.length - 1].errors) : '—'} series={pulseRows.map((r) => r.errors)} color="rgb(239 83 80)" />
            <PulseTile label="Avg latency" value={pulseRows.length ? fmtMs(pulseRows[pulseRows.length - 1].avgMs) : '—'} series={pulseRows.map((r) => r.avgMs)} color="rgb(139 157 255)" />
          </div>
          <div className="px-4 py-2 text-[10px] text-faint">Queue depth and inference/sec are not exposed by the backend — shown as pulse-per-minute from the request log instead.</div>
        </Panel>
        <Panel title="AI volume" subtitle="Hourly LLM calls">
          <div className="p-4">
            <BarChart data={(series.data ?? []).map((row) => ({ bucket: row.bucket, calls: Number(row.calls ?? 0) }))}
              series={[{ key: 'calls', color: 'rgb(20 184 166)', label: 'LLM calls' }]} />
          </div>
        </Panel>
      </div>

      {/* Recent runs + raw calls. */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Panel title="Recent runs" subtitle={`${runs.data?.length ?? 0} runs`}>
          <ActivityFeed emptyLabel={runs.loading ? 'Loading…' : 'No runs in this window.'}
            items={(runs.data ?? []).slice(0, 12).map((r) => ({
              id: r.runId,
              title: <><span className="font-medium">{r.symbol ?? r.system}</span> <span className="text-faint">· {r.trigger}</span></>,
              meta: `${r.status}${r.surfaced ? ' · surfaced' : ''}${r.confidence != null ? ` · ${r.confidence.toFixed(0)}% conf` : ''}`,
              at: r.startedAt,
              tone: r.status === 'error' ? 'bad' : r.surfaced ? 'good' : 'idle',
            }))} />
        </Panel>

        <Panel title="Raw AI calls" subtitle="Every LLM call, newest first" className="lg:col-span-2"
          right={
            <select value={callFilter} onChange={(e) => setCallFilter(e.target.value)}
              className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal">
              <option value="">All calls</option>
              <option value="errors">Failures only</option>
              <option value="ok">Successful only</option>
            </select>
          }>
          {calls.data && calls.data.length > 0 ? (
            <Table head={<>
              <Th>Time</Th><Th>Agent</Th><Th>Provider / model</Th>
              <Th className="text-right">In</Th><Th className="text-right">Out</Th>
              <Th className="text-right">Cost</Th><Th className="text-right">Latency</Th><Th>Status</Th>
            </>}>
              {calls.data.map((call: AiCallRow) => (
                <tr key={call.id} className="hover:bg-white/[0.03]">
                  <Td className="num text-muted">{fmtTime(call.createdAt)}</Td>
                  <Td className="font-medium">{call.agent}</Td>
                  <Td className="max-w-[240px] truncate text-muted">{call.provider} · {call.model}</Td>
                  <Td className="num text-right text-muted">{fmtNum(call.promptTokens)}</Td>
                  <Td className="num text-right text-muted">{fmtNum(call.completionTokens)}</Td>
                  <Td className="num text-right">{fmtUsd(call.costUsd)}</Td>
                  <Td className="num text-right">{fmtMs(call.latencyMs)}</Td>
                  <Td><span title={call.error ?? undefined}><Pill tone={call.status === 'ok' ? 'good' : call.status === 'fallback' ? 'warn' : 'bad'}>{call.status}</Pill></span></Td>
                </tr>
              ))}
            </Table>
          ) : <Empty>{calls.loading ? 'Loading…' : 'No AI calls in this window.'}</Empty>}
        </Panel>
      </div>
    </div>
  );
}

function PulseTile({ label, value, series, color }: { label: string; value: string; series: number[]; color: string }) {
  return (
    <div className="bg-[#070b12] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.12em] text-faint">{label}</div>
      <div className="num mt-1 text-[17px] font-semibold leading-none">{value}</div>
      <div className="mt-1.5"><Sparkline values={series} color={color} height={24} /></div>
    </div>
  );
}
