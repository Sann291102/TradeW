'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  admin,
  type ExecutionAccountRow,
  type ExecutionLoopStatus,
  type ExecutionProfileRow,
  type ExecutionProfileState,
  type ExecutionRejections,
  type ExecutionRunRow,
  type ExecutionStateAction,
  type ExecutionStats,
  type ExecutionTrace,
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
 * How each execution state is coloured.
 *
 * The map is exhaustive on purpose. The previous UI rendered one boolean as a
 * green/red pill, so DISABLED, DISARMED, PAUSED and ERROR were one colour and
 * PAPER_ARMED, PAPER_RUNNING, PAPER_QUALIFIED, LIVE_ARMED and LIVE_RUNNING were
 * another — an operator could not tell "armed but never run" from "trading
 * live" at a glance. §23 names that failure directly.
 *
 * LIVE is the only state that gets `warn`, and it gets it even when everything
 * is healthy: a live-armed profile is not a normal condition, and colouring it
 * the same reassuring green as paper would be the interface quietly telling an
 * operator that real money is fine.
 */
const STATE_TONE: Record<ExecutionProfileState, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  DISABLED: 'neutral',
  PAPER_ARMED: 'info',
  PAPER_RUNNING: 'good',
  PAPER_QUALIFIED: 'good',
  LIVE_ARMED: 'warn',
  LIVE_RUNNING: 'warn',
  PAUSED: 'warn',
  DISARMED: 'neutral',
  ERROR: 'bad',
};

