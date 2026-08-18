'use client';

import { useState } from 'react';
import { Button, cn, CandleLoader } from '@tradew/ui';
import { ApiError } from '@/lib/api';
import type { OpenPositionInput, PositionDirection, WatchSession } from '@/lib/sentinel/strategyApi';
import { plannedRatio, validatePosition } from '@/lib/sentinel/watchModel';

/**
 * "I'm in" — the user declaring a position they have ALREADY taken.
 *
 * Every number in this form is theirs. Sentinel proposes no entry, no
 * invalidation level and no projection; it takes the three the user gives it
 * and reports where price goes relative to them. That is the whole reason
 * in-trade monitoring can exist without becoming a trade recommendation, and
 * the copy here says so rather than leaving it implied.
 *
 * Prefilling the entry with the live price is a convenience for a fill that
 * just happened, not a suggestion — it is editable, and it is the only field
 * that is ever prefilled. Suggesting an invalidation or projected level would
 * be Sentinel deciding the user's risk for them.
 */
export function PositionEntryForm({
  watch,
  livePrice,
  onSubmit,
  onCancel,
}: {
  watch: WatchSession;
  livePrice: number | null;
  onSubmit: (watchId: string, input: OpenPositionInput) => Promise<WatchSession>;
  onCancel: () => void;
}) {
  const [entry, setEntry] = useState(livePrice !== null ? String(livePrice) : '');
  const [invalidation, setInvalidation] = useState('');
  const [projected, setProjected] = useState('');
  const [direction, setDirection] = useState<PositionDirection>('LONG');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const parsed = {
    entryPrice: toNumber(entry),
    invalidationPrice: toNumber(invalidation),
    projectedPrice: toNumber(projected),
    direction,
  };
  const validation = validatePosition(parsed);
  const ratio = plannedRatio(parsed.entryPrice, parsed.invalidationPrice, parsed.projectedPrice);

  const handleSubmit = async () => {
    setSubmitted(true);
    if (!validation.valid) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(watch.id, {
        entryPrice: parsed.entryPrice as number,
        invalidationPrice: parsed.invalidationPrice as number,
        projectedPrice: parsed.projectedPrice,
        direction,
      });
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex rounded-lg border border-border bg-bg p-0.5" role="group" aria-label="Direction">
        {(['LONG', 'SHORT'] as const).map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={direction === d}
            onClick={() => setDirection(d)}
            className={cn(
              'flex-1 rounded-md py-1.5 text-[12px] font-bold transition-colors duration-micro',
              direction === d ? (d === 'LONG' ? 'bg-up-bg text-up' : 'bg-down-bg text-down') : 'text-muted hover:text-text',
            )}
          >
            {d === 'LONG' ? 'Long' : 'Short'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <PriceInput
          id={`entry-${watch.id}`}
          label="Your entry"
          value={entry}
          onChange={setEntry}
          hint={livePrice !== null ? 'prefilled with the live price' : undefined}
        />
        <PriceInput
          id={`invalidation-${watch.id}`}
          label="Invalidation"
          value={invalidation}
          onChange={setInvalidation}
          hint="where you'd be wrong"
        />
        <PriceInput
          id={`projected-${watch.id}`}
          label="Projected"
          value={projected}
          onChange={setProjected}
          hint="optional"
        />
      </div>

      {ratio !== null && (
        <p className="text-[11px] text-muted">
          That is <span className="font-mono font-semibold text-text">1 : {ratio.toFixed(2)}</span> against the risk you
          defined.
        </p>
      )}

      {submitted && validation.errors.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-lg border border-down bg-down-bg px-3 py-2">
          {validation.errors.map((e) => (
            <li key={e} className="text-[11.5px] leading-relaxed text-down">
              {e}
            </li>
          ))}
        </ul>
      )}

      {validation.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber bg-amber-bg px-3 py-2">
          {validation.warnings.map((w) => (
            <li key={w} className="text-[11.5px] leading-relaxed text-amber">
              {w}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-down bg-down-bg px-3 py-2 text-[11.5px] text-down">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSubmit} disabled={busy}>
          {busy && <CandleLoader size="sm" decorative />}
          {busy ? 'Saving…' : 'Confirm position'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>

      <p className="text-[10.5px] leading-relaxed text-faint">
        These are your own numbers for a position you have already taken. Sentinel does not place the order and does not
        choose any of these levels — it reports where price moves relative to them.
      </p>
    </div>
  );
}

function PriceInput({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="text-[10px] font-semibold uppercase tracking-wide text-faint">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        placeholder="0.00"
        className="mt-1 w-full rounded-lg border border-border bg-bg px-2.5 py-2 font-mono text-[12.5px] text-text placeholder:text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      />
      {hint && <p className="mt-0.5 truncate text-[9.5px] text-faint">{hint}</p>}
    </div>
  );
}

/** Blank stays blank — an empty projected level is legitimately absent, not 0. */
function toNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : NaN;
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your session has expired. Sign in again to record this position.';
    if (err.status === 404) return 'This watch no longer exists.';
    return err.message || 'The position could not be recorded.';
  }
  return 'The position could not be recorded — the TradeW API could not be reached.';
}
