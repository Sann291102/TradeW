'use client';

import { useState } from 'react';
import Link from 'next/link';
import { admin } from '@/lib/admin/api';
import { BarChart, Panel, Stat, WindowPicker, fmtMs, fmtNum, fmtUsd, usePolling } from './components/ui';

/**
 * The console landing page.
 *
 * Two jobs, in this order:
 *
 *  1. **Answer "is anything wrong right now?" without a click.** The headline
 *     row is the whole platform in eight numbers, and the traffic chart shows
 *     the shape of the last window. If everything is green here, the operator
 *     can stop reading.
 *
 *  2. **Route to the section that owns the problem.** The four tiles are the
 *     drill-downs; each carries a live number so the operator knows which one
 *     to open before they open it. A tile that just said "Orders" would make
 *     them click to find out whether orders were interesting.
 */
export default function AdminOverviewPage() {
  const [hours, setHours] = useState(24);
  const overview = usePolling(() => admin.overview(hours), [hours], 10_000);
  const traffic = usePolling(() => admin.apiTimeseries(hours), [hours], 30_000);
  const health = usePolling(() => admin.health(), [], 15_000);

  const o = overview.data;
  const errorRate = o ? o.api.errorRate * 100 : 0;
  const dbDown = health.data?.services.some((s) => s.status === 'down');

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">Platform overview</h1>
          <p className="text-[12px] text-muted">
            Everything the platform served in the last {hours >= 24 ? `${hours / 24}d` : `${hours}h`}.
          </p>
        </div>
        <WindowPicker hours={hours} onChange={setHours} />
      </header>

      {overview.error && (
        <div className="rounded-lg border border-down/40 bg-down-bg px-4 py-2.5 text-[12px] text-down">
          {overview.error}
        </div>
      )}

      {/* Health is called out above the numbers, not buried in them: a down
          dependency invalidates every figure below it, and an operator must
          not read a suspiciously quiet chart as "quiet" when it means "not
          being recorded". */}
      {(dbDown || (health.data?.serverErrorsLast5m ?? 0) > 0) && (
        <div className="rounded-lg border border-amber/40 bg-amber-bg px-4 py-2.5 text-[12px] text-amber">
          {dbDown && <strong>Database probe failing. </strong>}
          {(health.data?.serverErrorsLast5m ?? 0) > 0 && (
            <>{health.data?.serverErrorsLast5m} server errors in the last 5 minutes.</>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="API calls"
          value={o ? fmtNum(o.api.total) : '—'}
          sub={o ? `${errorRate.toFixed(2)}% errors · ${fmtMs(o.api.avgLatencyMs)} avg` : undefined}
          tone={errorRate > 5 ? 'bad' : errorRate > 1 ? 'warn' : 'good'}
        />
        <Stat
          label="AI calls"
          value={o ? fmtNum(o.ai.calls) : '—'}
          sub={o ? `${fmtUsd(o.ai.costUsd)} est. · ${fmtNum(o.ai.promptTokens + o.ai.completionTokens)} tokens` : undefined}
          tone={o && o.ai.errors > 0 ? 'warn' : 'neutral'}
        />
        <Stat
          label="Sentinel runs"
          value={o ? fmtNum(o.agents.runs) : '—'}
          // Framed as "surfaced", not as a success rate. Sentinel staying quiet
          // is the designed behaviour and must not read as a failure metric.
          sub={o ? `${fmtNum(o.agents.surfaced)} surfaced a message` : undefined}
        />
        <Stat
          label="Orders"
          value={o ? fmtNum(o.orders.total) : '—'}
          sub={o ? `${fmtNum(o.orders.trades)} fills · ${fmtNum(o.orders.rejected)} rejected` : undefined}
          tone={o && o.orders.rejected > o.orders.total * 0.1 ? 'warn' : 'neutral'}
        />
      </div>

      <Panel title="Request traffic" subtitle="Hourly, split by response class">
        <div className="p-4">
          <BarChart
            data={(traffic.data ?? []).map((row) => ({
              bucket: row.bucket,
              ok: Number(row.ok ?? 0),
              client: Number(row.client ?? 0),
              server: Number(row.server ?? 0),
            }))}
            series={[
              { key: 'ok', color: 'rgb(38 166 154)', label: '2xx/3xx' },
              { key: 'client', color: 'rgb(240 165 60)', label: '4xx' },
              { key: 'server', color: 'rgb(239 83 80)', label: '5xx' },
            ]}
          />
        </div>
      </Panel>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Tile
          href="/admin/orders"
          title="Orders & OMS"
          blurb="Every order, fill and rejection across the platform."
          metric={o ? `${fmtNum(o.orders.total)} orders` : '—'}
        />
        <Tile
          href="/admin/ai"
          title="AI & Sentinel"
          blurb="The agent orbit, live traces, model spend and latency."
          metric={o ? `${fmtNum(o.ai.calls)} AI calls` : '—'}
        />
        <Tile
          href="/admin/knowledge"
          title="Knowledge"
          blurb="The engineering vault graph the agents read and write."
          metric="Vault graph"
        />
        <Tile
          href="/admin/system"
          title="Users & System"
          blurb="Accounts, the auth audit trail, and service health."
          metric={o ? `${fmtNum(o.users.total)} users` : '—'}
        />
      </div>
    </div>
  );
}

/** A drill-down tile. The 3D tilt and sheen come from `.admin-tile`. */
function Tile({ href, title, blurb, metric }: { href: string; title: string; blurb: string; metric: string }) {
  return (
    <Link
      href={href}
      className="admin-tile group relative block overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 backdrop-blur-sm hover:border-teal/30"
    >
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
