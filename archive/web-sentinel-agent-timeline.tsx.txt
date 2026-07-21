import { cn } from '@tradew/ui';
import { AGENT_COLOR, AGENT_LABEL, pretty, type Signal } from '@/lib/sentinel/types';

export function AgentTimeline({ signals }: { signals: Signal[] }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">Agent Activity Timeline</h3>
      <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {signals.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: s.triggered ? AGENT_COLOR[s.agent] ?? 'var(--muted)' : 'var(--border2)' }}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={cn('text-xs font-medium capitalize', !s.triggered && 'text-faint')}>{pretty(s.name)}</span>
                <span className="text-[10px] uppercase tracking-wide text-faint">{AGENT_LABEL[s.agent]}</span>
              </div>
              <p className="truncate text-[11.5px] text-muted">{s.evidence[0]}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
