'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, cn } from '@tradew/ui';
import { ApiError } from '@/lib/api';
import { MarketSelector } from '@/components/sentinel/MarketSelector';
import { formatLtp, strikeOptionLabel } from '@/lib/sentinel/optionChain';
import { useExpiries } from '@/lib/sentinel/useExpiries';
import { useOptionChainStrikes } from '@/lib/sentinel/useOptionChainStrikes';
import { formatExpiry } from '@/lib/sentinel/watchModel';
import type { CreateWatchInput, OptionType, UserStrategy, WatchSession } from '@/lib/sentinel/strategyApi';
import { ChevronDownIcon } from '@/components/shell/icons';

/**
 * Apply a saved strategy to something: market → expiry → CE/PE → strike →
 * "Start watching".
 *
 * The pickers are the existing live Dhan bridge, not a new data path — the
 * same expiry list and option chain the Option Chain panel reads. The one
 * addition is that the expiry is CHOSEN here rather than resolved to the
 * nearest, because a watch may deliberately be on a later series.
 *
 * A symbol with no options market is not a dead end: the underlying itself can
 * be watched, which is what `strike`/`optionType`/`expiry` being nullable in
 * the API is for.
 */
export function WatchCreator({
  strategy,
  onStart,
  onStarted,
}: {
  strategy: UserStrategy | null;
  onStart: (input: CreateWatchInput) => Promise<WatchSession>;
  onStarted?: (watch: WatchSession) => void;
}) {
  const [symbol, setSymbol] = useState('NIFTY');
  const [expiry, setExpiry] = useState<string | null>(null);
  const [optionType, setOptionType] = useState<OptionType>('CE');
  const [strike, setStrike] = useState<number | null>(null);
  const [underlyingOnly, setUnderlyingOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expiries = useExpiries(symbol);
  const hasOptions = expiries.status === 'ready';
  // Only fetch a chain once an expiry is settled, and never for a watch on the
  // underlying — the ladder would be unused network traffic against a
  // rate-limited upstream.
  const chain = useOptionChainStrikes(symbol, hasOptions && !underlyingOnly, expiry);
  const rows = optionType === 'CE' ? chain.ce : chain.pe;

  // A new market means a new chain: nothing about the previous selection
  // carries over, and a NIFTY strike on BANKNIFTY would be nonsense.
  useEffect(() => {
    setExpiry(null);
    setStrike(null);
    setUnderlyingOnly(false);
    setError(null);
  }, [symbol]);

  // Default to the nearest expiry once the list resolves; the user can change it.
  useEffect(() => {
    if (expiries.status === 'ready' && expiry === null) setExpiry(expiries.nearest);
    if (expiries.status === 'unavailable') setUnderlyingOnly(true);
  }, [expiries.status, expiries.nearest, expiry]);

  // Default to the at-the-money strike when a ladder arrives, and drop a
  // selection that the new ladder does not contain.
  useEffect(() => {
    if (chain.status !== 'live') return;
    setStrike((current) => {
      if (current !== null && rows.some((r) => r.strike === current)) return current;
      return rows[chain.atmIndex]?.strike ?? null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.status, chain.atmIndex, chain.expiry, optionType]);

  const watchingUnderlying = underlyingOnly || !hasOptions;
  const ready =
    strategy !== null && (watchingUnderlying || (expiry !== null && strike !== null && chain.status === 'live'));

  const handleStart = async () => {
    if (!strategy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const created = await onStart({
        strategyId: strategy.id,
        symbol,
        // A watch on the underlying carries none of the option fields, which
        // is exactly how the engine tells the two apart.
        strike: watchingUnderlying ? null : String(strike),
        optionType: watchingUnderlying ? null : optionType,
        expiry: watchingUnderlying ? null : expiry,
      });
      onStarted?.(created);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const selectedLtp = strike !== null ? rows.find((r) => r.strike === strike)?.ltp ?? null : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Watch</span>
        <MarketSelector value={symbol} onChange={setSymbol} />
        {expiries.status === 'loading' && <span className="text-[11px] text-faint">checking expiries…</span>}
      </div>

      {expiries.status === 'unavailable' ? (
        <p className="rounded-lg border border-border bg-bg px-3 py-2 text-[11.5px] leading-relaxed text-muted">
          {symbol} has no live option chain, so this watch will follow the underlying itself. Indices like NIFTY,
          BANKNIFTY, FINNIFTY and SENSEX have one.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Expiry">
              <Select
                value={expiry ?? ''}
                onChange={(v) => {
                  setExpiry(v || null);
                  setStrike(null);
                }}
                disabled={!hasOptions || underlyingOnly}
                ariaLabel="Expiry"
              >
                {expiry === null && <option value="">Select expiry</option>}
                {expiries.expiries.map((e) => (
                  <option key={e} value={e}>
                    {formatExpiry(e)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Side">
              <div className="flex rounded-lg border border-border bg-bg p-0.5" role="group" aria-label="Option type">
                {(['CE', 'PE'] as const).map((side) => (
                  <button
                    key={side}
                    type="button"
                    aria-pressed={optionType === side}
                    disabled={underlyingOnly}
                    onClick={() => setOptionType(side)}
                    className={cn(
                      'flex-1 rounded-md py-1.5 text-[12px] font-bold transition-colors duration-micro disabled:opacity-50',
                      optionType === side
                        ? side === 'CE'
                          ? 'bg-up-bg text-up'
                          : 'bg-down-bg text-down'
                        : 'text-muted hover:text-text',
                    )}
                  >
                    {side}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          <Field
            label="Strike"
            hint={
              chain.status === 'live' && chain.spot != null ? `Spot ${chain.spot.toLocaleString('en-IN')}` : undefined
            }
          >
            {underlyingOnly ? (
              <p className="rounded-lg border border-border bg-bg px-2.5 py-2 text-[12px] text-muted">
                Watching {symbol} itself.
              </p>
            ) : chain.status === 'loading' ? (
              <p className="rounded-lg border border-border bg-bg px-2.5 py-2 text-[12px] text-muted">
                Loading the {formatExpiry(expiry)} chain…
              </p>
            ) : chain.status === 'unavailable' ? (
              <p className="rounded-lg border border-border bg-bg px-2.5 py-2 text-[12px] text-muted">
                No live chain for {symbol} {formatExpiry(expiry)} right now.
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <Select
                  value={strike ?? ''}
                  onChange={(v) => setStrike(v ? Number(v) : null)}
                  ariaLabel={`${optionType} strike`}
                >
                  {strike === null && <option value="">Select strike</option>}
                  {rows.map((r) => (
                    <option key={r.strike} value={r.strike}>
                      {strikeOptionLabel(r)}
                    </option>
                  ))}
                </Select>
                <span className="shrink-0 font-mono text-[12px] font-semibold text-text">{formatLtp(selectedLtp)}</span>
              </div>
            )}
          </Field>

          {hasOptions && (
            <label className="flex items-center gap-2 text-[11.5px] text-muted">
              <input
                type="checkbox"
                checked={underlyingOnly}
                onChange={(e) => setUnderlyingOnly(e.target.checked)}
                className="h-3.5 w-3.5 accent-teal"
              />
              Watch {symbol} itself instead of an option
            </label>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button size="sm" onClick={handleStart} disabled={!ready || busy}>
          {busy ? 'Starting…' : 'Start watching'}
        </Button>
        {strategy ? (
          <span className="min-w-0 text-[11.5px] text-muted">
            applying <span className="font-semibold text-text">{strategy.name}</span>
          </span>
        ) : (
          <span className="text-[11.5px] text-muted">Select a strategy first.</span>
        )}
        {strategy?.status === 'paused' && (
          <Badge tone="warning" className="px-1.5 py-0 text-[9px]">
            Paused — will not be evaluated
          </Badge>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-down bg-down-bg px-3 py-2 text-[11.5px] text-down">
          {error}
        </p>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</span>
        {hint && <span className="truncate text-[10.5px] text-faint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Select({
  value,
  onChange,
  disabled,
  ariaLabel,
  children,
}: {
  value: string | number;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative w-full">
      <select
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-lg border border-border bg-bg px-2.5 py-2 pr-8 font-mono text-[12.5px] text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
      >
        {children}
      </select>
      <ChevronDownIcon
        className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        aria-hidden="true"
      />
    </div>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your session has expired. Sign in again to start this watch.';
    if (err.status === 403) return 'This account does not have Sentinel Pro active.';
    if (err.status === 404) return 'That strategy no longer exists. Refresh and pick another.';
    return err.message || 'The watch could not be started.';
  }
  return 'The watch could not be started — the TradeW API could not be reached.';
}
