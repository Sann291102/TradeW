'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import {
  admin,
  subscribeToAgentStream,
  type AgentActivityFrame,
  type AgentNode,
  type AgentRunFrame,
  type AgentState,
} from '@/lib/api';
import { ago } from '@/components/ui';

const STATE_TTL_MS = 6_000;

interface LiveState {
  state: AgentState;
  detail?: string;
  peer?: string;
  at: number;
}

export function SentinelOrbit({ system = 'sentinel' }: { system?: string }) {
  const reduce = useReducedMotion();
  const [roster, setRoster] = useState<AgentNode[]>([]);
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [connected, setConnected] = useState(false);
  const [activeRun, setActiveRun] = useState<AgentRunFrame | null>(null);
  const [recent, setRecent] = useState<AgentActivityFrame[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const next = await admin.agentStates(system);
        if (mounted.current) setRoster(next);
      } catch { /* orbit goes quiet */ }
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [system]);

  useEffect(() => {
    const unsubscribe = subscribeToAgentStream({
      onOpen: () => setConnected(true),
      onError: () => setConnected(false),
      onActivity: (event) => {
        if (event.system !== system) return;
        setLive((prev) => ({
          ...prev,
          [event.agent]: { state: event.state, detail: event.detail, peer: event.peer, at: Date.now() },
        }));
        setRecent((prev) => [event, ...prev].slice(0, 40));
      },
      onRun: (event) => {
        if (event.system !== system) return;
        setActiveRun(event.phase === 'start' ? event : null);
        if (event.phase === 'end') setLive({});
      },
    });
    return unsubscribe;
  }, [system]);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  const agents = useMemo(() => {
    const now = Date.now();
    return roster
      .filter((a) => a.name !== 'orchestrator')
      .map((a) => {
        const liveState = live[a.name];
        const fresh = liveState && now - liveState.at < STATE_TTL_MS;
        return {
          ...a,
          state: fresh ? liveState.state : (a.state as AgentState),
          detail: fresh ? liveState.detail ?? a.detail : a.detail,
          peer: fresh ? liveState.peer ?? a.peer : a.peer,
        };
      });
  }, [roster, live]);

  const orchestrator = roster.find((a) => a.name === 'orchestrator');
  const orchestratorLive = live.orchestrator && Date.now() - live.orchestrator.at < STATE_TTL_MS;
  const orchestratorState: AgentState = orchestratorLive
    ? live.orchestrator.state
    : ((orchestrator?.state as AgentState) ?? 'idle');
  const busy = agents.some((a) => a.state !== 'idle' && a.state !== 'done') || orchestratorState !== 'idle';

  const RADIUS = 210;
  const DURATION = 34;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="admin-card relative overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02] backdrop-blur-sm">
        <header className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
          <div>
            <h2 className="text-[12.5px] font-semibold tracking-wide">Sentinel Orchestrator</h2>
            <p className="text-[11px] text-muted">
              {agents.length} agents · {busy ? 'run in progress' : 'idle'}
            </p>
          </div>
          <span className="flex items-center gap-1.5 text-[10.5px] text-muted">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-up' : 'bg-down'}`} aria-hidden />
            {connected ? 'live' : 'reconnecting'}
          </span>
        </header>

        <div
          className="admin-orbit relative mx-auto"
          style={{ height: 520, width: '100%', maxWidth: 620 }}
          role="img"
          aria-label={`Sentinel agent orbit. Orchestrator is ${orchestratorState}. ${agents.map((a) => `${a.label} is ${a.state}`).join('. ')}`}
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 620 520" aria-hidden>
            {agents.map((agent, i) => {
              const angle = (i / agents.length) * Math.PI * 2 - Math.PI / 2;
              const x = 310 + Math.cos(angle) * RADIUS;
              const y = 260 + Math.sin(angle) * RADIUS * Math.cos((62 * Math.PI) / 180);
              const path = `M 310 260 L ${x.toFixed(1)} ${y.toFixed(1)}`;
              const moving = agent.state === 'sending' || agent.state === 'receiving';
              return (
                <g key={agent.name}>
                  <path d={path} className={`admin-link ${
                    agent.state === 'error' ? 'admin-link--error'
                      : moving || agent.state === 'thinking' ? 'admin-link--active' : ''
                  }`} fill="none" />
                  {moving && !reduce && (
                    <circle r="3.5"
                      fill={agent.state === 'sending' ? 'rgb(34 211 238)' : 'rgb(94 234 212)'}
                      className={`admin-packet ${agent.state === 'receiving' ? 'admin-packet--inbound' : ''}`}
                      style={{ offsetPath: `path("${path}")` } as React.CSSProperties} />
                  )}
                </g>
              );
            })}
          </svg>

          <div className="admin-orbit__plane" style={{ margin: '50px auto', width: RADIUS * 2, height: RADIUS * 2, left: 0, right: 0 }}>
            <div className="admin-orbit__ring" />
            <div className="admin-orbit__ring admin-orbit__ring--dashed" style={{ inset: '18%' }} />

            {agents.map((agent, i) => (
              <div key={agent.name} className="admin-orbit__carrier"
                style={{ '--orbit-duration': `${DURATION}s`, '--orbit-delay': `${-(i / Math.max(1, agents.length)) * DURATION}s` } as React.CSSProperties}>
                <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2">
                  <div className="admin-orbit__counter"
                    style={{ '--orbit-duration': `${DURATION}s`, '--orbit-delay': `${-(i / Math.max(1, agents.length)) * DURATION}s` } as React.CSSProperties}>
                    <AgentBadge agent={agent} selected={selected === agent.name}
                      onSelect={() => setSelected(selected === agent.name ? null : agent.name)} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="pointer-events-none absolute left-1/2 top-[260px] -translate-x-1/2 -translate-y-1/2">
            <div className="flex flex-col items-center gap-2">
              <div className={`admin-core h-[104px] w-[104px] ${busy ? 'admin-core--busy' : ''}`}>
                <span className="admin-core__band admin-core__band--a" />
                <span className="admin-core__band admin-core__band--b" />
              </div>
              <div className="text-center">
                <div className="text-[12px] font-semibold">Orchestrator</div>
                <div className="text-[10.5px] uppercase tracking-[0.12em] text-teal">{orchestratorState}</div>
                {activeRun?.symbol && <div className="mt-0.5 text-[10.5px] text-muted">{activeRun.symbol}</div>}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-4">
        <AgentDetail agent={agents.find((a) => a.name === selected) ?? null} orchestrator={orchestrator ?? null} />
        <ActivityTail events={recent} />
      </div>
    </div>
  );
}

function AgentBadge({ agent, selected, onSelect }: { agent: AgentNode & { state: AgentState }; selected: boolean; onSelect: () => void }) {
  const pulsing = agent.state === 'thinking' || agent.state === 'sending' || agent.state === 'receiving';
  return (
    <button type="button" onClick={onSelect}
      className={`flex w-[132px] flex-col items-center gap-1.5 rounded-lg border px-2 py-2 text-center backdrop-blur transition-colors ${
        selected ? 'border-teal/50 bg-teal/10' : 'border-white/[0.08] bg-black/40 hover:border-white/20'
      }`}>
      <span className="relative flex h-7 w-7 items-center justify-center">
        <span className={`admin-orb block h-5 w-5 admin-orb--${agent.state}`} />
        {pulsing && (
          <span className={`admin-orb__halo ${agent.state === 'thinking' ? 'admin-orb__halo--fast' : ''}`}
            style={{ color: agent.state === 'thinking' ? 'rgb(20 184 166)' : 'rgb(34 211 238)' }} />
        )}
      </span>
      <span className="text-[11px] font-medium leading-tight">{agent.label}</span>
      <span className="text-[9.5px] uppercase tracking-[0.1em] text-muted">{agent.state}</span>
    </button>
  );
}

function AgentDetail({ agent, orchestrator }: { agent: (AgentNode & { state: AgentState }) | null; orchestrator: AgentNode | null }) {
  const shown = agent ?? orchestrator;
  if (!shown) return null;
  return (
    <div className="admin-card rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 backdrop-blur-sm">
      <div className="flex items-center gap-2.5">
        <span className={`admin-orb block h-4 w-4 admin-orb--${shown.state}`} />
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold">{shown.label}</div>
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-muted">{shown.state}</div>
        </div>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-muted">{shown.role}</p>
      {shown.detail && (
        <p className="mt-2 rounded-md border border-white/[0.06] bg-black/30 px-2.5 py-1.5 font-mono text-[10.5px] text-teal">
          {shown.detail}
        </p>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <dt className="text-faint">Last seen</dt>
          <dd className="num">{ago(shown.lastSeen)}</dd>
        </div>
        <div>
          <dt className="text-faint">Transitions 24h</dt>
          <dd className="num">{shown.transitions24h.toLocaleString()}</dd>
        </div>
      </dl>
      {!agent && <p className="mt-3 text-[10.5px] text-faint">Select an agent in the orbit to inspect it.</p>}
    </div>
  );
}

function ActivityTail({ events }: { events: AgentActivityFrame[] }) {
  return (
    <div className="admin-card flex min-h-0 flex-1 flex-col rounded-xl border border-white/[0.07] bg-white/[0.02] backdrop-blur-sm">
      <header className="border-b border-white/[0.06] px-4 py-2.5">
        <h3 className="text-[12.5px] font-semibold tracking-wide">Live transitions</h3>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {events.length === 0 ? (
          <p className="px-4 py-8 text-center text-[11.5px] text-faint">Waiting for agent activity. Nothing is running right now.</p>
        ) : (
          <ul>
            {events.map((event, i) => (
              <li key={`${event.runId}-${event.at}-${i}`}
                className="admin-row-flash flex items-start gap-2 border-b border-white/[0.04] px-3 py-1.5">
                <span className={`admin-orb mt-1 block h-2 w-2 shrink-0 admin-orb--${event.state}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-[11.5px] font-medium">{event.agent}</span>
                    <span className="text-[10px] uppercase tracking-[0.1em] text-muted">{event.state}</span>
                    {event.peer && <span className="text-[10px] text-faint">→ {event.peer}</span>}
                  </div>
                  {event.detail && <div className="truncate text-[10.5px] text-faint">{event.detail}</div>}
                </div>
                <span className="num shrink-0 text-[10px] text-faint">
                  {new Date(event.at).toLocaleTimeString([], { hour12: false })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
