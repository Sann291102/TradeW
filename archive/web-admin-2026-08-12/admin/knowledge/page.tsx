'use client';

import { useCallback, useEffect, useState } from 'react';
import { knowledge, subscribeToChanges, type ActivityEvent, type GraphData, type RecentItem } from '@/lib/admin/knowledge';
import { KnowledgeGraph } from './KnowledgeGraph';
import { Empty, Panel, ago } from '../components/ui';

/**
 * The knowledge vault graph — moved here from `/knowledge` on 2026-08-03.
 *
 * It was never a trader-facing surface. The graph renders the ENGINEERING
 * vault: architecture decisions, gotchas, agent research notes, plans. Putting
 * it on the public workspace exposed internal reasoning and file structure to
 * every signed-in user, and gave traders a page whose contents they had no
 * context for. It belongs on the operator console, where its audience is.
 *
 * The move added the activity rail. On the public page the graph stood alone;
 * here the question is operational — "are the agents still writing to the
 * vault, and what did they touch" — so recent writes are shown next to it and
 * the live change stream drives both.
 */
export default function AdminKnowledgePage() {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
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

  useEffect(() => {
    void load();
  }, [load]);

  // Live vault changes. Each event both prepends to the activity rail (so a
  // write is visible immediately) and triggers a graph reload (so the topology
  // catches up) — the event carries the path, not the new edge set.
  useEffect(() => {
    const unsubscribe = subscribeToChanges((event) => {
      setActivity((prev) => [event, ...prev].slice(0, 50));
      void load();
    });
    return unsubscribe;
  }, [load]);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-5">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">Knowledge vault</h1>
        <p className="text-[12px] text-muted">
          The note-link graph the agents read from and write to. {graph ? `${graph.nodes.length} notes · ${graph.edges.length} links` : ''}
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-amber/40 bg-amber-bg px-4 py-2.5 text-[12px] text-amber">{error}</div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Panel title="Graph" subtitle="Size is link degree; colour is the top-level folder">
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
                      <span
                        className={`text-[10px] uppercase tracking-[0.1em] ${
                          event.type === 'deleted' ? 'text-down' : event.type === 'created' ? 'text-up' : 'text-teal'
                        }`}
                      >
                        {event.type}
                      </span>
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
                    <button
                      type="button"
                      onClick={() => setActivePath(item.path)}
                      className={`block w-full border-b border-white/[0.04] px-3 py-1.5 text-left transition-colors hover:bg-white/[0.03] ${
                        activePath === item.path ? 'bg-teal/10' : ''
                      }`}
                    >
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
