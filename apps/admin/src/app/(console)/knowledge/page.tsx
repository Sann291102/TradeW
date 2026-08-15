'use client';

import { useCallback, useEffect, useState } from 'react';
import { knowledge, subscribeToChanges, type ActivityEvent, type GraphData, type RecentItem } from '@/lib/knowledge';
import { KnowledgeGraph } from '@/components/KnowledgeGraph';
import { Empty, MetricCard, Panel, StatusIndicator, ago, fmtNum } from '@/components/ui';

export default function AdminKnowledgePage() {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [g, r] = await Promise.all([knowledge.graph(), knowledge.recent(25)]);
      setGraph(g);
      setRecent(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the knowledge vault.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const unsubscribe = subscribeToChanges(
      (event) => {
        setActivity((prev) => [event, ...prev].slice(0, 50));
        void load();
      },
      { onOpen: () => setLive(true), onError: () => setLive(false) },
    );
    return unsubscribe;
  }, [load]);

  const nodeCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.edges.length ?? 0;
  const density = nodeCount ? (edgeCount / nodeCount).toFixed(1) : '—';
  const lastChange = activity[0]?.path ? activity[0] : null;

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Knowledge Center</h1>
          <p className="text-[12px] text-muted">The engineering note-link graph the agents read from and write to.</p>
        </div>
        <StatusIndicator label={live ? 'Live — watching the vault' : error ? 'Stream disconnected' : 'Connecting…'} tone={live ? 'good' : error ? 'bad' : 'idle'} pulse={live} />
      </header>

      {error && <div className="rounded-lg border border-amber/40 bg-amber-bg px-4 py-2.5 text-[12px] text-amber">{error}</div>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Notes" accent="teal" value={graph ? fmtNum(nodeCount) : '—'} sub="vault documents" live={live} />
        <MetricCard label="Links" accent="violet" value={graph ? fmtNum(edgeCount) : '—'} sub={`${density} avg degree`} />
        <MetricCard label="Writes this session" accent="green" value={fmtNum(activity.length)} sub="observed over SSE" />
        <MetricCard label="Last change" accent="slate" value={recent[0] ? ago(recent[0].modified) : '—'} sub={lastChange ? `live: ${lastChange.type}` : recent[0] ? 'most recent note' : undefined} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <Panel title="Knowledge graph" subtitle="Size is link degree; colour is the top-level folder">
          <div className="p-3">
            <KnowledgeGraph data={graph} activePath={activePath} onOpen={setActivePath} />
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel title="Live changes" subtitle="Vault writes as they happen">
            {activity.length ? (
              <ul className="max-h-[240px] overflow-auto">
                {activity.map((event) => (
                  <li key={event.id} className="admin-row-flash border-b border-white/[0.04] px-3 py-1.5">
                    <div className="flex items-baseline gap-2">
                      <span className={`text-[10px] uppercase tracking-[0.1em] ${event.type === 'deleted' ? 'text-down' : event.type === 'created' ? 'text-up' : 'text-teal'}`}>{event.type}</span>
                      <span className="truncate text-[11.5px]">{event.title}</span>
                    </div>
                    <div className="truncate font-mono text-[10px] text-faint">{event.path}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Watching the vault. No writes yet this session.</Empty>
            )}
          </Panel>

          <Panel title="Recently modified" subtitle="Last 25 notes touched">
            {recent.length ? (
              <ul className="max-h-[380px] overflow-auto">
                {recent.map((item) => (
                  <li key={item.path}>
                    <button type="button" onClick={() => setActivePath(item.path)}
                      className={`block w-full border-b border-white/[0.04] px-3 py-1.5 text-left transition-colors hover:bg-white/[0.03] ${activePath === item.path ? 'bg-teal/10' : ''}`}>
                      <div className="truncate text-[11.5px]">{item.title}</div>
                      <div className="flex items-baseline gap-2 text-[10px] text-faint">
                        <span>{ago(item.modified)}</span>
                        <span className="truncate font-mono">{item.path}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No recent vault activity.</Empty>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
