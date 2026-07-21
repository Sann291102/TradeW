'use client';
import { useCallback, useEffect, useState } from 'react';
import { knowledge, subscribeToChanges, type GraphData } from '@/lib/knowledge';
import { KnowledgeGraph } from './KnowledgeGraph';

/**
 * Knowledge Graph — full-page view of the TradeW/knowledge/ vault's note-link
 * graph: which notes exist and how they reference each other, live-updated
 * as agents write to the vault. Renders inside the standard shared shell
 * (Sidebar/TopBar already show "Knowledge" as the page title) — this page no
 * longer renders its own duplicate header, see archive/README.md. Graph-only:
 * no file tree, markdown viewer, search, or activity feed.
 */
export default function KnowledgePage() {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadGraph = useCallback(async () => {
    try {
      setGraph(await knowledge.graph());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the knowledge graph. Sign in and ensure the API is running.');
    }
  }, []);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  useEffect(() => {
    const unsub = subscribeToChanges(() => void loadGraph());
    return unsub;
  }, [loadGraph]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && <div className="border-b border-amber bg-amber-bg px-5 py-2 text-xs text-amber">{error}</div>}
      <div className="min-h-0 flex-1 p-4">
        <KnowledgeGraph data={graph} activePath={activePath} onOpen={setActivePath} />
      </div>
    </div>
  );
}
