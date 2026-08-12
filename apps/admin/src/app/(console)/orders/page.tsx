'use client';

import { useState } from 'react';
import { admin, type OrderRow } from '@/lib/api';
import {
  Empty, MetricCard, Panel, Pill, StatusIndicator, Table, Td, Th, WindowPicker, fmtNum, fmtTime, usePolling,
} from '@/components/ui';

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  FILLED: 'good',
  PARTIALLY_FILLED: 'info',
  OPEN: 'info',
  TRIGGER_PENDING: 'info',
  PENDING: 'warn',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  REJECTED: 'bad',
};

export default function AdminOrdersPage() {
  const [hours, setHours] = useState(24);
  const [status, setStatus] = useState<string>('');

  const stats = usePolling(() => admin.orderStats(hours), [hours], 15_000);
  const orders = usePolling(() => admin.orders({ hours, status: status || undefined, limit: 200 }), [hours, status], 8_000);

  const byStatus = stats.data?.byStatus ?? [];
  const total = byStatus.reduce((sum, s) => sum + s.count, 0);
  const rejected = byStatus.find((s) => s.status === 'REJECTED')?.count ?? 0;
  const pending = byStatus.find((s) => s.status === 'PENDING')?.count ?? 0;
  const open = byStatus.filter((s) => s.status === 'OPEN' || s.status === 'TRIGGER_PENDING' || s.status === 'PARTIALLY_FILLED').reduce((n, s) => n + s.count, 0);

  const omsTone = rejected / Math.max(1, total) > 0.1 ? 'bad' : pending > 5 ? 'warn' : stats.data ? 'good' : 'idle';
  const omsLabel = rejected / Math.max(1, total) > 0.1 ? 'Elevated rejections' : pending > 5 ? 'Orders queuing' : stats.data ? 'Order flow nominal' : 'Loading…';

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Orders &amp; OMS</h1>
          <p className="text-[12px] text-muted">Order flow, fills and rejections across every account.</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusIndicator label={omsLabel} tone={omsTone} pulse={omsTone === 'good'} />
          <WindowPicker hours={hours} onChange={setHours} />
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="Orders placed" accent="teal" live value={fmtNum(total)} />
        <MetricCard label="Fills" accent="green" value={fmtNum(stats.data?.trades ?? 0)} />
        <MetricCard label="Working" accent="violet" value={fmtNum(open)} sub="open / partial / trigger" />
        <MetricCard label="Rejected" accent={rejected ? 'red' : 'green'} value={fmtNum(rejected)} sub={total ? `${((rejected / total) * 100).toFixed(1)}%` : undefined} tone={total && rejected / total > 0.1 ? 'bad' : rejected ? 'warn' : 'good'} />
        <MetricCard label="Pending" accent={pending > 5 ? 'amber' : 'slate'} value={fmtNum(pending)} sub={pending ? 'not yet queued' : 'nothing stuck'} tone={pending > 5 ? 'warn' : 'neutral'} />
      </div>

      <Panel title="Order flow" subtitle="By status and side">
        <div className="grid gap-6 p-4 sm:grid-cols-2">
          <StatusBars title="By status" rows={byStatus.map((s) => ({ label: s.status, count: s.count }))} total={total} />
          <StatusBars title="By side" rows={(stats.data?.bySide ?? []).map((s) => ({ label: s.side, count: s.count }))} total={total} />
        </div>
      </Panel>

      <Panel title="Recent orders" subtitle={`${orders.data?.length ?? 0} shown`}
        right={
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal">
            <option value="">All statuses</option>
            {Object.keys(STATUS_TONE).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        }>
        {orders.data && orders.data.length > 0 ? (
          <Table head={<>
            <Th>Time</Th><Th>User</Th><Th>Instrument</Th><Th>Side</Th><Th>Type</Th>
            <Th className="text-right">Qty</Th><Th className="text-right">Filled</Th>
            <Th className="text-right">Price</Th><Th>Status</Th><Th>Reject reason</Th>
          </>}>
            {orders.data.map((order: OrderRow) => (
              <tr key={order.id} className="transition-colors hover:bg-white/[0.03]">
                <Td className="num text-muted">{fmtTime(order.placedAt)}</Td>
                <Td className="max-w-[180px] truncate text-muted">{order.user?.email ?? '—'}</Td>
                <Td className="font-medium">{order.instrument?.symbol ?? '—'}</Td>
                <Td className={order.side === 'BUY' ? 'text-up' : 'text-down'}>{order.side}</Td>
                <Td className="text-muted">{order.type}</Td>
                <Td className="num text-right">{order.quantity}</Td>
                <Td className="num text-right">{order.filledQuantity}</Td>
                <Td className="num text-right">{order.avgFillPrice ?? order.price ?? '—'}</Td>
                <Td><Pill tone={STATUS_TONE[order.status] ?? 'neutral'}>{order.status}</Pill></Td>
                <Td className="max-w-[220px] truncate text-down">{order.rejectReason ?? ''}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>{orders.loading ? 'Loading…' : 'No orders in this window.'}</Empty>
        )}
      </Panel>
    </div>
  );
}

function StatusBars({ title, rows, total }: { title: string; rows: Array<{ label: string; count: number }>; total: number }) {
  return (
    <div>
      <div className="mb-2 text-[10.5px] uppercase tracking-[0.13em] text-faint">{title}</div>
      {!rows.length ? <p className="text-[11.5px] text-faint">No data.</p> : (
        <ul className="space-y-2">
          {rows.slice().sort((a, b) => b.count - a.count).map((row) => (
            <li key={row.label}>
              <div className="flex items-baseline justify-between text-[11.5px]">
                <span className="text-muted">{row.label}</span>
                <span className="num">{row.count.toLocaleString()}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div className={`h-full rounded-full ${row.label === 'REJECTED' ? 'bg-down' : row.label === 'PENDING' ? 'bg-amber' : 'bg-teal'}`}
                  style={{ width: `${total ? (row.count / total) * 100 : 0}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
