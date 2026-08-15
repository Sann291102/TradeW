'use client';

import { useState } from 'react';
import { admin, type OrderRow } from '@/lib/admin/api';
import { Empty, Panel, Pill, Stat, Table, Td, Th, WindowPicker, fmtNum, fmtTime, usePolling } from '../components/ui';

/**
 * Orders & OMS.
 *
 * The question this page exists to answer is not "how much are we trading" —
 * it is "is the order engine healthy". So rejections and stuck PENDING orders
 * are given more room than volume: a rejection spike or an order that has sat
 * unfilled for minutes is invisible from every trader-facing screen and is
 * exactly what an operator is looking for.
 */

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

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">Orders &amp; OMS</h1>
          <p className="text-[12px] text-muted">Order flow, fills and rejections across every account.</p>
        </div>
        <WindowPicker hours={hours} onChange={setHours} />
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Orders placed" value={fmtNum(total)} />
        <Stat label="Fills" value={fmtNum(stats.data?.trades ?? 0)} />
        <Stat
          label="Rejected"
          value={fmtNum(rejected)}
          sub={total ? `${((rejected / total) * 100).toFixed(1)}% of orders` : undefined}
          tone={total && rejected / total > 0.1 ? 'bad' : rejected ? 'warn' : 'good'}
        />
        <Stat
          label="Still pending"
          value={fmtNum(pending)}
          // A PENDING order is normal for a moment and a symptom if it lasts.
          // Called out on its own because nothing else on the platform surfaces it.
          sub={pending ? 'accepted but not yet queued' : 'nothing stuck'}
          tone={pending > 5 ? 'warn' : 'neutral'}
        />
      </div>

      <Panel
        title="Order flow"
        subtitle="By status and side"
      >
        <div className="grid gap-6 p-4 sm:grid-cols-2">
          <StatusBars rows={byStatus.map((s) => ({ label: s.status, count: s.count }))} total={total} />
          <StatusBars
            rows={(stats.data?.bySide ?? []).map((s) => ({ label: s.side, count: s.count }))}
            total={total}
          />
        </div>
      </Panel>

      <Panel
        title="Recent orders"
        subtitle={`${orders.data?.length ?? 0} shown`}
        right={
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal"
          >
            <option value="">All statuses</option>
            {Object.keys(STATUS_TONE).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        }
      >
        {orders.data && orders.data.length > 0 ? (
          <Table
            head={
              <>
                <Th>Time</Th>
                <Th>User</Th>
                <Th>Instrument</Th>
                <Th>Side</Th>
                <Th>Type</Th>
                <Th className="text-right">Qty</Th>
                <Th className="text-right">Filled</Th>
                <Th className="text-right">Price</Th>
                <Th>Status</Th>
                <Th>Reject reason</Th>
              </>
            }
          >
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
                <Td>
                  <Pill tone={STATUS_TONE[order.status] ?? 'neutral'}>{order.status}</Pill>
                </Td>
                {/* The single most useful column on a rejection, and it exists
                    nowhere else in the platform's UI. */}
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

/** Horizontal proportion bars — cheaper to read than a pie at these counts. */
function StatusBars({ rows, total }: { rows: Array<{ label: string; count: number }>; total: number }) {
  if (!rows.length) return <p className="text-[11.5px] text-faint">No data.</p>;
  return (
    <ul className="space-y-2">
      {rows
        .slice()
        .sort((a, b) => b.count - a.count)
        .map((row) => (
          <li key={row.label}>
            <div className="flex items-baseline justify-between text-[11.5px]">
              <span className="text-muted">{row.label}</span>
              <span className="num">{row.count.toLocaleString()}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={`h-full rounded-full ${
                  row.label === 'REJECTED' ? 'bg-down' : row.label === 'PENDING' ? 'bg-amber' : 'bg-teal'
                }`}
                style={{ width: `${total ? (row.count / total) * 100 : 0}%` }}
              />
            </div>
          </li>
        ))}
    </ul>
  );
}
