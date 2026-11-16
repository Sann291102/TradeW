'use client';

import { useEffect, useState } from 'react';
import { buttonClasses, cn } from '@tradew/ui';
import { ApiError } from '@/lib/api';
import type { Address, AddressView } from '@/lib/payments';

const COUNTRIES: Array<[string, string]> = [
  ['US', 'United States'],
  ['IN', 'India'],
  ['GB', 'United Kingdom'],
  ['CA', 'Canada'],
  ['AU', 'Australia'],
  ['SG', 'Singapore'],
  ['AE', 'United Arab Emirates'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['NL', 'Netherlands'],
  ['IE', 'Ireland'],
  ['NZ', 'New Zealand'],
  ['JP', 'Japan'],
];

const EMPTY: Address = { name: '', phone: '', line1: '', line2: '', city: '', state: '', postalCode: '', country: 'US' };

const field =
  'mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus aria-[invalid=true]:border-down';

/**
 * Billing / shipping address form. Validation messages come from the API
 * (`fields`), so the browser and the server can never disagree about what a
 * valid address is. The country list covers the common cases; any other ISO
 * 3166-1 alpha-2 code can be typed under "Other".
 */
export function AddressForm({
  initial,
  kind,
  onSave,
  onCancel,
  submitLabel,
}: {
  initial: AddressView | Address | null;
  kind: 'billing' | 'shipping';
  onSave: (a: Address) => Promise<unknown>;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const [value, setValue] = useState<Address>(initial ? { ...EMPTY, ...stripNulls(initial) } : EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [otherCountry, setOtherCountry] = useState(Boolean(initial?.country && !COUNTRIES.some(([c]) => c === initial.country)));

  useEffect(() => {
    if (initial) setValue({ ...EMPTY, ...stripNulls(initial) });
  }, [initial]);

  const set = (k: keyof Address) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValue((v) => ({ ...v, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      await onSave({ ...value, country: value.country.trim().toUpperCase() });
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields);
      setMessage(err instanceof Error ? err.message : 'Could not save the address.');
    } finally {
      setBusy(false);
    }
  }

  const id = (k: string) => `${kind}-${k}`;
  const label = (k: keyof Address, text: string, opts: { required?: boolean; autoComplete?: string; placeholder?: string } = {}) => (
    <label htmlFor={id(k)} className="block text-xs text-faint">
      {text}
      {opts.required ? '' : ' (optional)'}
      <input
        id={id(k)}
        value={(value[k] as string) ?? ''}
        onChange={set(k)}
        required={opts.required}
        autoComplete={opts.autoComplete ? `${kind} ${opts.autoComplete}` : undefined}
        placeholder={opts.placeholder}
        aria-invalid={Boolean(errors[k])}
        aria-describedby={errors[k] ? `${id(k)}-err` : undefined}
        className={field}
      />
      {errors[k] && (
        <span id={`${id(k)}-err`} className="mt-1 block text-[11px] text-down">
          {errors[k]}
        </span>
      )}
    </label>
  );

  return (
    <form onSubmit={submit} className="space-y-3" aria-label={`${kind === 'billing' ? 'Billing' : 'Shipping'} address`}>
      <div className="grid gap-3 sm:grid-cols-2">
        {label('name', 'Contact name', { required: true, autoComplete: 'name' })}
        {label('phone', 'Phone', { autoComplete: 'tel', placeholder: '+1 415 555 0100' })}
      </div>
      {label('line1', 'Address line 1', { required: true, autoComplete: 'address-line1' })}
      {label('line2', 'Address line 2', { autoComplete: 'address-line2' })}
      <div className="grid gap-3 sm:grid-cols-3">
        {label('city', 'City', { required: true, autoComplete: 'address-level2' })}
        {label('state', value.country === 'US' ? 'State (e.g. CA)' : 'State / province', {
          required: ['US', 'CA', 'IN'].includes(value.country),
          autoComplete: 'address-level1',
        })}
        {label('postalCode', value.country === 'US' ? 'ZIP code' : 'Postal code', { required: true, autoComplete: 'postal-code' })}
      </div>
      <label htmlFor={id('country')} className="block text-xs text-faint">
        Country
        {otherCountry ? (
          <input
            id={id('country')}
            value={value.country}
            onChange={set('country')}
            maxLength={2}
            placeholder="Two-letter code, e.g. BR"
            aria-invalid={Boolean(errors.country)}
            className={field}
          />
        ) : (
          <select
            id={id('country')}
            value={value.country}
            onChange={(e) => {
              if (e.target.value === '__other') {
                setOtherCountry(true);
                setValue((v) => ({ ...v, country: '' }));
              } else set('country')(e);
            }}
            autoComplete={`${kind} country`}
            className={field}
          >
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
            <option value="__other">Other…</option>
          </select>
        )}
        {errors.country && <span className="mt-1 block text-[11px] text-down">{errors.country}</span>}
      </label>
      {message && (
        <p role="alert" className="text-xs text-down">
          {message}
        </p>
      )}
      <div className="flex gap-2 pt-1">
        <button type="submit" disabled={busy} className={buttonClasses({ size: 'sm' })}>
          {busy ? 'Saving…' : submitLabel ?? 'Save address'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={cn(buttonClasses({ size: 'sm', variant: 'ghost' }))}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function stripNulls(a: Address | AddressView): Address {
  return {
    name: a.name ?? '',
    phone: a.phone ?? '',
    line1: a.line1 ?? '',
    line2: a.line2 ?? '',
    city: a.city ?? '',
    state: a.state ?? '',
    postalCode: a.postalCode ?? '',
    country: a.country ?? 'US',
  };
}

export function addressSummary(a: Address | null | undefined): string {
  if (!a) return '';
  return [a.line1, a.line2, a.city, [a.state, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ');
}
