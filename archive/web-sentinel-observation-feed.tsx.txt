import { AGENT_COLOR, AGENT_LABEL, type Observation } from '@/lib/sentinel/types';

export function ObservationFeed({ observations }: { observations: Observation[] }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">Observation Feed</h3>
      <ul className="max-h-72 space-y-3 overflow-y-auto pr-1">
        {observations.map((o, i) => (
          <li key={i} className="rounded-lg border border-border bg-bg p-2.5">
            <div className="mb-1 flex items-center gap-2 text-[10.5px] uppercase tracking-wide">
              <span style={{ color: AGENT_COLOR[o.agent] ?? 'var(--muted)' }}>{AGENT_LABEL[o.agent] ?? o.agent}</span>
              <span className="text-faint">{o.category.replace(/_/g, ' ')}</span>
              {o.symbol && <span className="ml-auto text-muted">{o.symbol}</span>}
            </div>
            <p className="text-xs leading-snug text-muted">{o.content}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
