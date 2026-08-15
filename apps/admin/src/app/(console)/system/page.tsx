'use client';

import { useState } from 'react';
import { admin, type ApiCallRow, type AuditRow, type UserRow } from '@/lib/api';
import {
  Empty, MetricCard, Panel, Pill, SectionTitle, StatusIndicator, SystemHealthList,
  Table, Td, Th, WindowPicker, ago, fmtMs, fmtNum, fmtTime, statusTone, usePolling,
} from '@/components/ui';

export default function AdminSystemPage() {
  const [hours, setHours] = useState(24);
  const [query, setQuery] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(true);

  const health = usePolling(() => admin.health(), [], 10_000);
  const users = usePolling(() => admin.users({ q: query || undefined, limit: 100 }), [query], 30_000);
  const audit = usePolling(() => admin.audit({ hours: Math.max(hours, 168), limit: 100 }), [hours], 20_000);
  const routes = usePolling(() => admin.routeStats(hours), [hours], 20_000);
  const calls = usePolling(() => admin.apiCalls({ hours, status: errorsOnly ? 'errors' : undefined, limit: 150 }), [hours, errorsOnly], 10_000);

  const h = health.data;
  const dbProbe = h?.services.find((s) => s.name === 'postgres');
  const anyDown = h?.services.some((s) => s.status === 'down') ?? false;
  const sysTone = anyDown ? 'bad' : (h?.serverErrorsLast5m ?? 0) > 0 ? 'warn' : h ? 'good' : 'idle';
  const sysLabel = anyDown ? 'Service down' : (h?.serverErrorsLast5m ?? 0) > 0 ? `${h?.serverErrorsLast5m} recent 5xx` : h ? 'Infrastructure healthy' : 'Checking…';
  const admins = (users.data ?? []).filter((u) => u.isAdmin).length;

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Users &amp; System</h1>
          <p className="text-[12px] text-muted">Infrastructure health, accounts, the auth audit trail and API activity.</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusIndicator label={sysLabel} tone={sysTone} pulse={sysTone === 'good'} />
          <WindowPicker hours={hours} onChange={setHours} />
        </div>
      </header>

      {/* SYSTEM HEALTH */}
      <SectionTitle>System health</SectionTitle>
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="grid grid-cols-2 gap-3 lg:col-span-2">
          <MetricCard label="Database" accent={dbProbe?.status === 'up' ? 'green' : 'red'} value={dbProbe ? (dbProbe.status === 'up' ? 'Up' : 'Down') : '—'} sub={dbProbe ? `${fmtMs(dbProbe.latencyMs)} probe` : undefined} tone={dbProbe?.status === 'up' ? 'good' : 'bad'} live={dbProbe?.status === 'up'} />
          <MetricCard label="5xx / 5 min" accent={(h?.serverErrorsLast5m ?? 0) > 0 ? 'red' : 'green'} value={h ? fmtNum(Math.max(0, h.serverErrorsLast5m)) : '—'} tone={(h?.serverErrorsLast5m ?? 0) > 0 ? 'bad' : 'good'} />
          <MetricCard label="API uptime" accent="teal" value={h ? formatUptime(h.uptimeSeconds) : '—'} sub={h ? `${h.memoryMb} MB · node ${h.nodeVersion}` : undefined} />
          <MetricCard label="Oldest pending order" accent={h?.oldestPendingOrder ? 'amber' : 'green'} value={h?.oldestPendingOrder ? ago(h.oldestPendingOrder.createdAt) : 'None'} sub={h?.oldestPendingOrder ? 'possible stalled worker' : 'queue clear'} tone={h?.oldestPendingOrder ? 'warn' : 'good'} />
        </div>
        <Panel title="Services" subtitle={h ? `${h.services.filter((s) => s.status === 'up').length}/${h.services.length} up` : 'checking…'}>
          <SystemHealthList services={h?.services ?? []} />
        </Panel>
      </div>

      {/* USERS */}
      <SectionTitle right={<span className="text-[10.5px] text-faint">{admins} admin{admins === 1 ? '' : 's'}</span>}>Users</SectionTitle>
      <Panel title="Accounts" subtitle={`${users.data?.length ?? 0} shown`}
        right={
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search email…"
            className="w-48 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal" />
        }>
        {users.data && users.data.length > 0 ? (
          <Table head={<>
            <Th>Email</Th><Th>Joined</Th><Th>Country</Th><Th>Experience</Th>
            <Th className="text-right">Orders</Th><Th className="text-right">Trades</Th><Th>Plan</Th><Th>Role</Th>
          </>}>
            {users.data.map((user: UserRow) => (
              <tr key={user.id} className="transition-colors hover:bg-white/[0.03]">
                <Td className="max-w-[240px] truncate font-medium">{user.email}</Td>
                <Td className="text-muted">{ago(user.createdAt)}</Td>
                <Td className="text-muted">{user.country}</Td>
                <Td className="text-muted">{user.experienceLevel ?? '—'}</Td>
                <Td className="num text-right">{fmtNum(user._count.orders)}</Td>
                <Td className="num text-right">{fmtNum(user._count.trades)}</Td>
                <Td className="text-muted">{user.subscriptions[0]?.planId ?? 'free'}</Td>
                <Td>{user.isAdmin ? <Pill tone="info">admin</Pill> : <span className="text-faint">—</span>}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>{users.loading ? 'Loading…' : 'No users matched.'}</Empty>
        )}
      </Panel>

      {/* SECURITY / AUDIT + API ACTIVITY */}
      <SectionTitle>Security &amp; API activity</SectionTitle>
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Auth audit trail" subtitle="Logins, signups, refreshes, admin changes — last 7 days">
          {audit.data && audit.data.length > 0 ? (
            <Table head={<><Th>Time</Th><Th>Event</Th><Th>User</Th><Th>IP</Th></>}>
              {audit.data.map((event: AuditRow) => (
                <tr key={event.id} className="transition-colors hover:bg-white/[0.03]">
                  <Td className="num text-muted">{fmtTime(event.createdAt)}</Td>
                  <Td><Pill tone={event.eventType.startsWith('admin.') ? 'info' : 'neutral'}>{event.eventType}</Pill></Td>
                  <Td className="max-w-[200px] truncate text-muted">{event.user?.email ?? '—'}</Td>
                  <Td className="num text-faint">{event.ip ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty>{audit.loading ? 'Loading…' : 'No audit events.'}</Empty>
          )}
        </Panel>

        <Panel title="Routes" subtitle="Busiest endpoints, with latency and errors">
          {routes.data && routes.data.length > 0 ? (
            <Table head={<><Th>Route</Th><Th className="text-right">Calls</Th><Th className="text-right">Avg</Th><Th className="text-right">Peak</Th><Th className="text-right">Errors</Th></>}>
              {routes.data.map((route) => (
                <tr key={`${route.method}-${route.path}`} className="transition-colors hover:bg-white/[0.03]">
                  <Td className="max-w-[280px] truncate"><span className="text-faint">{route.method}</span> {route.path}</Td>
                  <Td className="num text-right">{fmtNum(route.count)}</Td>
                  <Td className="num text-right">{fmtMs(route.avgMs)}</Td>
                  <Td className={`num text-right ${route.maxMs > 3000 ? 'text-amber' : 'text-muted'}`}>{fmtMs(route.maxMs)}</Td>
                  <Td className="num text-right">{route.errors ? <span className="text-down">{route.errors}</span> : <span className="text-faint">0</span>}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty>{routes.loading ? 'Loading…' : 'No traffic in this window.'}</Empty>
          )}
        </Panel>
      </div>

      <Panel title="Request log" subtitle="Every call the API served"
        right={
          <button type="button" onClick={() => setErrorsOnly((v) => !v)}
            className={`rounded-md border px-2 py-1 text-[11.5px] transition-colors ${errorsOnly ? 'border-down/40 text-down' : 'border-white/10 text-muted hover:text-text'}`}>
            {errorsOnly ? 'Errors only' : 'All requests'}
          </button>
        }>
        {calls.data && calls.data.length > 0 ? (
          <Table head={<>
            <Th>Time</Th><Th>Method</Th><Th>Path</Th><Th>User</Th>
            <Th className="text-right">Status</Th><Th className="text-right">Duration</Th><Th>Error</Th>
          </>}>
            {calls.data.map((call: ApiCallRow) => (
              <tr key={call.id} className="transition-colors hover:bg-white/[0.03]">
                <Td className="num text-muted">{fmtTime(call.createdAt)}</Td>
                <Td className="text-faint">{call.method}</Td>
                <Td className="max-w-[280px] truncate">{call.path}</Td>
                <Td className="max-w-[180px] truncate text-muted">{call.user?.email ?? '—'}</Td>
                <Td className="text-right"><Pill tone={statusTone(call.statusCode)}>{call.statusCode}</Pill></Td>
                <Td className={`num text-right ${call.durationMs > 2000 ? 'text-amber' : ''}`}>{fmtMs(call.durationMs)}</Td>
                <Td className="max-w-[240px] truncate text-down">{call.error ?? ''}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>{calls.loading ? 'Loading…' : errorsOnly ? 'No errors in this window.' : 'No requests in this window.'}</Empty>
        )}
      </Panel>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
