'use client';

import type { ReactNode } from 'react';
import { Badge, cn } from '@tradew/ui';
import { useSettingsStore } from '@/lib/store/settingsStore';
import type { PreferenceKey } from '@/lib/settings/preferences';

/**
 * The control vocabulary every Settings section is built from.
 *
 * One rule runs through all of it: a control that cannot persist must not look
 * like one that can. `SettingRow` takes an `unavailable` reason, renders the
 * control disabled and says why — that is the honest alternative to hiding the
 * capability (which leaves the user wondering) or wiring it to nothing (which
 * lies).
 */

export function SettingRow({
  label,
  hint,
  htmlFor,
  control,
  unavailable,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  control: ReactNode;
  /** Why this control does nothing on this deployment. Shown as a badge and a
   *  line of explanation; the caller is responsible for disabling the input. */
  unavailable?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 border-b border-border py-3 last:border-b-0',
        'sm:flex-row sm:items-center sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text">
          {label}
          {unavailable && (
            <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
              UNAVAILABLE
            </Badge>
          )}
        </label>
        {hint && <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-muted">{hint}</p>}
        {unavailable && <p className="mt-1 max-w-prose text-xs leading-relaxed text-amber">{unavailable}</p>}
      </div>
      <div className="shrink-0 sm:min-w-[200px] sm:text-right">{control}</div>
    </div>
  );
}

export function Toggle({
  id,
  checked,
  onChange,
  disabled,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name, used when the visible label sits in a SettingRow. */
  label: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-micro',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-teal bg-teal' : 'border-border2 bg-bg',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-micro',
          checked ? 'translate-x-6' : 'translate-x-1',
        )}
      />
    </button>
  );
}

export function Select<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  id: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <select
      id={id}
      value={value}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(
        'w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text sm:w-auto',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TextField({
  id,
  value,
  onChange,
  type = 'text',
  placeholder,
  disabled,
  label,
  autoComplete,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  type?: 'text' | 'password' | 'number';
  placeholder?: string;
  disabled?: boolean;
  label: string;
  autoComplete?: string;
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      autoComplete={autoComplete}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    />
  );
}

/**
 * Per-section save feedback.
 *
 * It reads the store's real save state, which only reaches `saved` after the
 * server acknowledged the write — an optimistic "Saved" that appears on click
 * is precisely what this area must not do, and rendering from the store rather
 * than from a local boolean is what stops one creeping back in.
 */
export function SaveStatus({ section }: { section: PreferenceKey }) {
  const state = useSettingsStore((s) => s.saveState[section]);
  const error = useSettingsStore((s) => s.saveError[section]);

  if (state === 'saving') return <span className="text-[11px] font-semibold text-muted">Saving…</span>;
  if (state === 'saved') return <span className="text-[11px] font-semibold text-up">Saved to your account</span>;
  if (state === 'error') {
    return <span className="text-[11px] font-semibold text-down">{error ?? 'Could not save.'}</span>;
  }
  return null;
}

/** Standard banner for a section a signed-out visitor has opened. */
export function SignInRequired({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-border2 bg-bg p-4">
      <p className="text-sm text-muted">
        Sign in to {what}. Settings are stored on your TradeW account, not in this browser — there is
        nothing to read or write for a signed-out visitor.
      </p>
    </div>
  );
}
