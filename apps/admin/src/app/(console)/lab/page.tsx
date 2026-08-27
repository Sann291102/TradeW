'use client';

import { useState } from 'react';
import { admin, type LabEventRow, type LabHealth } from '@/lib/api';
import {
  Empty, MetricCard, Panel, Pill, SectionTitle, StatusIndicator, Table, Td, Th, ago, fmtNum, fmtTime, usePolling,
} from '@/components/ui';

/**
 * The Agent Lab control room — Phase 0.
 *
 * ## Everything on this page is real
 *
 * There is no sample data, no placeholder row and no illustrative event. The
 * timeline renders exactly what `LabRunnerService` wrote while running, and
 * when the Lab has done nothing this page says so rather than filling the space
 * — a control room that shows invented activity is worse than one that shows
 * none, because an operator cannot tell which is which.
 *
 * That is also why the header states the Lab's ACTUAL capability. Phase 0
 * observes and records; it cannot place an order, and the page says that
 * plainly rather than implying a power the code does not have.
 */

/** Colour by what the event MEANS, not by an arbitrary palette. */
const KIND_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  SETUP_CANDIDATE: 'good',
  HEALTH_RECOVERED: 'good',
  SESSION_OPENED: 'good',
  OBSERVING: 'info',
  SETUP_REJECTED: 'neutral',
  SESSION_CLOSED: 'neutral',
  OBSERVATION_SKIPPED: 'warn',
  HEALTH_DEGRADED: 'warn',
  KILL_SWITCH: 'bad',
};

