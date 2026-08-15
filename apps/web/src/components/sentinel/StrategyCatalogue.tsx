'use client';

import { useState } from 'react';
import { splitCatalogue } from '@/lib/sentinel/strategyContract';
import type { TemplateSummary } from '@/lib/sentinel/strategyContract';
import { useAdoptTemplate, useStrategyTemplates } from '@/lib/query/useSentinel';

/**
 * The catalogue: a menu the user adopts from.
 *
 * Availability is shown unmistakably, and it is NOT a ranking. Within each
 * group the backend's order is preserved — nothing here sorts by quality,
 * marks a favourite, or nominates one strategy over another. Sentinel does
 * not have an opinion about which strategy the user should trade.
 *
 * An unavailable template shows the backend's own reason verbatim. Some wait
 * on an indicator; News Momentum waits on an entire research pipeline. Saying
 * "coming soon" for both would flatten a real difference.
 */

interface Props {
  onAdopted: (strategyId: string) => void;
}

export function StrategyCatalogue({ onAdopted }: Props) {
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);

  const templatesQuery = useStrategyTemplates();
  // Adopting creates a strategy, so the mutation invalidates the sentinel
  // queries rather than leaving the catalogue claiming this template is still
  // un-adopted — see lib/query/useSentinel.
  const adoptTemplate = useAdoptTemplate();

  const templates = templatesQuery.data ?? null;
  const loadError =
    templatesQuery.isError && !templates
      ? templatesQuery.error instanceof Error
        ? templatesQuery.error.message
        : 'Could not load templates'
      : null;
  const error = adoptError ?? loadError;

  async function adopt(template: TemplateSummary) {
    if (!template.id || !template.available) return;
    setAdopting(template.id);
    setAdoptError(null);
    try {
      const created = await adoptTemplate.mutateAsync(template.id);
      onAdopted(created.id);
    } catch (err) {
      setAdoptError(err instanceof Error ? err.message : 'Could not adopt this strategy');
    } finally {
      setAdopting(null);
    }
  }

  if (loadError) {
    return (
      <div className="text-sm text-red-400">
        <p>{loadError}</p>
        <button
          type="button"
          onClick={() => void templatesQuery.refetch()}
          className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text hover:border-teal"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!templates) {
    return <p className="text-sm text-muted">Loading strategies…</p>;
  }

  const { available, unavailable } = splitCatalogue(templates);

  return (
    <section data-testid="strategy-catalogue" className="space-y-6">
      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Available</h3>
        <ul className="space-y-2">
          {available.map((template) => (
            <li
              key={template.id}
              data-testid={`template-${template.id}`}
              className="rounded-lg border border-line bg-bg1 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-fg">{template.name}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{template.summary}</p>
                  {template.direction === 'long_only' && (
                    <p className="mt-1 text-[11px] text-faint">Long only</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => adopt(template)}
                  disabled={adopting === template.id}
                  className="shrink-0 rounded-md border border-line px-3 py-1.5 text-xs text-fg hover:bg-bg2 disabled:opacity-50"
                >
                  {adopting === template.id ? 'Adopting…' : 'Adopt'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {unavailable.length > 0 && (
        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
            Unavailable
          </h3>
          <ul className="space-y-2">
            {unavailable.map((template) => (
              <li
                key={template.id}
                data-testid={`template-${template.id}`}
                className="rounded-lg border border-line bg-bg2/40 p-3 opacity-80"
              >
                <p className="text-sm font-medium text-muted">{template.name}</p>
                <p className="mt-1 text-xs leading-relaxed text-faint">{template.summary}</p>
                {/* The backend's exact words. It knows whether this is waiting
                    on a function or on a subsystem; this component does not. */}
                <p className="mt-2 text-[11px] text-amber">{template.unavailableReason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  );
}
