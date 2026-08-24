'use client';

import { useState } from 'react';
import { DOMAIN_COLOR, type GraphDomain, type GraphMeta } from '@/lib/graph';

/**
 * The legend, rendered from the SERVER's published visual contract.
 *
 * `meta.encoding` is produced by the same module that computes the fields the
 * canvas draws, so this legend cannot drift from the renderer. That is the
 * whole reason it is fetched rather than written out here: a hand-maintained
 * legend describing what a thick edge means is correct exactly until someone
 * changes what a thick edge means, and nothing fails when it stops being true.
 */
export function GraphLegend({ meta, domains }: { meta: GraphMeta | null; domains?: GraphDomain[] }) {
  const [open, setOpen] = useState(false);
  if (!meta) return null;

  const shown = (domains?.length ? meta.domains.filter((row) => domains.includes(row.id)) : meta.domains).filter((row) => row.count > 0);

  return (
    <div className="border-t border-white/[0.06]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[10px] text-[#64769c]">
        {shown.map((row) => (
          <span key={row.id} className="flex items-center gap-1" title={`${row.count} nodes in the whole graph`}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: DOMAIN_COLOR[row.id] }} />
            {row.id}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="ml-auto text-[10px] text-[#8ea0c4] underline-offset-2 hover:underline"
        >
          {open ? 'hide' : 'what the visuals mean'}
        </button>
      </div>

      {open && (
        <div className="border-t border-white/[0.06] px-3 py-2">
          <p className="mb-1.5 text-[10px] text-[#4b5b7d]">
            Published by <code className="text-[9.5px]">GET /admin/graph/meta</code> — the same module that computes these fields.
            Nothing on the canvas is styled for looks.
          </p>
          <table className="w-full">
            <tbody>
              {meta.encoding.map((row) => (
                <tr key={row.property} className="align-top">
                  <td className="whitespace-nowrap py-0.5 pr-2 text-[10px] text-[#c6d0e2]">{row.property}</td>
                  <td className="whitespace-nowrap py-0.5 pr-2 font-mono text-[9.5px] text-teal">{row.field}</td>
                  <td className="py-0.5 text-[10px] text-[#64769c]">{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {meta.degraded.length > 0 && (
            <p className="mt-2 rounded border border-amber/30 bg-amber/[0.06] px-2 py-1 text-[10px] text-amber">
              Sources that could not be read on the last build: {meta.degraded.join(', ')}. Those clusters are empty because the
              query failed, not because nothing happened.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
