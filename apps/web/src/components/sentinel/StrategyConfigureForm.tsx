'use client';

import type { ConfigParameter } from '@/lib/sentinel/strategyContract';

/**
 * The configuration form, rendered from `configuration.parameters`.
 *
 * There is no per-strategy form here and there must never be one. The form is
 * a loop over whatever parameters the backend derived from the user's own
 * rules: a seven-rule strategy gets seven controls, a four-rule strategy gets
 * four, and a strategy invented next year gets however many it has. The
 * component knows about parameter TYPES (choice, toggle, readonly) and
 * nothing at all about EMAs, VWAP or liquidity.
 *
 * Mandatory rules render locked rather than hidden: the user should see the
 * whole definition of the strategy they adopted, including the parts that
 * make it that strategy.
 */

interface Props {
  strategyName: string;
  parameters: ConfigParameter[];
  onChange?: (key: string, value: string | boolean) => void;
}

export function StrategyConfigureForm({ strategyName, parameters, onChange }: Props) {
  const mandatory = parameters.filter((p) => p.group === 'mandatory');
  const optional = parameters.filter((p) => p.group === 'optional');
  const settings = parameters.filter((p) => !p.group);

  return (
    <section data-testid="strategy-configure" className="space-y-5">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted">My strategy</p>
        <h2 className="text-base font-medium text-fg">{strategyName}</h2>
      </header>

      <dl className="space-y-2">
        {settings.map((parameter) => (
          <div key={parameter.key} className="flex items-center justify-between gap-4">
            <dt className="text-xs text-muted">{parameter.label}</dt>
            <dd className="text-xs text-fg">
              {parameter.type === 'choice' ? (
                <select
                  aria-label={parameter.label}
                  value={String(parameter.value)}
                  onChange={(event) => onChange?.(parameter.key, event.target.value)}
                  className="rounded-md border border-line bg-bg1 px-2 py-1 text-xs text-fg"
                >
                  {(parameter.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                String(parameter.value)
              )}
            </dd>
          </div>
        ))}
      </dl>

      {[
        { title: 'Required conditions', rows: mandatory },
        { title: 'Optional confirmations', rows: optional },
      ]
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <div key={group.title}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {group.title}
            </h3>
            <ul className="space-y-2">
              {group.rows.map((parameter) => (
                <li
                  key={parameter.key}
                  data-testid={`param-${parameter.key}`}
                  className="flex items-start justify-between gap-3 rounded-md border border-line bg-bg1 px-3 py-2"
                >
                  <span className="text-xs leading-relaxed text-fg">{parameter.label}</span>
                  {parameter.locked ? (
                    <span className="shrink-0 text-[11px] uppercase tracking-wide text-faint">
                      Required
                    </span>
                  ) : (
                    <input
                      type="checkbox"
                      aria-label={parameter.label}
                      defaultChecked={Boolean(parameter.value)}
                      onChange={(event) => onChange?.(parameter.key, event.target.checked)}
                      className="mt-0.5 shrink-0"
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}