/** Short badge text. The long form is `stateLabel`, shown as a tooltip. */
const STATE_SHORT: Record<ExecutionProfileState, string> = {
  DISABLED: 'DISABLED',
  PAPER_ARMED: 'PAPER · ARMED',
  PAPER_RUNNING: 'PAPER · RUNNING',
  PAPER_QUALIFIED: 'PAPER · QUALIFIED',
  LIVE_ARMED: 'LIVE · ARMED',
  LIVE_RUNNING: 'LIVE · RUNNING',
  PAUSED: 'PAUSED',
  DISARMED: 'DISARMED',
  ERROR: 'ERROR',
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
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
        <MetricCard
          label="Armed profiles"
          accent={stats.enabledProfiles ? 'teal' : 'slate'}
          value={fmtNum(stats.enabledProfiles)}
          // "Armed" is a database fact; whether anything TICKS is a fact about
          // the API process. Saying "may place orders" while the loop has been
          // killed is the exact misreading this sub-line prevents.
          sub={
            !stats.enabledProfiles
              ? 'none armed'
              : status && !status.enabled
                ? 'armed, but the loop is stopped'
                : 'executing automatically'
          }
          tone={stats.enabledProfiles ? (status && !status.enabled ? 'warn' : 'good') : 'neutral'}
        />
        <MetricCard
          label="Passes"
          accent="teal"
          live
          value={fmtNum(stats.passes)}
          // The number that separates "quiet market" from "dead loop". Intents
          // alone cannot: both read zero.
          sub={
            stats.passes === 0
              ? 'the loop has not run'
              : stats.byRunOutcome
                  .slice()
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 2)
                  .map((r) => `${r.count} ${r.outcome.replace('skipped-', '')}`)
                  .join(' · ')
          }
          tone={stats.passes === 0 && stats.enabledProfiles > 0 ? 'warn' : 'neutral'}
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

      {/* The state census. A count per state, so "5 armed" can never hide
          "4 paused and 1 faulted" — the conflation §23 calls out. */}
      {stats.byState.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] px-4 py-2.5">
          <span className="text-[11px] uppercase tracking-wide text-faint">States</span>
          {stats.byState
            .slice()
            .sort((a, b) => b.count - a.count)
            .map((s) => (
              <span key={s.state} className="inline-flex items-center gap-1">
                <Pill tone={STATE_TONE[s.state] ?? 'neutral'}>{STATE_SHORT[s.state] ?? s.state}</Pill>
                <span className="num text-[11px] text-muted">{s.count}</span>
              </span>
            ))}
          {stats.liveArmedProfiles > 0 && (
            <span className="ml-auto text-[11px] font-medium text-amber">
              {stats.liveArmedProfiles} profile{stats.liveArmedProfiles === 1 ? '' : 's'} authorized for LIVE broker orders
            </span>
          )}
        </div>
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
        {/* The kill switch, not the arm switch. It defaults to ON now — arming
            a profile is the deliberate act, and this variable exists to stop a
            deployment that must never execute. So seeing it here means someone
            set it explicitly. */}
        <StatusIndicator label="Loop STOPPED — PAPER_EXECUTION_ENABLED is set to false" tone="bad" pulse={false} />
        {armed > 0 && (
          <span className="text-[11px] text-down">
            {armed} profile{armed === 1 ? '' : 's'} armed and NOT executing
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
      {/* Whether the LIVE adapter is reachable on this deployment at all. A
          separate, off-by-default switch from the loop's own — see
          ExecutionAdapterResolver. Shown always, because "live is blocked here"
          is as important to know as "live is permitted". */}
      <Pill tone={status.liveEnabled ? 'warn' : 'neutral'}>
        {status.liveEnabled ? 'LIVE PERMITTED' : 'LIVE BLOCKED'}
      </Pill>
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

/**
 * The execution state machine, per profile — the console surface §2, §7 and
 * §15 are about.
 *
 * ## What changed, and why the old version was not enough
 *
 * This panel used to render one boolean (`enabled`) as one Arm/Disarm button.
 * That control existed, was audited, and was still not "the complete execution
 * capability" §2 asks for: it could not pause without disarming, could not tell
 * an operator whether the profile had ever actually run, could not express live
 * authorization at all, and gave a faulted profile the same green pill as a
 * healthy one.
 *
 * Every control below maps to one server-side ACTION. The client never names a
 * target state — see `admin.execution.transition` — so a button the server
 * would refuse is simply not offered, and a button the client offers anyway is
 * still refused by `evaluateTransition`.
 *
 * ## ARM LIVE is deliberately awkward
 *
 * It appears only for a PAPER_QUALIFIED profile whose stored snapshot passes,
 * it is styled as a warning rather than an affirmative action, and it asks for
 * confirmation naming the account. Real money should not be one indistinct
 * click away from paper money.
 */
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
  const [expanded, setExpanded] = useState<string | null>(null);

  const act = async (p: ExecutionProfileRow, action: ExecutionStateAction, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(p.id);
    setNote(null);
    try {
      const result = await admin.execution.transition(p.id, action);
      setNote(
        result.changed
          ? `${p.name}: ${result.from} → ${result.to}.`
          : `${p.name}: no change — ${result.reason ?? 'already in that state'}.`,
      );
      onChanged();
    } catch (err) {
      setNote(`${p.name}: ${(err as Error).message}`);
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

  const evaluate = async (p: ExecutionProfileRow) => {
    setBusy(p.id);
    setNote(null);
    try {
      const q = await admin.execution.evaluateQualification(p.id);
      setNote(
        q.passed
          ? `${p.name}: qualification PASSED — ${q.metrics.trades} trades, ${q.metrics.winRate == null ? 'n/a' : `${Math.round(q.metrics.winRate)}%`} win rate.`
          : `${p.name}: not yet qualified — ${q.unmet.map((u) => u.label).join(', ')}.`,
      );
      onChanged();
    } catch (err) {
      setNote(`${p.name}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Execution profiles" subtitle="Agent → strategy → market → account → state">
      {profiles && profiles.length > 0 ? (
        <>
          <Table head={<>
            <Th>Profile</Th><Th>State</Th><Th>AutoTrade</Th><Th>Market</Th><Th>Scope</Th><Th>TradeW account</Th>
            <Th className="text-right">Cash</Th><Th className="text-right">Realized</Th>
            <Th className="text-right">Open</Th><Th className="text-right">Today</Th>
            <Th>Qualification</Th><Th>Last activity</Th><Th /></>}>
            {profiles.map((p) => {
              const state = p.state;
              const isOpen = expanded === p.id;
              return (
                <Fragment key={p.id}>
                  <tr className="transition-colors hover:bg-white/[0.03]">
                    <Td className="font-medium">
                      <button
                        onClick={() => setExpanded(isOpen ? null : p.id)}
                        className="text-left hover:text-teal"
                        title="Show the state history and recent passes"
                      >
                        {p.name}
                      </button>
                      <div className="text-[10.5px] text-faint">{p.agent}</div>
                    </Td>
                    <Td>
                      <Pill tone={STATE_TONE[state]}>{STATE_SHORT[state]}</Pill>
                      {p.lastError && (
                        <div className="mt-0.5 max-w-[200px] truncate text-[10.5px] text-down" title={p.lastError}>
                          {p.lastError}
                        </div>
                      )}
                    </Td>
                    <Td>
                      {/* Only meaningful for a USER profile. A system account has
                          no holder to activate anything, so arming IS the
                          activation and a "not enabled" pill there would read as
                          a problem rather than as not-applicable. */}
                      {p.accountScope === 'SYSTEM_PAPER' ? (
                        <span className="text-[10.5px] text-faint">n/a · system</span>
                      ) : p.autoTradeEnabled ? (
                        <Pill tone="good">ON</Pill>
                      ) : (
                        <Pill tone="neutral">OFF</Pill>
                      )}
                    </Td>
                    <Td>{p.symbol}</Td>
                    <Td>
                      <Pill tone={p.accountScope === 'USER_PAPER' ? 'good' : 'neutral'}>
                        {p.accountScope === 'USER_PAPER' ? 'USER' : 'SYSTEM'}
                      </Pill>
                    </Td>
                    <Td className="max-w-[220px]">
                      <div className="truncate text-muted">{p.account.email}</div>
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
                    <Td className="max-w-[220px]"><QualificationCell profile={p} /></Td>
                    <Td className="text-[10.5px] text-faint">
                      <LastActivity profile={p} />
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <ProfileActions
                          profile={p}
                          busy={busy === p.id}
                          onAct={act}
                          onRun={runNow}
                          onEvaluate={evaluate}
                        />
                      </div>
                    </Td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={13} className="bg-black/30 px-4 py-3">
                        <ProfileDetail profile={p} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </Table>
          {note && <p className="border-t border-white/[0.06] px-4 py-2 text-[11.5px] text-muted">{note}</p>}
          <p className="border-t border-white/[0.06] px-4 py-2 text-[11px] leading-relaxed text-faint">
            Arming is now the ONLY switch: an armed profile executes automatically on the loop&rsquo;s own tick, and
            &ldquo;Run pass&rdquo; is a diagnostic that applies exactly the same gates. A{' '}
            <strong className="text-muted">USER</strong> profile trades a real TradeW account — its orders, positions
            and P&amp;L appear in that user&rsquo;s own app, because both read the same records — and additionally needs
            that user&rsquo;s own AutoTrade switch to be ON. <strong className="text-amber">ARM LIVE</strong> is offered
            only for a profile whose paper qualification has passed, and it is the only state from which a real broker
            order can be placed.
          </p>
        </>
      ) : (
        <Empty>{loading ? 'Loading…' : 'No execution profiles configured.'}</Empty>
      )}
    </Panel>
  );
}

/**
 * The buttons for one profile.
 *
 * Offered strictly by what the server would allow from the current state, so
 * the console never shows an act it knows will be refused — and never hides one
 * as its only protection, since `evaluateTransition` refuses independently.
 */
function ProfileActions({
  profile: p,
  busy,
  onAct,
  onRun,
  onEvaluate,
}: {
  profile: ExecutionProfileRow;
  busy: boolean;
  onAct: (p: ExecutionProfileRow, action: ExecutionStateAction, confirmText?: string) => void;
  onRun: (p: ExecutionProfileRow) => void;
  onEvaluate: (p: ExecutionProfileRow) => void;
}) {
  const btn = 'rounded-md border px-2 py-1 text-[11px] disabled:opacity-40';
  const neutral = `${btn} border-white/10 text-muted hover:border-teal hover:text-white`;
  const stop = `${btn} border-down/40 text-down hover:bg-down/10`;
  const go = `${btn} border-up/40 text-up hover:bg-up/10`;
  const caution = `${btn} border-amber/50 text-amber hover:bg-amber/10`;

  const state = p.state;
  const paperExecuting = state === 'PAPER_ARMED' || state === 'PAPER_RUNNING' || state === 'PAPER_QUALIFIED';
  const liveExecuting = state === 'LIVE_ARMED' || state === 'LIVE_RUNNING';

  return (
    <>
      <button disabled={busy} onClick={() => onRun(p)} className={neutral} title="Run one pass now, applying every gate">
        Run pass
      </button>

      <button disabled={busy} onClick={() => onEvaluate(p)} className={neutral} title="Re-measure the paper record against its criteria">
        Qualify
      </button>

      {(state === 'DISABLED' || state === 'DISARMED') && (
        <button disabled={busy} onClick={() => onAct(p, 'ARM_PAPER')} className={go}>Arm paper</button>
      )}

      {state === 'ERROR' && (
        <button disabled={busy} onClick={() => onAct(p, 'CLEAR_ERROR')} className={neutral} title="Acknowledge the fault; the profile is left disarmed">
          Clear error
        </button>
      )}

      {(paperExecuting || liveExecuting) && (
        <button disabled={busy} onClick={() => onAct(p, 'PAUSE')} className={neutral} title="Suspend execution, keeping the state to resume into">
          Pause
        </button>
      )}

      {state === 'PAUSED' && (
        <button disabled={busy} onClick={() => onAct(p, 'RESUME')} className={go} title={`Resume as ${p.resumeState ?? 'PAPER_ARMED'}`}>
          Resume
        </button>
      )}

      {/* ARM LIVE. Offered only where the server would accept it, styled as a
          caution, and confirmed by name — see the panel docstring. */}
      {p.liveEligible && (
        <button
          disabled={busy}
          onClick={() =>
            onAct(
              p,
              'ARM_LIVE',
              `Arm LIVE execution for "${p.name}" on ${p.account.email}?\n\n` +
                'From this point Sentinel may place REAL broker orders in that account using its stored ' +
                'broker credential. Paper qualification has passed; this is a separate, deliberate authorization.',
            )
          }
          className={caution}
        >
          Arm LIVE
        </button>
      )}

      {liveExecuting && (
        <button
          disabled={busy}
          onClick={() => onAct(p, 'DISARM_LIVE', `Stand live execution down for "${p.name}"? It returns to PAPER_QUALIFIED.`)}
          className={caution}
        >
          Disarm live
        </button>
      )}

      {state !== 'DISABLED' && state !== 'DISARMED' && (
        <button disabled={busy} onClick={() => onAct(p, 'DISARM')} className={stop} title="Stop this profile immediately, from any state">
          Disarm
        </button>
      )}
    </>
  );
}

/**
 * §10's readout, in a table cell.
 *
 * Renders the measured record and — when it has not passed — the criteria that
 * are still short. Never renders a bare "not qualified": an operator reading
 * that has learned nothing they can act on.
 */
function QualificationCell({ profile: p }: { profile: ExecutionProfileRow }) {
  const q = p.qualification;
  if (!q) return <span className="text-[10.5px] text-faint">not measured yet</span>;

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        <Pill tone={q.passed ? 'good' : 'neutral'}>{q.passed ? 'QUALIFIED' : 'NOT YET'}</Pill>
        <span className="num text-[10.5px] text-faint">
          {q.trades} trades · {q.winRate == null ? '—' : `${Math.round(q.winRate)}%`} · {q.maxDrawdownPct}% dd
        </span>
      </div>
      {!q.passed && q.unmet.length > 0 && (
        <ul className="text-[10px] leading-snug text-faint">
          {q.unmet.slice(0, 3).map((u) => (
            <li key={u.id} title={u.detail}>· {u.detail}</li>
          ))}
          {q.unmet.length > 3 && <li>· +{q.unmet.length - 3} more</li>}
        </ul>
      )}
    </div>
  );
}

/** The five execution clocks, compactly. Absent ones say so rather than showing "—". */
function LastActivity({ profile: p }: { profile: ExecutionProfileRow }) {
  const rows: [string, string | null][] = [
    ['pass', p.lastRunAt],
    ['decision', p.lastDecisionAt],
    ['order', p.lastOrderAt],
    ['fill', p.lastFillAt],
  ];
  const known = rows.filter(([, v]) => v != null);
  if (known.length === 0) return <span>never run</span>;
  return (
    <div className="space-y-px">
      {known.map(([label, v]) => (
        <div key={label}>
          {label} {ago(v!)}
        </div>
      ))}
    </div>
  );
}

/**
 * The expanded row: how this profile got to its current state, and what its
 * recent passes actually did.
 *
 * The pass list is the answer to "the loop says it is ticking, so why is
 * nothing happening?" — it shows the quiet passes too, which no other table in
 * this console does.
 */
function ProfileDetail({ profile: p }: { profile: ExecutionProfileRow }) {
  const history = usePolling(() => admin.execution.stateHistory(p.id), [p.id], 30_000);
  const runs = usePolling(() => admin.execution.profileRuns(p.id, 25), [p.id], 15_000);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div>
        <h4 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted">State history</h4>
        {history.data && history.data.length > 0 ? (
          <ul className="space-y-1">
            {history.data.map((t) => (
              <li key={t.id} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                <span className="num text-faint">{fmtTime(t.at)}</span>
                <span className="text-muted">{t.from}</span>
                <span className="text-faint">→</span>
                <span className="font-medium">{t.to}</span>
                <span className="text-faint">by {t.actor}</span>
                {t.reason && <span className="text-faint">· {t.reason}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-faint">{history.loading ? 'Loading…' : 'No transitions recorded.'}</p>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted">
          Recent passes <span className="font-normal normal-case text-faint">(including the quiet ones)</span>
        </h4>
        {runs.data && runs.data.length > 0 ? (
          <ul className="space-y-1">
            {runs.data.map((r: ExecutionRunRow) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                <span className="num text-faint">{fmtTime(r.startedAt)}</span>
                <Pill tone={r.outcome === 'executed' ? 'good' : r.outcome === 'failed' ? 'bad' : r.outcome === 'rejected' ? 'warn' : 'neutral'}>
                  {r.outcome}
                </Pill>
                <span className="text-faint">{r.environment}</span>
                {r.trigger === 'manual' && <span className="text-faint">manual</span>}
                <span className="min-w-0 flex-1 truncate text-muted" title={r.reason ?? undefined}>{r.reason}</span>
                {r.latencyMs != null && <span className="num text-faint">{r.latencyMs}ms</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-faint">{runs.loading ? 'Loading…' : 'No passes recorded in the last 24h.'}</p>
        )}
      </div>
    </div>
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
