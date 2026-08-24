'use client';

import { useCallback, useEffect, useState } from 'react';
import { systemGraph, type SignalPath } from '@/lib/graph';
import { Empty, Panel, fmtTime } from '@/components/ui';

/**
 * One real request, traced hop by hop.
 *
 * ## Why this exists
 *
 * The topology above shows that a route CAN reach an agent. This shows that a
 * specific request DID — reconstructed from `ApiCallLog` and the `AiCallLog`
 * rows that share its `requestId`, plus the agent transitions of any run that
 * carried the same id.
 *
 * That correlation id is the only place in this platform where "an HTTP
 * request reached this agent" is recorded as a fact rather than inferred from
 * a naming convention, so every hop here is evidenced and the evidence is
 * printed under it.
 *
 * ## When there is nothing to show
 *
 * It says so. With no correlated traffic there is no path, and this renders an
 * empty state rather than an illustrative example — a fabricated trace on a
 * screen whose whole claim is "this actually happened" would be the worst
 * possible thing to draw here.
 */
export function SignalPathStrip({ onSelectNode }: { onSelectNode: (id: string) => void }) {
  const [path, setPath] = useState<SignalPath | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestId, setRequestId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((id?: string) => {
    setLoading(true);
    void systemGraph
      .path(id ? { requestId: id } : {})
      .then((row) => {
        setPath(row);
        setError(row === null && id ? 'No telemetry for that correlation id.' : null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not trace that request.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    // Re-pulled on a slow cadence: the newest correlated request changes with
    // traffic, and a faster poll would re-render a strip nobody asked to move.
    const timer = setInterval(() => load(), 45_000);
    return () => clearInterval(timer);
  }, [load]);

  const durationMs = path?.startedAt && path.finishedAt ? path.finishedAt - path.startedAt : null;

  return (
    <Panel
      title="Signal path"
      subtitle="The most recent real request, traced through the nodes above"
      right={
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            load(requestId.trim() || undefined);
          }}
        >
          <input
            value={requestId}
            onChange={(event) => setRequestId(event.target.value)}
            placeholder="request id…"
            className="w-[190px] rounded-md border border-white/10 bg-black/40 px-2 py-0.5 font-mono text-[10.5px] outline-none placeholder:text-[#4b5b7d] focus:border-teal"
          />
          <button
            type="submit"
            className="rounded-md border border-white/10 px-2 py-0.5 text-[10.5px] text-muted transition-colors hover:border-white/25 hover:text-text"
          >
            Trace
          </button>
          {requestId && (
            <button
              type="button"
              onClick={() => {
                setRequestId('');
                load();
              }}
              className="text-[10.5px] text-faint underline-offset-2 hover:underline"
            >
              latest
            </button>
          )}
        </form>
      }
    >
      {error && <div className="px-4 pt-2 text-[11px] text-amber">{error}</div>}

      {!path || path.steps.length === 0 ? (
        <Empty>
          {loading
            ? 'Tracing…'
            : 'No correlated request in telemetry yet. A path appears as soon as one HTTP request causes an LLM call or an agent run.'}
        </Empty>
      ) : (
        <div className="p-4">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-faint">
            {path.requestId && <span className="font-mono">{path.requestId}</span>}
            {path.startedAt && <span>started {fmtTime(path.startedAt)}</span>}
            {durationMs !== null && <span className="num">{durationMs}ms end to end</span>}
            <span className={path.status === 'error' ? 'text-down' : path.status === 'partial' ? 'text-amber' : 'text-up'}>{path.status}</span>
          </div>

          <ol className="flex flex-wrap items-stretch gap-1">
            {path.steps.map((step, index) => (
              <li key={`${step.nodeId}-${index}`} className="flex items-stretch gap-1">
                {index > 0 && (
                  <span className="flex items-center px-0.5 text-[13px] text-teal" aria-hidden>
                    →
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onSelectNode(step.nodeId)}
                  title={step.evidence}
                  className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-left transition-colors hover:border-teal/40 hover:bg-teal/[0.06]"
                >
                  <div className="text-[10px] uppercase tracking-[0.08em] text-faint">
                    {step.kind}
                    {step.relation && <span className="ml-1 normal-case text-[9.5px] text-[#4b5b7d]">{step.relation.replace(/_/g, ' ')}</span>}
                  </div>
                  <div className="max-w-[220px] truncate text-[11.5px] text-[#e2e8f0]">{step.label}</div>
                  <div className="max-w-[220px] truncate text-[9.5px] text-faint">{step.evidence}</div>
                </button>
              </li>
            ))}
          </ol>

          <p className="mt-2 text-[10px] text-[#4b5b7d]">
            Every hop is a row that exists: the route from <code>ApiCallLog</code>, the controller from the running container, the
            agents from <code>AiCallLog</code> and <code>AgentActivity</code> sharing this correlation id. Click a hop to focus it on
            the network.
          </p>
        </div>
      )}
    </Panel>
  );
}
