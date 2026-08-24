'use client';

import { useEffect, useRef, useState } from 'react';
import {
  DOMAIN_COLOR,
  GRAPH_DOMAINS,
  KIND_LABEL,
  systemGraph,
  type GraphDomain,
  type GraphFilter,
  type GraphMeta,
  type GraphNodeDto,
  type NodeKind,
  type RelationType,
} from '@/lib/graph';

/**
 * The control surface for both graph pages.
 *
 * Every control here maps to a SERVER-side filter, not a client-side hide. That
 * distinction is the performance contract: narrowing the view narrows what
 * crosses the wire, so a filtered graph is cheaper than an unfiltered one
 * rather than being the same payload with things made invisible.
 *
 * Counts beside each domain and kind come from `GET /admin/graph/meta` and are
 * counts of the WHOLE backend graph, not of what is loaded. An operator
 * choosing a filter needs to know what is out there, not what happens to be on
 * screen — otherwise every filter looks empty until you pick it.
 */

interface Props {
  meta: GraphMeta | null;
  filter: GraphFilter;
  onFilterChange: (next: GraphFilter) => void;
  live: boolean;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  mode: 'force' | 'layered';
  onModeChange: (mode: 'force' | 'layered') => void;
  onFocusNode: (id: string) => void;
  onFit: () => void;
  onReset: () => void;
  /** Kinds this page offers. Both pages can reach every kind; they differ only
   *  in which they start from. */
  availableKinds: NodeKind[];
  loadedCount: number;
}