export default function AgentLabPage() {
  const [minutes, setMinutes] = useState(240);
  const [kind, setKind] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ticking, setTicking] = useState(false);

  const health = usePolling(() => admin.lab.health(), [], 10_000);
  const profiles = usePolling(() => admin.lab.profiles(), [], 30_000);
  const events = usePolling(
    () => admin.lab.events({ sinceMinutes: minutes, kind: kind || undefined, limit: 300 }),
    [minutes, kind],
    5_000,
  );
  const summary = usePolling(() => admin.lab.summary(24), [], 30_000);

  const h = health.data;
  const rows = events.data?.rows ?? [];

  const runNow = async () => {
    setTicking(true);
    try {
      await admin.lab.tick();
      // The pass has already written whatever it wrote; refresh both reads so
      // the operator sees the result of the click rather than waiting out the
      // poll interval.
      events.refresh();
      health.refresh();
    } finally {
      setTicking(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Agent Lab</h1>
          <p className="text-[12px] text-muted">
            What the agents are observing, and why they did or did not act. Paper only — this surface cannot place an order.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusIndicator label={stateLabel(h)} tone={stateTone(h)} pulse={h?.state === 'RUNNING'} />
          <select
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className="rounded-md border border-white/10 bg-surface px-2 py-1.5 text-[11.5px] text-text"
          >
            <option value={60}>Last hour</option>
            <option value={240}>Last 4 hours</option>
            <option value={1440}>Last 24 hours</option>
            <option value={10080}>Last 7 days</option>
          </select>
          <button
            onClick={() => void runNow()}
            disabled={ticking}
            className="rounded-md border border-teal/50 bg-teal/10 px-3 py-1.5 text-[11.5px] text-teal hover:bg-teal/20 disabled:opacity-40"
            title="Runs the same observation pass the timer runs, subject to the same health gate."
          >
            {ticking ? 'Observing…' : 'Observe now'}
          </button>
        </div>
      </header>

      {/* ── STATE ─────────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Lab state"
          accent={h?.state === 'RUNNING' ? 'teal' : 'slate'}
          value={h?.state ?? '—'}
          sub={h?.state === 'STOPPED' ? 'switched off' : h?.state === 'WAITING' ? 'dependency or session' : 'observing'}
          tone={stateTone(h) === 'idle' ? 'neutral' : stateTone(h)}
          live={h?.state === 'RUNNING'}
        />
        <MetricCard
          label="Market session"
          accent={h?.session.open ? 'teal' : 'slate'}
          value={h?.session.open ? 'Open' : 'Closed'}
          sub={h?.session.reason}
          tone={h?.session.open ? 'good' : 'neutral'}
        />
        <MetricCard label="Profiles observed" accent="slate" value={fmtNum(profiles.data?.length ?? 0)} sub="lab-enabled" />
        <MetricCard
          label="Can place orders"
          accent="slate"
          value={h?.canExecute ? 'Yes' : 'No'}
          // Not a setting that happens to be off. Phase 0 has no execution path
          // at all, and the page must not imply otherwise.
          sub="no execution path exists yet"
          tone="neutral"
        />
      </div>

      {/* ── WHY IT IS OR IS NOT RUNNING ───────────────────────────────── */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Panel title="Dependencies" className="lg:col-span-2">
          {!h ? (
            <Empty>Checking…</Empty>
          ) : (
            <Table head={<tr><Th>Dependency</Th><Th>Status</Th><Th>What was observed</Th><Th>Probe</Th></tr>}>
              {h.dependencies.map((d) => (
                <tr key={d.name} className="border-t border-white/5">
                  <Td>{d.name}</Td>
                  <Td>
                    <Pill tone={d.status === 'ok' ? 'good' : d.status === 'degraded' ? 'warn' : 'bad'}>{d.status}</Pill>
                  </Td>
                  {/* Verbatim upstream text. Never a composed diagnosis — see
                      the 2026-08-17 outage, where a hardcoded message named two
                      innocent components and hid the real one. */}
                  <Td className="text-muted">{d.detail}</Td>
                  <Td className="text-muted">{d.latencyMs != null ? `${d.latencyMs}ms` : '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
          {h && h.blockedBy.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-[11.5px] font-semibold text-amber-300">The Lab is not observing because:</p>
              <ul className="mt-1.5 space-y-1">
                {h.blockedBy.map((b) => (
                  <li key={b} className="text-[11.5px] leading-relaxed text-muted">— {b}</li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel title="Activity (24h)">
          {!summary.data?.length ? (
            <Empty>No lab activity recorded in the last 24 hours.</Empty>
          ) : (
            <div className="space-y-1.5">
              {summary.data.map((s) => (
                <div key={s.kind} className="flex items-center justify-between gap-3">
                  <Pill tone={KIND_TONE[s.kind] ?? 'neutral'}>{s.kind}</Pill>
                  <span className="text-[11.5px] tabular-nums text-muted">
                    {fmtNum(s.count)} · {s.lastAt ? ago(s.lastAt) : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* ── PROFILES ──────────────────────────────────────────────────── */}
      <SectionTitle>Lab profiles</SectionTitle>
      <Panel title="What is being watched">
        {!profiles.data?.length ? (
          <Empty>
            No profile is lab-enabled. Set <code className="text-text">labEnabled</code> on an execution profile to have
            the Lab observe its market.
          </Empty>
        ) : (
          <Table
            head={<tr><Th>Profile</Th><Th>Symbol</Th><Th>Strategy</Th><Th>Min confidence</Th><Th>Timeframe</Th><Th>Armed</Th></tr>}
          >
            {profiles.data.map((p) => (
              <tr key={p.id} className="border-t border-white/5">
                <Td>{p.name}</Td>
                <Td>{p.symbol}</Td>
                <Td className="text-muted">{p.strategyName ?? p.strategyId ?? 'auto'}</Td>
                <Td className="tabular-nums">{p.minConfidence}%</Td>
                <Td className="text-muted">{p.labTimeframe ?? 'engine default'}</Td>
                <Td>
                  {/* `enabled` is the order-placing switch. In Phase 0 it is
                      irrelevant — nothing can place an order — but showing it
                      keeps the two switches visibly distinct. */}
                  <Pill tone={p.enabled ? 'warn' : 'neutral'}>{p.enabled ? 'armed' : 'observe only'}</Pill>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      {/* ── TIMELINE ──────────────────────────────────────────────────── */}
      <SectionTitle
        right={
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="rounded-md border border-white/10 bg-surface px-2 py-1 text-[11px] text-text"
          >
            <option value="">All events</option>
            <option value="OBSERVING">Observing</option>
            <option value="SETUP_CANDIDATE">Setup candidates</option>
            <option value="SETUP_REJECTED">Setups rejected</option>
            <option value="OBSERVATION_SKIPPED">Skipped</option>
            <option value="HEALTH_DEGRADED">Health degraded</option>
          </select>
        }
      >
        Experiment timeline
      </SectionTitle>
      <Panel title={`${fmtNum(events.data?.total ?? 0)} events`}>
        {!rows.length ? (
          <Empty>
            Nothing recorded in this window. The Lab writes an event every time it observes — and every time it
            cannot — so an empty timeline means it has not run, not that it ran silently.
          </Empty>
        ) : (
          <ol className="space-y-1.5">
            {rows.map((e) => (
              <TimelineRow key={e.id} event={e} open={expanded === e.id} onToggle={() => setExpanded(expanded === e.id ? null : e.id)} />
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}

function TimelineRow({ event, open, onToggle }: { event: LabEventRow; open: boolean; onToggle: () => void }) {
  const hasDetail = !!event.detail || !!event.dataAvailability;
  const availability = event.dataAvailability;

  return (
    <li className="rounded-md border border-white/5 bg-surface/50">
      <button
        onClick={onToggle}
        disabled={!hasDetail}
        className="flex w-full items-start gap-3 p-2.5 text-left disabled:cursor-default"
      >
        {/* Market time, not the time the row was written. The two differ and
            the distinction is what keeps the timeline the sequence the market
            produced rather than the sequence the poller noticed. */}
        <span className="w-[62px] shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-muted">{fmtTime(event.at)}</span>
        <span className="shrink-0 pt-0.5">
          <Pill tone={KIND_TONE[event.kind] ?? 'neutral'}>{event.kind}</Pill>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] leading-snug text-text">{event.summary}</span>
          <span className="mt-0.5 block text-[10.5px] text-muted">
            {event.actor}
            {event.profile ? ` · ${event.profile.name}` : ''}
            {availability && availability.sufficient === false ? ' · degraded data' : ''}
          </span>
        </span>
        <span className="shrink-0 pt-0.5 font-mono text-[10px] text-muted">{ago(event.recordedAt)}</span>
      </button>

      {open && hasDetail && (
        <div className="space-y-2.5 border-t border-white/5 p-3">
          {availability && (
            <div>
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">What the agent could see</p>
              <div className="flex flex-wrap gap-1.5">
                {(availability.sources ?? []).map((s) => (
                  <Pill key={s.name} tone={s.status === 'ok' ? 'good' : 'warn'}>
                    {s.name}: {s.status}
                  </Pill>
                ))}
              </div>
              {availability.insufficientReason && (
                <p className="mt-1.5 text-[11px] text-amber-300">{availability.insufficientReason}</p>
              )}
              {availability.barAgeSeconds != null && (
                <p className="mt-1 text-[11px] text-muted">Newest bar was {availability.barAgeSeconds}s old.</p>
              )}
            </div>
          )}
          {event.detail && (
            <div>
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">Detail</p>
              <pre className="overflow-x-auto rounded bg-black/30 p-2.5 font-mono text-[10.5px] leading-relaxed text-muted">
                {JSON.stringify(event.detail, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function stateTone(h: LabHealth | null): 'good' | 'warn' | 'bad' | 'neutral' | 'idle' {
  if (!h) return 'idle';
  if (h.state === 'RUNNING') return 'good';
  if (h.state === 'WAITING') return 'warn';
  return 'neutral';
}

function stateLabel(h: LabHealth | null): string {
  if (!h) return 'Checking…';
  if (h.state === 'RUNNING') return 'Observing';
  // "Stopped" and "waiting" mean opposite things and the header must not blur
  // them: one is a decision, the other is an outage.
  if (h.state === 'STOPPED') return 'Stopped';
  return `Waiting — ${h.blockedBy[0] ?? 'dependency'}`;
}
