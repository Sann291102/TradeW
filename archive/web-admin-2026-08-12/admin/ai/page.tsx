'use client';

import { useState } from 'react';
import { admin, type AiCallRow, type RunRow } from '@/lib/admin/api';
import { SentinelOrbit } from '../components/SentinelOrbit';
import {
  BarChart,
  Empty,
  Panel,
  Pill,
  Stat,
  Table,
  Td,
  Th,
  WindowPicker,
  fmtMs,
  fmtNum,
  fmtTime,
  fmtUsd,
  usePolling,
} from '../components/ui';

/**
 * AI & Sentinel — how the intelligence layer is actually behaving.
 *
 * Ordered by how quickly each block answers a question:
 *
 *  1. **The orbit** — live. What is running right now, and which agent is doing
 *     what. This is the only view in the platform where a stuck or silent agent
 *     is visible at all.
 *  2. **Per-agent roll-up** — is one agent burning the budget, failing, or slow.
 *  3. **Runs** — did Sentinel surface anything, and at what confidence.
 *  4. **Raw calls** — the audit trail, for when the roll-up says something is
 *     wrong and the operator needs the individual failures.
 */
export default function AdminAiPage() {
  const [hours, setHours] = useState(24);
  const [system, setSystem] = useState('sentinel');
  const [callFilter, setCallFilter] = useState('');

  const byAgent = usePolling(() => admin.aiByAgent(hours), [hours], 15_000);
  const series = usePolling(() => admin.aiTimeseries(hours), [hours], 30_000);
  const runs = usePolling(() => admin.runs({ hours, system, limit: 50 }), [hours, system], 10_000);
  const calls = usePolling(
    () => admin.aiCalls({ hours, status: callFilter || undefined, limit: 150 }),
    [hours, callFilter],
    10_000,
  );

  const agents = byAgent.data ?? [];
  const totalCalls = agents.reduce((sum, a) => sum + a.calls, 0);
  const totalCost = agents.reduce((sum, a) => sum + a.costUsd, 0);
  const totalFailures = agents.reduce((sum, a) => sum + a.failures, 0);
  const slowest = agents.slice().sort((a, b) => b.avgLatencyMs - a.avgLatencyMs)[0];

  const runRows = runs.data ?? [];
  const surfaced = runRows.filter((r) => r.surfaced).length;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">AI &amp; Sentinel</h1>
          <p className="text-[12px] text-muted">Live agent activity, model spend, and every call the AI made.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal"
          >
            <option value="sentinel">Sentinel</option>
            <option value="tradew-ai">TradeW AI</option>
          </select>
          <WindowPicker hours={hours} onChange={setHours} />
        </div>
      </header>

      <SentinelOrbit system={system} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="AI calls" value={fmtNum(totalCalls)} sub={`${agents.length} agents active`} />
        <Stat
          label="Estimated spend"
          value={fmtUsd(totalCost)}
          // Labelled an estimate everywhere it appears — it is computed from a
          // local rate card, not from provider billing.
          sub="from the local rate card"
        />
        <Stat
          label="Failed calls"
          value={fmtNum(totalFailures)}
          sub={totalCalls ? `${((totalFailures / totalCalls) * 100).toFixed(1)}% of calls` : undefined}
          tone={totalFailures > 0 ? (totalFailures / Math.max(1, totalCalls) > 0.05 ? 'bad' : 'warn') : 'good'}
        />
        <Stat
          label="Slowest agent"
          value={slowest ? slowest.agent : '—'}
          sub={slowest ? `${fmtMs(slowest.avgLatencyMs)} avg · ${fmtMs(slowest.maxLatencyMs)} peak` : undefined}
          tone={slowest && slowest.avgLatencyMs > 8000 ? 'warn' : 'neutral'}
        />
      </div>

      <Panel title="AI volume and cost" subtitle="Hourly">
        <div className="p-4">
          <BarChart
            data={(series.data ?? []).map((row) => ({ bucket: row.bucket, calls: Number(row.calls ?? 0) }))}
            series={[{ key: 'calls', color: 'rgb(20 184 166)', label: 'LLM calls' }]}
          />
        </div>
      </Panel>

      <Panel title="Per-agent" subtitle="Volume, spend, latency and failures by agent">
        {agents.length ? (
          <Table
            head={
              <>
                <Th>System</Th>
                <Th>Agent</Th>
                <Th className="text-right">Calls</Th>
                <Th className="text-right">Tokens</Th>
                <Th className="text-right">Est. cost</Th>
                <Th className="text-right">Avg</Th>
                <Th className="text-right">Peak</Th>
                <Th className="text-right">Failures</Th>
              </>
            }
          >
            {agents.map((a) => (
              <tr key={`${a.system}-${a.agent}`} className="transition-colors hover:bg-white/[0.03]">
                <Td className="text-muted">{a.system}</Td>
                <Td className="font-medium">{a.agent}</Td>
                <Td className="num text-right">{fmtNum(a.calls)}</Td>
                <Td className="num text-right text-muted">{fmtNum(a.promptTokens + a.completionTokens)}</Td>
                <Td className="num text-right">{fmtUsd(a.costUsd)}</Td>
                <Td className="num text-right">{fmtMs(a.avgLatencyMs)}</Td>
                <Td className="num text-right text-muted">{fmtMs(a.maxLatencyMs)}</Td>
                <Td className="num text-right">
                  {a.failures ? <span className="text-down">{a.failures}</span> : <span className="text-faint">0</span>}
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>{byAgent.loading ? 'Loading…' : 'No AI calls in this window.'}</Empty>
        )}
      </Panel>

      <Panel
        title="Orchestrator runs"
        subtitle={`${runRows.length} runs · ${surfaced} surfaced a message`}
      >
        {runRows.length ? (
          <Table
            head={
              <>
                <Th>Started</Th>
                <Th>Trigger</Th>
                <Th>Symbol</Th>
                <Th>Agents</Th>
                <Th className="text-right">Confidence</Th>
                <Th className="text-right">Duration</Th>
                <Th>Outcome</Th>
              </>
            }
          >
            {runRows.map((run: RunRow) => (
              <tr key={run.runId} className="transition-colors hover:bg-white/[0.03]">
                <Td className="num text-muted">{fmtTime(run.startedAt)}</Td>
                <Td>{run.trigger}</Td>
                <Td className="font-medium">{run.symbol ?? '—'}</Td>
                <Td className="max-w-[240px] truncate text-muted">{run.agentsRan.join(', ') || '—'}</Td>
                <Td className="num text-right">{run.confidence !== null ? `${run.confidence.toFixed(0)}%` : '—'}</Td>
                <Td className="num text-right text-muted">{fmtMs(run.durationMs)}</Td>
                <Td>
                  {run.status === 'error' ? (
                    <Pill tone="bad">error</Pill>
                  ) : run.surfaced ? (
                    <Pill tone="info">surfaced</Pill>
                  ) : (
                    // Not "no result". Sentinel choosing silence is the designed
                    // outcome and must not be presented as a failure.
                    <Pill tone="neutral">stayed silent</Pill>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>{runs.loading ? 'Loading…' : 'No runs in this window.'}</Empty>
        )}
      </Panel>

      <Panel
        title="Raw AI calls"
        subtitle="Every LLM call, newest first"
        right={
          <select
            value={callFilter}
            onChange={(e) => setCallFilter(e.target.value)}
            className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal"
          >
            <option value="">All calls</option>
            <option value="errors">Failures only</option>
            <option value="ok">Successful only</option>
          </select>
        }
      >
        {calls.data && calls.data.length > 0 ? (
          <Table
            head={
              <>
                <Th>Time</Th>
                <Th>System</Th>
                <Th>Agent</Th>
                <Th>Provider / model</Th>
                <Th className="text-right">In</Th>
                <Th className="text-right">Out</Th>
                <Th className="text-right">Cost</Th>
                <Th className="text-right">Latency</Th>
                <Th>Status</Th>
              </>
            }
          >
            {calls.data.map((call: AiCallRow) => (
              <tr key={call.id} className="transition-colors hover:bg-white/[0.03]">
                <Td className="num text-muted">{fmtTime(call.createdAt)}</Td>
                <Td className="text-muted">{call.system}</Td>
                <Td className="font-medium">{call.agent}</Td>
                <Td className="max-w-[260px] truncate text-muted">
                  {call.provider} · {call.model}
                </Td>
                <Td className="num text-right text-muted">{fmtNum(call.promptTokens)}</Td>
                <Td className="num text-right text-muted">{fmtNum(call.completionTokens)}</Td>
                <Td className="num text-right">{fmtUsd(call.costUsd)}</Td>
                <Td className="num text-right">{fmtMs(call.latencyMs)}</Td>
                <Td>
                  <span title={call.error ?? undefined}>
                    <Pill
                      tone={
                        call.status === 'ok'
                          ? 'good'
                          : call.status === 'fallback'
                            ? 'warn'
                            : 'bad'
                      }
                    >
                      {call.status}
                    </Pill>
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>{calls.loading ? 'Loading…' : 'No AI calls in this window.'}</Empty>
        )}
      </Panel>
    </div>
  );
}