export function GraphControls({
  meta,
  filter,
  onFilterChange,
  live,
  paused,
  onPausedChange,
  mode,
  onModeChange,
  onFocusNode,
  onFit,
  onReset,
  availableKinds,
  loadedCount,
}: Props) {
  const [section, setSection] = useState<'filters' | 'types' | 'edges'>('filters');

  const patch = (next: Partial<GraphFilter>) => onFilterChange({ ...filter, ...next });

  const toggle = <T,>(list: T[] | undefined, value: T): T[] => {
    const current = list ?? [];
    return current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
  };

  const kindCounts = new Map(meta?.kinds.map((kind) => [kind.id, kind.count]) ?? []);
  const domainCounts = new Map(meta?.domains.map((domain) => [domain.id, domain.count]) ?? []);
  const relationRows = (meta?.relations ?? []).filter((relation) => relation.count > 0);

  return (
    <div className="flex h-full flex-col text-[11.5px]">
      <SearchBox onPick={onFocusNode} filter={filter} />

      {/* Live / paused, projection, camera. The controls an operator reaches
          for constantly, kept out of the collapsible sections. */}
      <div className="flex flex-wrap items-center gap-1 border-b border-white/[0.06] px-3 py-2">
        <button
          type="button"
          onClick={() => onPausedChange(!paused)}
          title={paused ? 'Resume live pulses' : 'Pause live pulses (the graph keeps refreshing)'}
          className={`rounded-md border px-2 py-1 text-[10.5px] transition-colors ${
            paused
              ? 'border-amber/40 bg-amber/[0.08] text-amber'
              : live
                ? 'border-teal/40 bg-teal/[0.08] text-teal'
                : 'border-white/10 text-[#64769c]'
          }`}
        >
          {paused ? '❚❚ Paused' : live ? '● Live' : '○ Connecting'}
        </button>

        <div className="flex overflow-hidden rounded-md border border-white/10">
          <ModeButton active={mode === 'force'} onClick={() => onModeChange('force')} title="Free force layout — clusters find their own shape">
            Graph
          </ModeButton>
          <ModeButton active={mode === 'layered'} onClick={() => onModeChange('layered')} title="Signal columns — the same graph laid out along the real request path">
            Neural
          </ModeButton>
        </div>

        <button type="button" onClick={onFit} title="Fit every loaded node in view"
          className="rounded-md border border-white/10 px-2 py-1 text-[10.5px] text-[#8ea0c4] transition-colors hover:border-white/25 hover:text-white">
          Fit
        </button>
        <button type="button" onClick={onReset} title="Reset the camera and unpin every dragged node"
          className="rounded-md border border-white/10 px-2 py-1 text-[10.5px] text-[#8ea0c4] transition-colors hover:border-white/25 hover:text-white">
          Reset
        </button>
      </div>

      <div className="flex border-b border-white/[0.06]">
        {(['filters', 'types', 'edges'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setSection(tab)}
            className={`flex-1 px-2 py-1.5 text-[10.5px] uppercase tracking-[0.08em] transition-colors ${
              section === tab ? 'border-b border-teal text-teal' : 'text-[#64769c] hover:text-[#8ea0c4]'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {section === 'filters' && (
          <div className="space-y-3">
            <Field label="Domains" hint="Cluster membership. Counts are of the whole graph.">
              <div className="flex flex-wrap gap-1">
                {GRAPH_DOMAINS.map((domain) => {
                  const on = !filter.domains?.length || filter.domains.includes(domain);
                  const count = domainCounts.get(domain) ?? 0;
                  return (
                    <button
                      key={domain}
                      type="button"
                      disabled={count === 0}
                      onClick={() => patch({ domains: toggle(filter.domains, domain) })}
                      className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors disabled:opacity-30 ${
                        on && filter.domains?.length ? 'border-white/30 text-white' : 'border-white/10 text-[#8ea0c4] hover:border-white/25'
                      }`}
                    >
                      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: DOMAIN_COLOR[domain as GraphDomain] }} />
                      {domain}
                      <span className="font-mono text-[9px] text-[#64769c]">{count}</span>
                    </button>
                  );
                })}
              </div>
              {filter.domains?.length ? (
                <button type="button" onClick={() => patch({ domains: [] })} className="mt-1 text-[10px] text-[#64769c] underline-offset-2 hover:underline">
                  clear domain filter ({filter.domains.length} selected)
                </button>
              ) : null}
            </Field>

            <Slider
              label="Time window"
              hint="Hide anything not seen recently. Structure with no timestamp is always kept."
              value={filter.sinceHours ?? 0}
              onChange={(value) => patch({ sinceHours: value === 0 ? undefined : value })}
              options={[
                { value: 0, label: 'all' },
                { value: 1, label: '1h' },
                { value: 6, label: '6h' },
                { value: 24, label: '24h' },
                { value: 168, label: '7d' },
                { value: 720, label: '30d' },
              ]}
            />

            <Range label="Min confidence" hint="Opacity encodes this. Below 0.35 an edge is drawn dashed." value={filter.minConfidence ?? 0} onChange={(value) => patch({ minConfidence: value })} />
            <Range label="Min importance" hint="Radius encodes this — raise it to keep only the hubs." value={filter.minImportance ?? 0} onChange={(value) => patch({ minImportance: value })} />
            <Range label="Min activity" hint="Halo encodes this — raise it to keep only what is moving." value={filter.minActivity ?? 0} onChange={(value) => patch({ minActivity: value })} />

            <Field label="Detail ceiling" hint="Overrides semantic zoom. 'Auto' lets the camera decide.">
              <div className="flex overflow-hidden rounded-md border border-white/10">
                {([undefined, 0, 1, 2] as const).map((value) => (
                  <ModeButton
                    key={String(value)}
                    active={filter.maxTier === value}
                    onClick={() => patch({ maxTier: value })}
                    title={value === undefined ? 'Follow the camera' : value === 0 ? 'Hubs only' : value === 1 ? 'Services, agents, concepts' : 'Everything'}
                  >
                    {value === undefined ? 'Auto' : value === 0 ? 'Hubs' : value === 1 ? 'Mid' : 'All'}
                  </ModeButton>
                ))}
              </div>
            </Field>

            <Field label="Node budget" hint={`${loadedCount} loaded. The server never returns more than 900.`}>
              <div className="flex overflow-hidden rounded-md border border-white/10">
                {[120, 260, 500, 900].map((value) => (
                  <ModeButton key={value} active={(filter.limit ?? 260) === value} onClick={() => patch({ limit: value })} title={`Load at most ${value} nodes`}>
                    {value}
                  </ModeButton>
                ))}
              </div>
            </Field>
          </div>
        )}

        {section === 'types' && (
          <div className="space-y-1">
            <p className="pb-1 text-[10px] text-[#64769c]">
              Every kind is reachable from both pages — this page just starts somewhere different.
            </p>
            {availableKinds.map((kind) => {
              const count = kindCounts.get(kind) ?? 0;
              const on = !filter.kinds?.length || filter.kinds.includes(kind);
              return (
                <label key={kind} className={`flex cursor-pointer items-center justify-between rounded px-1.5 py-1 transition-colors hover:bg-white/[0.03] ${count === 0 ? 'opacity-40' : ''}`}>
                  <span className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => patch({ kinds: toggle(filter.kinds?.length ? filter.kinds : availableKinds, kind) })}
                      className="h-3 w-3 accent-teal"
                    />
                    <span className="text-[11px] text-[#c6d0e2]">{KIND_LABEL[kind]}</span>
                  </span>
                  <span className="font-mono text-[10px] text-[#64769c]">{count}</span>
                </label>
              );
            })}
          </div>
        )}

        {section === 'edges' && (
          <div className="space-y-1">
            <p className="pb-1 text-[10px] text-[#64769c]">
              Relationship types present in the graph. Unchecking one removes those edges server-side.
            </p>
            {relationRows.length === 0 && <p className="text-[10.5px] text-[#64769c]">No edges in the current snapshot.</p>}
            {relationRows.map((relation) => {
              const on = !filter.relations?.length || filter.relations.includes(relation.id);
              return (
                <label key={relation.id} className="flex cursor-pointer items-center justify-between rounded px-1.5 py-1 transition-colors hover:bg-white/[0.03]">
                  <span className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => patch({ relations: toggle(filter.relations?.length ? filter.relations : relationRows.map((row) => row.id), relation.id) as RelationType[] })}
                      className="h-3 w-3 accent-teal"
                    />
                    <span className="text-[11px] text-[#c6d0e2]">{relation.label}</span>
                    {relation.directed && <span className="text-[9px] text-[#64769c]" title="Directed — drawn with an arrowhead">→</span>}
                  </span>
                  <span className="font-mono text-[10px] text-[#64769c]">{relation.count}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Search-to-focus.
 *
 * Server-side search over the whole graph, not a filter over what is loaded —
 * the point is to find something that is NOT on screen and fly to it. Debounced
 * so a typed word is one request rather than eight.
 */
function SearchBox({ onPick, filter }: { onPick: (id: string) => void; filter: GraphFilter }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<GraphNodeDto[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      void systemGraph
        .search(term, 12, { domains: filter.domains })
        .then((rows) => {
          setResults(rows);
          setOpen(true);
        })
        .catch(() => setResults([]));
    }, 220);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [term, filter.domains]);

  return (
    <div className="relative border-b border-white/[0.06] px-3 py-2">
      <input
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
        placeholder="Search every node…"
        className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] text-[#e2e8f0] outline-none placeholder:text-[#4b5b7d] focus:border-teal"
      />
      {open && results.length > 0 && (
        <ul className="absolute left-3 right-3 top-[38px] z-20 max-h-[280px] overflow-auto rounded-md border border-white/10 bg-[#0d1524] shadow-lg">
          {results.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onPick(node.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-white/[0.05]"
              >
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: DOMAIN_COLOR[node.domain] }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] text-[#e2e8f0]">{node.label}</span>
                  <span className="block truncate text-[9.5px] text-[#64769c]">{KIND_LABEL[node.kind]} · {node.domain}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ModeButton({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`px-2 py-1 text-[10.5px] transition-colors ${active ? 'bg-teal/[0.14] text-teal' : 'text-[#8ea0c4] hover:bg-white/[0.04]'}`}
    >
      {children}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-[#64769c]">{label}</div>
      {hint && <div className="mb-1 text-[9.5px] text-[#4b5b7d]">{hint}</div>}
      {children}
    </div>
  );
}

function Range({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (value: number) => void }) {
  return (
    <Field label={`${label} · ${value.toFixed(2)}`} hint={hint}>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-teal"
      />
    </Field>
  );
}

function Slider({
  label,
  hint,
  value,
  onChange,
  options,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
  options: Array<{ value: number; label: string }>;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex overflow-hidden rounded-md border border-white/10">
        {options.map((option) => (
          <ModeButton key={option.value} active={value === option.value} onClick={() => onChange(option.value)} title={`Last ${option.label}`}>
            {option.label}
          </ModeButton>
        ))}
      </div>
    </Field>
  );
}
