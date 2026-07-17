'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  knowledge,
  subscribeToChanges,
  type ActivityEvent,
  type FileContent,
  type GraphData,
  type RecentItem,
  type SearchHit,
  type TreeNode,
} from '@/lib/knowledge';
import { FileTree } from './FileTree';
import { MarkdownView } from './MarkdownView';
import { ActivityPanel } from './ActivityPanel';
import { KnowledgeGraph } from './KnowledgeGraph';

type RightTab = 'activity' | 'graph';

/**
 * Knowledge Workspace — an in-app window over the TradeW/knowledge/ Obsidian
 * vault so agents' output is visible without leaving TradeW. Filesystem is the
 * source of truth (served read-only by services/api); this page renders it and
 * live-refreshes from the SSE change stream.
 */
export default function KnowledgePage() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [live, setLive] = useState<ActivityEvent[]>([]);
  const [current, setCurrent] = useState<FileContent | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);

  const [treeFilter, setTreeFilter] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>('activity');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activePathRef = useRef<string | null>(null);
  activePathRef.current = activePath;

  const loadIndex = useCallback(async () => {
    try {
      const [t, r, g, a] = await Promise.all([
        knowledge.tree(),
        knowledge.recent(20),
        knowledge.graph(),
        knowledge.activity(),
      ]);
      setTree(t);
      setRecent(r);
      setGraph(g);
      setLive(a);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load vault. Sign in and ensure the API is running.');
    }
  }, []);

  const openFile = useCallback(async (path: string) => {
    setActivePath(path);
    try {
      setCurrent(await knowledge.file(path));
    } catch (e) {
      setCurrent(null);
      setError(e instanceof Error ? e.message : 'Failed to open note');
    }
  }, []);

  // initial load
  useEffect(() => {
    void loadIndex();
  }, [loadIndex]);

  // live updates: refresh index on any change; refresh the open note if it changed
  useEffect(() => {
    const unsub = subscribeToChanges(
      (ev) => {
        setConnected(true);
        setLive((prev) => [ev, ...prev.filter((e) => e.id !== ev.id)].slice(0, 100));
        void loadIndex();
        if (ev.path === activePathRef.current) {
          if (ev.type === 'deleted') {
            setCurrent(null);
            setActivePath(null);
          } else {
            void openFile(ev.path);
          }
        }
      },
      { onOpen: () => setConnected(true), onError: () => setConnected(false) },
    );
    return unsub;
  }, [loadIndex, openFile]);

  // debounced search
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const id = setTimeout(async () => {
      try {
        setResults(await knowledge.search(q));
      } catch {
        setResults([]);
      }
    }, 220);
    return () => clearTimeout(id);
  }, [query]);

  return (
    <div className="flex h-screen flex-col bg-[#0d1524] text-[#e2e8f0]">
      {/* top bar — shared app-shell chrome */}
      <header className="flex items-center gap-4 border-b border-[#1e2c47] bg-[#131e33] px-5 py-3">
        <span className="text-[15px] font-bold tracking-wide">
          Trade<span className="text-[#14b8a6]">W</span>
        </span>
        <nav className="flex items-center gap-1 text-[#8ea0c4]">
          <Link href="/trade" className="rounded-lg px-3 py-1.5 hover:bg-[#182642]">Terminal</Link>
          <Link href="/sentinel" className="rounded-lg px-3 py-1.5 hover:bg-[#182642]">Sentinel</Link>
          <span className="rounded-lg bg-[#12312f] px-3 py-1.5 font-semibold text-[#14b8a6]">Knowledge</span>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-[12px] text-[#8ea0c4]">
          <span className="rounded-full bg-[#1a2740] px-2.5 py-0.5 text-[11px] font-semibold text-[#8ea0c4]">DEV</span>
          <span className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'animate-pulse bg-[#26a69a]' : 'bg-[#64769c]'}`} />
            {connected ? 'Live' : 'Connecting…'}
          </span>
        </div>
      </header>

      {error && (
        <div className="border-b border-[#3a2d14] bg-[#3a2d14]/40 px-5 py-2 text-[12px] text-[#f0a53c]">{error}</div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_360px]">
        {/* left — file explorer */}
        <aside className="flex min-h-0 flex-col border-r border-[#1e2c47] bg-[#101a2e]">
          <div className="border-b border-[#1e2c47] p-2.5">
            <input
              value={treeFilter}
              onChange={(e) => setTreeFilter(e.target.value)}
              placeholder="Filter files…"
              className="w-full rounded-lg border border-[#2a3a5c] bg-[#0d1524] px-2.5 py-1.5 text-[12px] placeholder:text-[#64769c] focus:border-[#14b8a6] focus:outline-none"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FileTree tree={tree} activePath={activePath} filter={treeFilter} onOpen={openFile} />
          </div>
        </aside>

        {/* center — search + markdown viewer */}
        <main className="flex min-h-0 flex-col">
          <div className="border-b border-[#1e2c47] bg-[#101a2e] p-2.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search filenames, titles, tags, and content…"
              className="w-full rounded-lg border border-[#2a3a5c] bg-[#0d1524] px-3 py-2 text-[12.5px] placeholder:text-[#64769c] focus:border-[#14b8a6] focus:outline-none"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {results !== null ? (
              <SearchResults results={results} query={query} onOpen={(p) => { setQuery(''); void openFile(p); }} />
            ) : current ? (
              <article className="mx-auto max-w-[860px] p-6">
                <div className="mb-3 border-b border-[#1e2c47] pb-3">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-[#64769c]">
                    <span className="font-mono">{current.path}</span>
                    {current.noteType && <span className="rounded bg-[#12312f] px-1.5 py-0.5 text-[#14b8a6]">{current.noteType}</span>}
                    <span className="ml-auto">updated {new Date(current.modified).toLocaleString()}</span>
                  </div>
                  {current.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {current.tags.map((t) => (
                        <span key={t} className="rounded-full bg-[#1a2740] px-2 py-0.5 text-[10.5px] text-[#8ea0c4]">#{t}</span>
                      ))}
                    </div>
                  )}
                </div>
                <MarkdownView content={current.content} onNavigate={(target) => void openFile(target)} />
                {current.backlinks.length > 0 && (
                  <div className="mt-6 border-t border-[#1e2c47] pt-3">
                    <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-[#64769c]">
                      Linked from ({current.backlinks.length})
                    </h4>
                    <ul className="space-y-1">
                      {current.backlinks.map((b) => (
                        <li key={b}>
                          <button onClick={() => void openFile(b)} className="text-[12px] text-[#14b8a6] hover:underline">
                            {b.replace(/\.md$/i, '')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-[#64769c]">
                <div>
                  <p className="mb-1 text-[#8ea0c4]">Select a note to read it.</p>
                  <p>Everything the AI agents write to the knowledge vault appears here — live.</p>
                </div>
              </div>
            )}
          </div>
        </main>

        {/* right — activity / graph */}
        <aside className="flex min-h-0 flex-col border-l border-[#1e2c47] bg-[#101a2e]">
          <div className="flex border-b border-[#1e2c47]">
            {(['activity', 'graph'] as RightTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setRightTab(tab)}
                className={`flex-1 px-3 py-2.5 text-[12px] font-semibold capitalize ${
                  rightTab === tab ? 'border-b-2 border-[#14b8a6] text-[#14b8a6]' : 'text-[#64769c] hover:text-[#8ea0c4]'
                }`}
              >
                {tab === 'activity' ? 'Activity' : 'Knowledge Graph'}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {rightTab === 'activity' ? (
              <ActivityPanel live={live} recent={recent} onOpen={openFile} />
            ) : (
              <KnowledgeGraph data={graph} activePath={activePath} onOpen={openFile} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SearchResults({ results, query, onOpen }: { results: SearchHit[]; query: string; onOpen: (p: string) => void }) {
  return (
    <div className="mx-auto max-w-[860px] p-5">
      <p className="mb-3 text-[12px] text-[#64769c]">
        {results.length} result{results.length === 1 ? '' : 's'} for “{query}”
      </p>
      <ul className="space-y-2">
        {results.map((h) => (
          <li key={h.path}>
            <button
              onClick={() => onOpen(h.path)}
              className="block w-full rounded-lg border border-[#1e2c47] bg-[#131e33] p-3 text-left hover:border-[#2a3a5c]"
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[13px] font-semibold text-[#c6d0e2]">{h.title}</span>
                <span className="ml-auto flex gap-1">
                  {h.fields.map((f) => (
                    <span key={f} className="rounded bg-[#1a2740] px-1.5 py-0.5 text-[9.5px] uppercase text-[#8ea0c4]">{f}</span>
                  ))}
                </span>
              </div>
              <p className="mb-1 truncate font-mono text-[10.5px] text-[#64769c]">{h.path}</p>
              <p className="text-[12px] text-[#95a3bd]">{h.snippet}</p>
            </button>
          </li>
        ))}
        {results.length === 0 && <li className="text-[12px] text-[#64769c]">No matches.</li>}
      </ul>
    </div>
  );
}
