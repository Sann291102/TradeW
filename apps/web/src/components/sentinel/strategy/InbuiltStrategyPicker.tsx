'use client';

import { useEffect, useState } from 'react';
import { Button } from '@tradew/ui';
import { adoptTemplate, listTemplates } from '@/lib/sentinel/strategyContract';
import type { TemplateSummary } from '@/lib/sentinel/strategyContract';

/**
 * The second way into a strategy: pick one Sentinel already knows how to
 * evaluate, instead of describing your own. Both routes end at the same
 * `UserStrategy`, and this sits directly under the description box so the
 * choice is visible in one place rather than on a separate page.
 *
 * Everything shown here — the list, the explanation, the mode, whether a
 * strategy can be adopted at all and why not — comes from the backend
 * catalogue. There is no strategy knowledge in this file: no names, no rule
 * lists, no per-strategy copy. That is what lets a new template appear in the
 * dropdown, explain itself and be adopted without a frontend change.
 *
 * Selecting is not adopting. The preview exists so the user reads what the
 * strategy actually does before it becomes theirs, and Sentinel never picks
 * one on their behalf — nothing here is preselected, recommended or ranked.
 */

interface Props {
  onAdopted: (strategyId: string) => void;
}

export function InbuiltStrategyPicker({ onAdopted }: Props) {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);

  useEffect(() => {
    let live = true;
    listTemplates()
      .then((rows) => live && setTemplates(rows))
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load the catalogue'));
    return () => {
      live = false;
    };
  }, []);

  const selected = templates?.find((t) => t.id === selectedId) ?? null;

  async function adopt() {
    // Guarded as well as disabled: an unavailable template would be saved as a
    // strategy that can never fire, and the user would have no way to tell
    // that from a quiet market.
    if (!selected?.id || !selected.available) return;
    setAdopting(true);
    setError(null);
    try {
      const created = await adoptTemplate(selected.id);
      setSelectedId('');
      onAdopted(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not adopt this strategy');
    } finally {
      setAdopting(false);
    }
  }

  return (
    <section data-testid="inbuilt-strategy" className="space-y-3">
      <h3 className="text-[12px] font-bold uppercase tracking-wide text-faint">Inbuilt strategy</h3>

      <select
        aria-label="Inbuilt strategy"
        data-testid="inbuilt-select"
        value={selectedId}
        onChange={(e) => setSelectedId(e.target.value)}
        disabled={!templates}
        className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[12.5px] text-text disabled:opacity-60"
      >
        <option value="">{templates ? 'Select a strategy' : 'Loading strategies…'}</option>
        {(templates ?? []).map((template) => (
          <option
            key={template.id}
            value={template.id ?? ''}
            // Unavailable entries stay VISIBLE and unselectable: hiding one
            // would silently shrink the catalogue, and the reason it cannot be
            // used is information the user is entitled to.
            disabled={!template.available}
          >
            {template.available
              ? template.name
              : `${template.name} — ${template.unavailableReason ?? 'Unavailable'}`}
          </option>
        ))}
      </select>

      {selected && (
        <div data-testid="strategy-preview" className="rounded-xl border border-border bg-bg p-3.5">
          <h4 className="text-[12px] font-bold uppercase tracking-wide text-faint">Selected strategy</h4>
          <p className="mt-1 text-[13.5px] font-bold text-text">{selected.name}</p>

          <p className="mt-2 text-[12px] leading-relaxed text-muted">{selected.summary}</p>

          {(selected.steps?.length ?? 0) > 0 && (
            <>
              <h5 className="mt-3 text-[11px] font-bold uppercase tracking-wide text-faint">How it works</h5>
              <ol className="mt-1.5 space-y-1">
                {selected.steps!.map((step, index) => (
                  <li key={step} className="flex gap-2 text-[12px] leading-relaxed text-text">
                    <span className="shrink-0 tabular-nums text-faint">{index + 1}.</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </>
          )}

          {selected.mode && (
            <p className="mt-3 text-[11.5px] text-muted">
              <span className="font-bold uppercase tracking-wide text-faint">Mode</span> · {selected.mode}
            </p>
          )}

          <div className="mt-3">
            {selected.available ? (
              <Button size="sm" onClick={() => void adopt()} disabled={adopting}>
                {adopting ? 'Adopting…' : 'Adopt strategy'}
              </Button>
            ) : (
              <p className="text-[11.5px] text-amber">{selected.unavailableReason}</p>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-[11.5px] text-down">{error}</p>}
    </section>
  );
}
