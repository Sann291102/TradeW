'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  admin,
  type CalibrationRow,
  type ExecutionAccountRow,
  type ExecutionLoopStatus,
  type ExecutionProfileRow,
  type ExecutionRejections,
  type ExecutionStats,
  type ExecutionTrace,
  type JournalRow,
  type LivePositionRow,
  type OrderRow,
  type TraceStage,
} from '@/lib/api';
import {
  Empty, MetricCard, Panel, Pill, StatusIndicator, Table, Td, Th, WindowPicker, ago, fmtNum, fmtTime, usePolling,
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

/**
 * Source is structural: an order links to an execution intent — as the
 * submission of it, or as the square-off that closed it — or it links to
 * neither and a person placed it.
 */
type SourceFilter = '' | 'sentinel' | 'user';

const SOURCE_LABELS: Record<SourceFilter, string> = {
  '': 'All sources',
  sentinel: 'Sentinel (entries + exits)',
  user: 'Manual (user)',
};

export default function AdminOrdersPage() {
  const [hours, setHours] = useState(24);
  const [status, setStatus] = useState<string>('');
  const [source, setSource] = useState<SourceFilter>('');
  const [traceOrderId, setTraceOrderId] = useState<string | null>(null);

  const stats = usePolling(() => admin.orderStats(hours), [hours], 15_000);
  const orders = usePolling(
    () => admin.orders({ hours, status: status || undefined, source: source || undefined, limit: 200 }),
    [hours, status, source],
    8_000,
  );
  const execStats = usePolling(() => admin.execution.stats(hours), [hours], 15_000);
  const profiles = usePolling(() => admin.execution.profiles(), [], 20_000);
  // Faster than the stats poll: this is the "is it alive" read, and a stale
  // liveness indicator is worse than none.
  const loopStatus = usePolling(() => admin.execution.status(), [], 10_000);
  const rejections = usePolling(() => admin.execution.rejections(hours), [hours], 20_000);
  // The fast surfaces. Positions are polled hardest because they are the thing
  // that moves — the management loop re-evaluates every two seconds, and a
  // stop level three refreshes old is a number an operator would act on.
  const positions = usePolling(() => admin.execution.positions(), [], 3_000);
  const journal = usePolling(() => admin.execution.journal({ limit: 25, hours: 24 * 30 }), [], 30_000);
  const calibration = usePolling(() => admin.execution.calibration(), [], 30_000);

  const byStatus = stats.data?.byStatus ?? [];
  const total = byStatus.reduce((sum, s) => sum + s.count, 0);
  const rejected = byStatus.find((s) => s.status === 'REJECTED')?.count ?? 0;
  const pending = byStatus.find((s) => s.status === 'PENDING')?.count ?? 0;
  const open = byStatus
    .filter((s) => s.status === 'OPEN' || s.status === 'TRIGGER_PENDING' || s.status === 'PARTIALLY_FILLED')
    .reduce((n, s) => n + s.count, 0);

  const omsTone = rejected / Math.max(1, total) > 0.1 ? 'bad' : pending > 5 ? 'warn' : stats.data ? 'good' : 'idle';
  const omsLabel =
    rejected / Math.max(1, total) > 0.1 ? 'Elevated rejections' : pending > 5 ? 'Orders queuing' : stats.data ? 'Order flow nominal' : 'Loading…';

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Orders &amp; OMS</h1>
          <p className="text-[12px] text-muted">
            Order flow, fills and rejections across every account — including Sentinel&rsquo;s paper execution.
          </p>
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
        <MetricCard
          label="Rejected"
          accent={rejected ? 'red' : 'green'}
          value={fmtNum(rejected)}
          sub={total ? `${((rejected / total) * 100).toFixed(1)}%` : undefined}
          tone={total && rejected / total > 0.1 ? 'bad' : rejected ? 'warn' : 'good'}
        />
        <MetricCard
          label="Pending"
          accent={pending > 5 ? 'amber' : 'slate'}
          value={fmtNum(pending)}
          sub={pending ? 'not yet queued' : 'nothing stuck'}
          tone={pending > 5 ? 'warn' : 'neutral'}
        />
      </div>

      <ExecutionSummary stats={execStats.data} status={loopStatus.data} loading={execStats.loading} />

      <LivePositions data={positions.data} loading={positions.loading} />

      <RejectionBreakdown data={rejections.data} loading={rejections.loading} hours={hours} />

      <ExecutionProfiles
        profiles={profiles.data}
        loading={profiles.loading}
        onChanged={() => {
          profiles.refresh();
          orders.refresh();
          execStats.refresh();
        }}
      />

      <ExecutionAccounts onChanged={() => { profiles.refresh(); orders.refresh(); }} />

      <TradeJournal data={journal.data} loading={journal.loading} />

      <CalibrationPanel data={calibration.data} loading={calibration.loading} />

      <Panel title="Order flow" subtitle="By status and side">
        <div className="grid gap-6 p-4 sm:grid-cols-2">
          <StatusBars title="By status" rows={byStatus.map((s) => ({ label: s.status, count: s.count }))} total={total} />
          <StatusBars title="By side" rows={(stats.data?.bySide ?? []).map((s) => ({ label: s.side, count: s.count }))} total={total} />
        </div>
      </Panel>

      <Panel
        title="Recent orders"
        subtitle={`${orders.data?.length ?? 0} shown${source ? ` · ${SOURCE_LABELS[source]}` : ''}`}
        right={
          <div className="flex items-center gap-2">
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as SourceFilter)}
              className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal"
            >
              {(Object.keys(SOURCE_LABELS) as SourceFilter[]).map((s) => (
                <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
              ))}
            </select>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal"
            >
              <option value="">All statuses</option>
              {Object.keys(STATUS_TONE).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        }
      >
        {orders.data && orders.data.length > 0 ? (
          <Table head={<>
            <Th>Time</Th><Th>Source</Th><Th>Account</Th><Th>Instrument</Th><Th>Side</Th><Th>Type</Th>
            <Th className="text-right">Qty</Th><Th className="text-right">Filled</Th>
            <Th className="text-right">Price</Th><Th>Status</Th><Th>Sentinel context</Th><Th>Reject reason</Th>
          </>}>
            {orders.data.map((order: OrderRow) => {
              const intent = order.executionIntent;
              // An agent order is an ENTRY or an EXIT. The exit carries its own
              // link (the entry column is unique and already spoken for), and
              // reading only the entry is what made the loop look as though it
              // opened positions and never closed them.
              const exitOf = order.exitOfIntent;
              const agentOrder = intent ?? exitOf;
              return (
                <tr
                  key={order.id}
                  onClick={() => agentOrder && setTraceOrderId(order.id)}
                  className={`transition-colors hover:bg-white/[0.03] ${agentOrder ? 'cursor-pointer' : ''}`}
                  title={agentOrder ? 'Open the execution trace' : undefined}
                >
                  <Td className="num text-muted">{fmtTime(order.placedAt)}</Td>
                  <Td>
                    {intent ? (
                      <Pill tone="info">{intent.environment} · {intent.agent}</Pill>
                    ) : exitOf ? (
                      // Same agent, different act. Told apart rather than
                      // merged: an operator reading this column is asking what
                      // the loop DID, and "closed a position" is not "opened
                      // one".
                      <Pill tone="neutral">{exitOf.environment} · {exitOf.agent} exit</Pill>
                    ) : (
                      <span className="text-faint">Manual</span>
                    )}
                  </Td>
                  <Td className="max-w-[180px] truncate text-muted">{order.user?.email ?? '—'}</Td>
                  <Td className="font-medium">{order.instrument?.symbol ?? '—'}</Td>
                  <Td className={order.side === 'BUY' ? 'text-up' : 'text-down'}>{order.side}</Td>
                  <Td className="text-muted">{order.type}</Td>
                  <Td className="num text-right">{order.quantity}</Td>
                  <Td className="num text-right">{order.filledQuantity}</Td>
                  <Td className="num text-right">{order.avgFillPrice ?? order.price ?? '—'}</Td>
                  <Td><Pill tone={STATUS_TONE[order.status] ?? 'neutral'}>{order.status}</Pill></Td>
                  <Td className="max-w-[280px] truncate text-muted">
                    {intent
                      ? `${intent.bias} ${intent.optionType} ${Number(intent.strike).toFixed(0)} · ${intent.confidence}%${intent.strategyName ? ` · ${intent.strategyName}` : ''}`
                      : exitOf
                        ? `square-off of ${exitOf.optionType} ${Number(exitOf.strike).toFixed(0)} · ${exitOf.profile.name}`
                        : ''}
                  </Td>
                  <Td className="max-w-[220px] truncate text-down">{order.rejectReason ?? ''}</Td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <Empty>{orders.loading ? 'Loading…' : 'No orders in this window.'}</Empty>
        )}
      </Panel>

      {traceOrderId && <TraceDrawer orderId={traceOrderId} onClose={() => setTraceOrderId(null)} />}
    </div>
  );
}

/**
 * Sentinel's own execution scoreboard.
 *
 * Every number is null-tolerant on purpose: before the loop has closed a trade
 * there is no win rate, and showing 0% would assert a losing agent where there
 * is simply no data yet.
 */
function ExecutionSummary({
  stats,
  status,
  loading,
}: {
  stats: ExecutionStats | null;
  status: ExecutionLoopStatus | null;
  loading: boolean;
}) {
  if (loading && !stats) {
    return <Panel title="Sentinel paper execution"><Empty>Loading…</Empty></Panel>;
  }
  if (!stats) return null;

  const decided = stats.wins + stats.losses;
  const pnlTone = stats.realizedPnl > 0 ? 'good' : stats.realizedPnl < 0 ? 'bad' : 'neutral';

  return (
    <Panel
      title="Sentinel paper execution"
      subtitle="Agent-generated decisions in this window"
      right={<LoopIndicator status={status} armed={stats.enabledProfiles} />}
    >
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard
          label="Armed profiles"
          accent={stats.enabledProfiles ? 'teal' : 'slate'}
          value={fmtNum(stats.enabledProfiles)}
          // "Armed" is a database fact; whether anything TICKS is a fact about
          // the API process. Saying "may place paper orders" while the loop is
          // switched off is the exact misreading this sub-line now prevents.
          sub={
            !stats.enabledProfiles
              ? 'none armed'
              : status && !status.enabled
                ? 'armed, but the loop is off'
                : 'may place paper orders'
          }
          tone={stats.enabledProfiles ? (status && !status.enabled ? 'warn' : 'good') : 'neutral'}
        />
        <MetricCard
          label="Intents"
          accent="violet"
          value={fmtNum(stats.byStatus.reduce((n, s) => n + s.count, 0))}
          sub={stats.byStatus.map((s) => `${s.count} ${s.status.toLowerCase()}`).join(' · ') || 'none yet'}
        />
        <MetricCard label="Closed" accent="slate" value={fmtNum(stats.closed)} sub={`${stats.scratches} scratch`} />
        <MetricCard
          label="Win rate"
          accent="green"
          value={stats.winRate === null ? '—' : `${stats.winRate}%`}
          sub={decided ? `${stats.wins}W / ${stats.losses}L` : 'no closed trades yet'}
          tone="neutral"
        />
        <MetricCard
          label="Realized P&L"
          accent={pnlTone === 'good' ? 'green' : pnlTone === 'bad' ? 'red' : 'slate'}
          value={`₹${Math.round(stats.realizedPnl).toLocaleString('en-IN')}`}
          sub="closed outcomes only"
          tone={pnlTone}
        />
      </div>
    </Panel>
  );
}


/**
 * Every position under active management, as the two-second loop last saw it.
 *
 * This is the "watch it cook" surface. Three things on it cannot be derived
 * from any other panel:
 *
 *  · `effectiveStop` — the level an exit will ACTUALLY trigger on, which is
 *    the wider of the initial stop and the trail. Computed server-side, so
 *    this cannot display a different number from the one the manager acts on.
 *  · the DISARMED-but-managed state. Disarming stops entries and does not
 *    abandon an open position, so a row here with a disarmed badge is correct
 *    and important rather than a bug.
 *  · `lastEvaluatedAt` — whether the loop is actually looking at this
 *    position, as opposed to the position merely existing.
 */
function LivePositions({ data, loading }: { data: LivePositionRow[] | null; loading: boolean }) {
  return (
    <Panel
      title="Live positions"
      subtitle="Managed every 2s against the live premium — stop, target, trail and P&L"
      right={
        data && data.length > 0 ? (
          <span className="text-[11px] text-faint">{data.length} open</span>
        ) : undefined
      }
    >
      {loading && !data ? (
        <Empty>Loading…</Empty>
      ) : !data || data.length === 0 ? (
        <Empty>
          No position is open. The agents evaluate on their own cadence; an open position appears here within
          seconds of a fill.
        </Empty>
      ) : (
        <Table
            head={
              <>
              <Th>Agent</Th>
              <Th>Contract</Th>
              <Th>Strategy</Th>
              <Th className="text-right">Qty</Th>
              <Th className="text-right">Entry</Th>
              <Th className="text-right">Last</Th>
              <Th className="text-right">Stop</Th>
              <Th className="text-right">Target</Th>
              <Th className="text-right">Trail</Th>
              <Th className="text-right">P&amp;L</Th>
              <Th>State</Th>
            </>
            }
          >
            {data.map((p) => {
              const trailing = p.trailPrice != null && p.effectiveStop > p.stopPrice;
              const pnl = p.unrealizedPnl ?? 0;
              return (
                <tr key={p.positionId}>
                  <Td>
                    <div className="font-medium">{p.profileName}</div>
                    <div className="text-[11px] text-faint">
                      {p.agent}
                      {!p.profileEnabled && (
                        <>
                          {' · '}
                          {/* The state the disarm fix creates, made visible. An
                              operator seeing this needs to know the position is
                              still being managed, not stranded. */}
                          <span className="text-amber">disarmed — still managed to exit</span>
                        </>
                      )}
                    </div>
                  </Td>
                  <Td>
                    <div className="font-mono text-[12px]">{p.contractSymbol}</div>
                    <div className="text-[11px] text-faint">
                      {p.symbol} {p.strike} {p.optionType} · index {p.indexDirection ?? 'unknown'}
                    </div>
                  </Td>
                  <Td>
                    <div className="text-[12px]">{p.strategyName ?? p.strategyId ?? '—'}</div>
                    <div className="text-[11px] text-faint">
                      v{p.strategyVersion ?? '?'} · {p.regime ?? 'regime unknown'} · {p.confidence}%
                    </div>
                  </Td>
                  <Td className="text-right">{fmtNum(p.quantity)}</Td>
                  <Td className="text-right">{p.entryPrice.toFixed(2)}</Td>
                  <Td className="text-right">
                    <div>{p.lastPrice != null ? p.lastPrice.toFixed(2) : '—'}</div>
                    <div className="text-[11px] text-faint">{p.lastEvaluatedAt ? ago(p.lastEvaluatedAt) : 'not yet evaluated'}</div>
                  </Td>
                  <Td className="text-right">
                    <span className={trailing ? 'text-up' : undefined}>{p.effectiveStop.toFixed(2)}</span>
                    {trailing && <div className="text-[11px] text-faint">initial {p.stopPrice.toFixed(2)}</div>}
                  </Td>
                  <Td className="text-right">{p.targetPrice.toFixed(2)}</Td>
                  <Td className="text-right">
                    {p.trailPrice != null ? (
                      <>
                        <div>{p.trailPrice.toFixed(2)}</div>
                        <div className="text-[11px] text-faint">{p.trailSteps} × {p.trailStepPoints}pt</div>
                      </>
                    ) : (
                      <span className="text-faint">not yet</span>
                    )}
                  </Td>
                  <Td className="text-right">
                    <span className={pnl > 0 ? 'text-up' : pnl < 0 ? 'text-down' : undefined}>
                      {pnl >= 0 ? '+' : ''}{fmtNum(Math.round(pnl))}
                    </span>
                  </Td>
                  <Td>
                    <Pill tone={p.state === 'OPEN' ? 'info' : 'warn'}>{p.state}</Pill>
                    {p.exitReason && <div className="text-[11px] text-faint">{p.exitReason}</div>}
                  </Td>
                </tr>
              );
            })}
          </Table>
      )}
    </Panel>
  );
}

/**
 * Completed automated trades, newest first.
 *
 * Every column here answers one of the questions the trade journal exists for:
 * why it entered (strategy, index direction, confidence), what it risked
 * (initial stop against the risk budget), what happened (exit reason, R), and
 * what it taught (the calibration version this outcome produced).
 */
function TradeJournal({ data, loading }: { data: JournalRow[] | null; loading: boolean }) {
  return (
    <Panel title="Trade journal" subtitle="Completed automated paper trades — entry, exit, R and what each taught">
      {loading && !data ? (
        <Empty>Loading…</Empty>
      ) : !data || data.length === 0 ? (
        <Empty>No automated trade has completed yet. A journal entry is written when a position closes.</Empty>
      ) : (
        <Table
            head={
              <>
              <Th>Closed</Th>
              <Th>Agent / strategy</Th>
              <Th>Contract</Th>
              <Th className="text-right">Entry</Th>
              <Th className="text-right">Exit</Th>
              <Th>Why it exited</Th>
              <Th className="text-right">P&amp;L</Th>
              <Th className="text-right">R</Th>
              <Th>Taught</Th>
            </>
            }
          >
            {data.map((j) => (
              <tr key={j.id}>
                <Td>
                  <div>{j.exitAt ? fmtTime(j.exitAt) : '—'}</div>
                  <div className="text-[11px] text-faint">
                    {j.holdingSeconds != null ? `held ${Math.round(j.holdingSeconds / 60)}m` : ''}
                  </div>
                </Td>
                <Td>
                  <div className="text-[12px]">{j.strategyName ?? j.strategyId ?? '—'}</div>
                  <div className="text-[11px] text-faint">
                    {j.agent} · v{j.strategyVersion ?? '?'} · {j.regime ?? '?'} · {j.confidence}% · index {j.indexDirection ?? '?'}
                  </div>
                </Td>
                <Td className="font-mono text-[12px]">{j.contractSymbol}</Td>
                <Td className="text-right">{j.entryPrice.toFixed(2)}</Td>
                <Td className="text-right">{j.exitPrice != null ? j.exitPrice.toFixed(2) : '—'}</Td>
                <Td>
                  <Pill tone={j.exitReason === 'TARGET' ? 'good' : j.exitReason === 'STOP' ? 'bad' : 'info'}>
                    {j.exitReason}
                  </Pill>
                  {j.initialStop != null && (
                    <div className="text-[11px] text-faint">
                      stop {j.initialStop.toFixed(2)} · target {j.initialTarget?.toFixed(2) ?? '—'}
                      {j.finalTrail != null ? ` · trailed to ${j.finalTrail.toFixed(2)}` : ''}
                    </div>
                  )}
                </Td>
                <Td className="text-right">
                  <span className={j.realizedPnl > 0 ? 'text-up' : j.realizedPnl < 0 ? 'text-down' : undefined}>
                    {j.realizedPnl >= 0 ? '+' : ''}{fmtNum(Math.round(j.realizedPnl))}
                  </span>
                </Td>
                <Td className="text-right">{j.rMultiple != null ? `${j.rMultiple >= 0 ? '+' : ''}${j.rMultiple.toFixed(2)}R` : '—'}</Td>
                <Td>
                  {j.calibrationVersion != null ? (
                    <span className="text-[11px] text-faint">v{j.calibrationVersion}</span>
                  ) : (
                    <span className="text-[11px] text-faint">no bucket</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
      )}
    </Panel>
  );
}

/**
 * What each (agent, symbol, strategy, version, regime) bucket has learned.
 *
 * The `active` column is the one that stops this being read as more than it
 * is: below the sample floor a bucket has results but is NOT allowed to move
 * anything, and "0 because it learned nothing" and "0 because it has not been
 * allowed to yet" are different facts.
 */
function CalibrationPanel({ data, loading }: { data: CalibrationRow[] | null; loading: boolean }) {
  return (
    <Panel
      title="Learning"
      subtitle="What each strategy/regime bucket has learned — bounded to the entry floor, never below the platform's 70%"
    >
      {loading && !data ? (
        <Empty>Loading…</Empty>
      ) : !data || data.length === 0 ? (
        <Empty>Nothing learned yet. A bucket appears when its first automated trade closes.</Empty>
      ) : (
        <Table
            head={
              <>
              <Th>Bucket</Th>
              <Th className="text-right">Trades</Th>
              <Th className="text-right">W / L / S</Th>
              <Th className="text-right">Avg R</Th>
              <Th className="text-right">Gross P&amp;L</Th>
              <Th className="text-right">Floor adj.</Th>
              <Th>State</Th>
            </>
            }
          >
            {data.map((c) => (
              <tr key={c.key}>
                <Td>
                  <div className="text-[12px]">{c.strategyId} <span className="text-faint">v{c.strategyVersion}</span></div>
                  <div className="text-[11px] text-faint">{c.agent} · {c.symbol} · {c.regime}</div>
                </Td>
                <Td className="text-right">{fmtNum(c.trades)}</Td>
                <Td className="text-right text-[12px]">{c.wins} / {c.losses} / {c.scratches}</Td>
                <Td className="text-right">
                  {c.avgRMultiple != null ? (
                    <span className={c.avgRMultiple > 0 ? 'text-up' : c.avgRMultiple < 0 ? 'text-down' : undefined}>
                      {c.avgRMultiple >= 0 ? '+' : ''}{c.avgRMultiple.toFixed(2)}R
                    </span>
                  ) : '—'}
                </Td>
                <Td className="text-right">
                  <span className={c.grossPnl > 0 ? 'text-up' : c.grossPnl < 0 ? 'text-down' : undefined}>
                    {c.grossPnl >= 0 ? '+' : ''}{fmtNum(Math.round(c.grossPnl))}
                  </span>
                </Td>
                <Td className="text-right">
                  {c.confidenceAdjustment === 0 ? (
                    <span className="text-faint">0</span>
                  ) : (
                    <span className={c.confidenceAdjustment > 0 ? 'text-amber' : 'text-up'}>
                      {c.confidenceAdjustment > 0 ? '+' : ''}{c.confidenceAdjustment} pt
                    </span>
                  )}
                </Td>
                <Td>
                  {c.active ? (
                    <Pill tone="info">applied</Pill>
                  ) : (
                    <span className="text-[11px] text-faint">
                      {c.trades}/{c.sampleFloor} trades — not yet applied
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
      )}
    </Panel>
  );
}

/**
 * Armed, or armed AND ticking?
 *
 * Two switches decide whether the loop runs, and they live in different places:
 * a profile's `enabled` column (a row an operator can see and toggle) and
 * `PAPER_EXECUTION_ENABLED` on the API process (which no query can reach). The
 * console used to show only the first, so an armed profile looked identical
 * whether it was being evaluated every minute or had never been looked at —
 * and the only hint was a footnote in small print under the profile table.
 *
 * Reported with the leader lease, because a replica that is not the leader also
 * does not tick, and "enabled but not leading" is a perfectly ordinary state on
 * a two-replica deployment that would otherwise look like a broken loop.
 */
function LoopIndicator({ status, armed }: { status: ExecutionLoopStatus | null; armed: number }) {
  if (!status) return <StatusIndicator label="Loop state unknown" tone="idle" pulse={false} />;

  if (!status.enabled) {
    return (
      <div className="flex items-center gap-2">
        <StatusIndicator label="Loop off — PAPER_EXECUTION_ENABLED is not true" tone="warn" pulse={false} />
        {armed > 0 && (
          <span className="text-[11px] text-faint">
            {armed} profile{armed === 1 ? '' : 's'} armed and waiting
          </span>
        )}
      </div>
    );
  }

  // Enabled but not holding the lease: another replica is doing the work.
  if (!status.isEvaluateLeader) {
    return <StatusIndicator label="Loop on — another replica holds the lease" tone="info" pulse={false} />;
  }

  const last = status.lastEvaluateAt;
  const intervalMs = status.intervalMs ?? 60_000;
  // Two missed ticks is the threshold: one is a slow Sentinel evaluation
  // (routine — the pass can outlast the interval and the guard skips it), two
  // is a loop that has stopped advancing.
  const overdue = last != null && Date.now() - new Date(last).getTime() > intervalMs * 2 + 30_000;

  return (
    <div className="flex items-center gap-2">
      <StatusIndicator
        label={
          last === null
            ? `Loop on — no pass yet (every ${Math.round(intervalMs / 1000)}s)`
            : overdue
              ? `Loop stalled — last pass ${ago(last)}`
              : `Loop ticking — last pass ${ago(last)}`
        }
        tone={overdue ? 'bad' : 'good'}
        pulse={!overdue}
      />
      {status.evaluating && <span className="text-[11px] text-teal">pass in flight</span>}
    </div>
  );
}

/**
 * "Why did nothing trade today?", as one panel.
 *
 * Every refusal here was always recorded — on the intent, in a sentence written
 * for someone reading that one intent. What was missing was the ABILITY TO
 * COUNT them: the sentence interpolates live numbers, so two refusals for the
 * same reason are different strings. On 2026-08-18 that gap cost a full
 * end-to-end audit of a read path that turned out to be clean; the orders were
 * never written, and the reason was sitting on 40-odd intents one click apart.
 *
 * Deliberately not hidden when empty — "no refusals in this window" is an
 * answer an operator came here for, and a panel that vanishes looks like a
 * panel that failed to load.
 */
function RejectionBreakdown({
  data,
  loading,
  hours,
}: {
  data: ExecutionRejections | null;
  loading: boolean;
  hours: number;
}) {
  if (loading && !data) {
    return <Panel title="Why decisions did not become orders"><Empty>Loading…</Empty></Panel>;
  }
  if (!data) return null;

  if (data.total === 0) {
    return (
      <Panel title="Why decisions did not become orders" subtitle={`Last ${hours}h`}>
        <Empty>No decision was refused in this window.</Empty>
      </Panel>
    );
  }

  const max = Math.max(...data.buckets.map((b) => b.count), 1);

  return (
    <Panel
      title="Why decisions did not become orders"
      subtitle={`${fmtNum(data.total)} refused in the last ${hours}h, by the gate that stopped them`}
    >
      <div className="flex flex-col gap-2 p-4">
        {data.buckets.map((b) => (
          <div key={b.checkId ?? 'unrecorded'} className="grid grid-cols-[190px_1fr_auto] items-center gap-3">
            <div className="truncate text-[12px] text-muted" title={b.checkId ?? undefined}>
              {b.label}
            </div>
            <div className="h-[18px] overflow-hidden rounded-sm bg-white/[0.04]">
              <div
                className={`h-full ${b.checkId === 'daily-loss-limit' || b.checkId === 'submission-raised' ? 'bg-down/60' : 'bg-teal/50'}`}
                style={{ width: `${Math.max(4, (b.count / max) * 100)}%` }}
              />
            </div>
            <div className="num text-right text-[12px] tabular-nums">{fmtNum(b.count)}</div>
            {/* The full sentence behind the most recent one in this bucket —
                the numbers the id cannot carry. */}
            {b.lastReason && (
              <p className="col-span-3 -mt-1 pl-[202px] text-[11px] leading-relaxed text-faint">
                {b.lastProfileName ? `${b.lastProfileName}: ` : ''}
                {b.lastReason}
                {b.lastAt ? ` (${ago(b.lastAt)})` : ''}
              </p>
            )}
          </div>
        ))}
      </div>
      <p className="border-t border-white/[0.06] px-4 py-2 text-[11px] text-faint">
        A refusal is the system working: the gates are what stop an agent trading past its limits. Intents
        accumulating with no orders is the expected shape when a daily bound has been hit — see the profile&rsquo;s
        policy column for the bound itself.
      </p>
    </Panel>
  );
}

/** The armed/disarmed switch and a manual pass, per profile. */
function ExecutionProfiles({
  profiles,
  loading,
  onChanged,
}: {
  profiles: ExecutionProfileRow[] | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const toggle = async (p: ExecutionProfileRow) => {
    setBusy(p.id);
    setNote(null);
    try {
      await admin.execution.setEnabled(p.id, !p.enabled);
      onChanged();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (p: ExecutionProfileRow) => {
    setBusy(p.id);
    setNote(null);
    try {
      const result = await admin.execution.run(p.id);
      setNote(`${p.name}: ${result.outcome} — ${result.reason}`);
      onChanged();
    } catch (err) {
      setNote(`${p.name}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Execution profiles" subtitle="Agent → strategy → market → paper account">
      {profiles && profiles.length > 0 ? (
        <>
          <Table head={<>
            <Th>Profile</Th><Th>Agent</Th><Th>Market</Th><Th>Env</Th><Th>Scope</Th><Th>TradeW account</Th>
            <Th className="text-right">Cash</Th><Th className="text-right">Realized</Th>
            <Th className="text-right">Open</Th><Th className="text-right">Today</Th><Th>Policy</Th><Th /></>}>
            {profiles.map((p) => (
              <tr key={p.id} className="transition-colors hover:bg-white/[0.03]">
                <Td className="font-medium">{p.name}</Td>
                <Td className="text-muted">{p.agent}</Td>
                <Td>{p.symbol}</Td>
                <Td><Pill tone={p.environment === 'PAPER' ? 'info' : 'bad'}>{p.environment}</Pill></Td>
                <Td>
                  <Pill tone={p.accountScope === 'USER_PAPER' ? 'good' : 'neutral'}>
                    {p.accountScope === 'USER_PAPER' ? 'USER' : 'SYSTEM'}
                  </Pill>
                </Td>
                <Td className="max-w-[240px]">
                  <div className="truncate text-muted">{p.account.email}</div>
                  {/* Consent state, shown only where it means something. A system
                      account has no holder to consent, so a "not granted" pill
                      there would read as a problem rather than as not-applicable. */}
                  {p.accountScope === 'USER_PAPER' && (
                    <div className="mt-0.5">
                      {p.account.agentPaperTradingEnabled
                        ? <span className="text-[10.5px] text-up">agent trading allowed</span>
                        : <span className="text-[10.5px] text-down">consent not granted — passes will be refused</span>}
                    </div>
                  )}
                </Td>
                <Td className="num text-right">{p.wallet ? `₹${Math.round(p.wallet.cashBalance).toLocaleString('en-IN')}` : '—'}</Td>
                <Td className={`num text-right ${p.wallet && p.wallet.realizedPnl < 0 ? 'text-down' : p.wallet && p.wallet.realizedPnl > 0 ? 'text-up' : ''}`}>
                  {p.wallet ? `₹${Math.round(p.wallet.realizedPnl).toLocaleString('en-IN')}` : '—'}
                </Td>
                <Td className="num text-right">{p.openPositions}/{p.policy.maxOpenPositions}</Td>
                <Td className="num text-right">{p.intentsToday}/{p.policy.maxOrdersPerDay}</Td>
                <Td className="text-[11px] text-faint">
                  {p.policy.lots} lot · ≥{p.policy.minConfidence}% · {p.policy.productType}/{p.policy.orderType}
                </Td>
                <Td>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      disabled={busy === p.id}
                      onClick={() => void runNow(p)}
                      className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-muted hover:border-teal hover:text-white disabled:opacity-40"
                    >
                      Run pass
                    </button>
                    <button
                      disabled={busy === p.id}
                      onClick={() => void toggle(p)}
                      className={`rounded-md border px-2 py-1 text-[11px] disabled:opacity-40 ${
                        p.enabled
                          ? 'border-down/40 text-down hover:bg-down/10'
                          : 'border-up/40 text-up hover:bg-up/10'
                      }`}
                    >
                      {p.enabled ? 'Disarm' : 'Arm'}
                    </button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
          {note && <p className="border-t border-white/[0.06] px-4 py-2 text-[11.5px] text-muted">{note}</p>}
          <p className="border-t border-white/[0.06] px-4 py-2 text-[11px] text-faint">
            Arming a profile is one of two switches. The API must also run with{' '}
            <code className="text-muted">PAPER_EXECUTION_ENABLED=true</code> before the loop ticks on its own —
            the indicator beside &ldquo;Sentinel paper execution&rdquo; above reports which state it is actually in.
            &ldquo;Run pass&rdquo; works either way and applies every policy gate. A{' '}
            <strong className="text-muted">USER</strong> profile trades a real TradeW account: its orders,
            positions and P&amp;L appear in that user&rsquo;s own app, because both read the same records.
          </p>
        </>
      ) : (
        <Empty>{loading ? 'Loading…' : 'No execution profiles configured.'}</Empty>
      )}
    </Panel>
  );
}

/**
 * TradeW accounts an agent may be bound to, and the consent switch.
 *
 * Nothing here handles a credential. Accounts are addressed by internal id, the
 * API does not select `passwordHash`/`googleId` at all, and there is no password
 * field anywhere in this flow by design — binding is an identity reference, not
 * an impersonation.
 */
function ExecutionAccounts({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const accounts = usePolling(() => (open ? admin.execution.accounts(q || undefined) : Promise.resolve([])), [open, q], 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [binding, setBinding] = useState<ExecutionAccountRow | null>(null);

  const toggleConsent = async (a: ExecutionAccountRow) => {
    setBusy(a.id);
    setNote(null);
    try {
      await admin.execution.setAgentTrading(a.id, !a.agentPaperTradingEnabled);
      accounts.refresh();
      onChanged();
      setNote(`${a.email}: agent paper trading ${a.agentPaperTradingEnabled ? 'revoked' : 'granted'}.`);
    } catch (err) {
      setNote(`${a.email}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="TradeW accounts"
      subtitle="Bind an agent to a real user's paper account"
      right={
        <button
          onClick={() => setOpen(!open)}
          className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-muted hover:border-teal hover:text-white"
        >
          {open ? 'Hide' : 'Show accounts'}
        </button>
      }
    >
      {!open ? (
        <p className="px-4 py-3 text-[11.5px] text-faint">
          Grant a TradeW user agent paper trading, then bind an execution profile to their account. The resulting
          orders belong to that user and appear in their own app — there is no second account and no copy.
        </p>
      ) : (
        <>
          <div className="border-b border-white/[0.06] px-4 py-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by email…"
              className="w-full max-w-[320px] rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal"
            />
          </div>
          {accounts.data && accounts.data.length > 0 ? (
            <Table head={<>
              <Th>TradeW account</Th><Th>Agent trading</Th>
              <Th className="text-right">Cash</Th><Th className="text-right">Realized</Th>
              <Th className="text-right">Orders</Th><Th className="text-right">Positions</Th>
              <Th className="text-right">Profiles</Th><Th /></>}>
              {accounts.data.map((a) => (
                <tr key={a.id} className="transition-colors hover:bg-white/[0.03]">
                  <Td className="max-w-[260px] truncate font-medium">{a.email}</Td>
                  <Td>
                    {a.agentPaperTradingEnabled
                      ? <Pill tone="good">allowed</Pill>
                      : <Pill tone="neutral">not granted</Pill>}
                  </Td>
                  <Td className="num text-right">{a.wallet ? `₹${Math.round(a.wallet.cashBalance).toLocaleString('en-IN')}` : '—'}</Td>
                  <Td className={`num text-right ${a.wallet && a.wallet.realizedPnl < 0 ? 'text-down' : a.wallet && a.wallet.realizedPnl > 0 ? 'text-up' : ''}`}>
                    {a.wallet ? `₹${Math.round(a.wallet.realizedPnl).toLocaleString('en-IN')}` : '—'}
                  </Td>
                  <Td className="num text-right">{a.orders}</Td>
                  <Td className="num text-right">{a.positions}</Td>
                  <Td className="num text-right">{a.boundProfiles}</Td>
                  <Td>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        disabled={busy === a.id}
                        onClick={() => setBinding(a)}
                        className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-muted hover:border-teal hover:text-white disabled:opacity-40"
                      >
                        Bind profile
                      </button>
                      <button
                        disabled={busy === a.id}
                        onClick={() => void toggleConsent(a)}
                        className={`rounded-md border px-2 py-1 text-[11px] disabled:opacity-40 ${
                          a.agentPaperTradingEnabled
                            ? 'border-down/40 text-down hover:bg-down/10'
                            : 'border-up/40 text-up hover:bg-up/10'
                        }`}
                      >
                        {a.agentPaperTradingEnabled ? 'Revoke' : 'Allow agent trading'}
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty>{accounts.loading ? 'Loading…' : 'No matching TradeW accounts.'}</Empty>
          )}
          {note && <p className="border-t border-white/[0.06] px-4 py-2 text-[11.5px] text-muted">{note}</p>}
        </>
      )}

      {binding && (
        <BindProfileDialog
          account={binding}
          onClose={() => setBinding(null)}
          onSaved={(msg) => {
            setNote(msg);
            setBinding(null);
            accounts.refresh();
            onChanged();
          }}
        />
      )}
    </Panel>
  );
}

/** Create/rebind a USER_PAPER profile for one account. No credential fields. */
function BindProfileDialog({
  account, onClose, onSaved,
}: { account: ExecutionAccountRow; onClose: () => void; onSaved: (message: string) => void }) {
  const suffix = account.email.split('@')[0].replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const [name, setName] = useState(`sentinel-alpha-nifty-${suffix}`);
  const [agent, setAgent] = useState('sentinel-alpha');
  const [symbol, setSymbol] = useState('NIFTY');
  const [lots, setLots] = useState(1);
  const [minConfidence, setMinConfidence] = useState(70);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await admin.execution.upsertProfile({
        name, agent, symbol,
        accountUserId: account.id,
        // Always USER_PAPER from this dialog — it is reached from a real
        // TradeW account. Environment is not sent at all: the server writes
        // PAPER and the enum has no other member.
        accountScope: 'USER_PAPER',
        lots, minConfidence,
      });
      onSaved(`Profile "${name}" bound to ${account.email} (created disarmed — arm it above).`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-[480px] rounded-lg border border-white/10 bg-[#0b0e11] p-5 shadow-2xl">
        <h3 className="text-[14px] font-semibold">Bind execution profile</h3>
        <p className="mt-1 text-[11.5px] text-muted">
          Orders will belong to <span className="text-white">{account.email}</span> and appear in that user&rsquo;s
          own TradeW app. Environment is <Pill tone="info">PAPER</Pill> and cannot be changed.
        </p>
        {!account.agentPaperTradingEnabled && (
          <p className="mt-2 rounded-md border border-down/30 bg-down/10 px-3 py-2 text-[11.5px] text-down">
            This account has not been granted agent paper trading. Saving will be refused until it is.
          </p>
        )}

        <div className="mt-4 space-y-3">
          <Field label="Profile name"><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Field>
          <Field label="Agent"><input value={agent} onChange={(e) => setAgent(e.target.value)} className={inputCls} /></Field>
          <Field label="Market"><input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Lots"><input type="number" min={1} value={lots} onChange={(e) => setLots(Number(e.target.value))} className={inputCls} /></Field>
            <Field label="Min confidence %"><input type="number" min={70} max={100} value={minConfidence} onChange={(e) => setMinConfidence(Number(e.target.value))} className={inputCls} /></Field>
          </div>
        </div>

        {error && <p className="mt-3 text-[11.5px] text-down">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-white/10 px-3 py-1.5 text-[11.5px] text-muted hover:text-white">Cancel</button>
          <button disabled={saving} onClick={() => void save()} className="rounded-md border border-teal/50 bg-teal/10 px-3 py-1.5 text-[11.5px] text-teal hover:bg-teal/20 disabled:opacity-40">
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls = 'w-full rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-[12px] outline-none focus:border-teal';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] uppercase tracking-[0.13em] text-faint">{label}</span>
      {children}
    </label>
  );
}

/**
 * The execution trace for one order.
 *
 * Renders exactly what the API returned. A stage with `present: false` is drawn
 * dimmed with its own explanation rather than hidden — an operator has to be
 * able to see WHERE a lifecycle stopped, and a timeline that silently omits the
 * missing stages looks complete when it is not.
 */
function TraceDrawer({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [trace, setTrace] = useState<ExecutionTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>('strikes');

  const load = useCallback(async () => {
    try {
      setTrace(await admin.execution.traceByOrder(orderId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [orderId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-[720px] overflow-y-auto border-l border-white/10 bg-[#0b0e11] shadow-2xl"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-white/10 bg-[#0b0e11] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">Execution trace</h2>
            {trace && (
              <p className="mt-0.5 text-[11.5px] text-muted">
                {trace.contractSymbol} · {trace.profileName} · {trace.agent} ·{' '}
                <Pill tone="info">{trace.environment}</Pill> <Pill tone="neutral">{trace.status}</Pill>
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-muted hover:text-white">
            Close
          </button>
        </header>

        {error && <p className="px-5 py-6 text-[12px] text-down">{error}</p>}
        {!trace && !error && <p className="px-5 py-6 text-[12px] text-muted">Loading…</p>}

        {trace && (
          <ol className="space-y-0 px-5 py-4">
            {trace.stages.map((stage, i) => (
              <TraceStageRow
                key={stage.id}
                stage={stage}
                last={i === trace.stages.length - 1}
                open={expanded === stage.id}
                onToggle={() => setExpanded(expanded === stage.id ? null : stage.id)}
              />
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}

function TraceStageRow({
  stage, last, open, onToggle,
}: { stage: TraceStage; last: boolean; open: boolean; onToggle: () => void }) {
  const hasDetail = stage.detail != null && Object.keys(stage.detail).length > 0;
  return (
    <li className="relative pl-6">
      {!last && <span className="absolute left-[5px] top-4 h-full w-px bg-white/10" aria-hidden />}
      <span
        className={`absolute left-0 top-[7px] h-[11px] w-[11px] rounded-full border-2 ${
          stage.present ? 'border-teal bg-teal/30' : 'border-white/20 bg-transparent'
        }`}
        aria-hidden
      />
      <div className={`pb-4 ${stage.present ? '' : 'opacity-55'}`}>
        <button onClick={onToggle} disabled={!hasDetail} className="w-full text-left disabled:cursor-default">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12.5px] font-medium">{stage.label}</span>
            <span className="shrink-0 text-[10.5px] text-faint">{stage.at ? fmtTime(stage.at) : ''}</span>
          </div>
          <p className="mt-0.5 text-[11.5px] text-muted">{stage.summary}</p>
          {hasDetail && (
            <span className="mt-1 inline-block text-[10.5px] text-faint">{open ? '▾ hide detail' : '▸ show detail'}</span>
          )}
        </button>
        {open && hasDetail && (
          <pre className="mt-2 max-h-[320px] overflow-auto rounded-md border border-white/[0.07] bg-black/40 p-3 text-[10.5px] leading-relaxed text-muted">
            {JSON.stringify(stage.detail, null, 2)}
          </pre>
        )}
      </div>
    </li>
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
