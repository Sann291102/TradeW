'use client';
import type { ActivityEvent, RecentItem } from '@/lib/knowledge';

const TYPE_STYLE: Record<ActivityEvent['type'], { dot: string; label: string }> = {
  created: { dot: '#26a69a', label: 'created' },
  modified: { dot: '#f0a53c', label: 'modified' },
  deleted: { dot: '#ef5350', label: 'deleted' },
};

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Recent Activity + Agent Activity. The live event stream reflects what the AI
 * agents are doing to the vault in real time; the "agent" is inferred from the
 * note's top-level folder/category (true per-agent instrumentation would need
 * the agents themselves to emit events — noted as future work).
 */
export function ActivityPanel({
  live,
  recent,
  onOpen,
}: {
  live: ActivityEvent[];
  recent: RecentItem[];
  onOpen: (path: string) => void;
}) {
  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-widest text-[#64769c]">
          Agent Activity
          <span className="flex items-center gap-1 text-[10px] font-normal text-[#26a69a]">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#26a69a]" /> live
          </span>
        </h3>
        {live.length === 0 ? (
          <p className="text-[12px] text-[#64769c]">Watching the vault — file changes will appear here as agents work.</p>
        ) : (
          <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {live.map((e) => {
              const s = TYPE_STYLE[e.type];
              return (
                <li key={e.id}>
                  <button
                    onClick={() => e.type !== 'deleted' && onOpen(e.path)}
                    className="flex w-full items-start gap-2 rounded-lg border border-[#1e2c47] bg-[#0d1524] px-2.5 py-1.5 text-left hover:border-[#2a3a5c]"
                  >
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.dot }} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide">
                        <span style={{ color: s.dot }}>{s.label}</span>
                        <span className="text-[#64769c]">· {e.category}</span>
                        <span className="ml-auto text-[#64769c]">{ago(e.at)}</span>
                      </span>
                      <span className="block truncate text-[12px] text-[#c6d0e2]">{e.title}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-widest text-[#64769c]">Recent Notes</h3>
        <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {recent.map((r) => (
            <li key={r.path}>
              <button
                onClick={() => onOpen(r.path)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[#182642]"
              >
                <span
                  className="rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase"
                  style={{ background: '#0d1524', color: TYPE_STYLE[r.status].dot }}
                >
                  {r.status}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-[#c6d0e2]">{r.title}</span>
                  <span className="block truncate text-[10.5px] text-[#64769c]">{r.path}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
