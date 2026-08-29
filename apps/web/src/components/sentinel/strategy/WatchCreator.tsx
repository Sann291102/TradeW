'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, cn } from '@tradew/ui';
import { ApiError } from '@/lib/api';
import { MarketSelector } from '@/components/sentinel/MarketSelector';
import { useSentinelWatch } from '@/lib/sentinel/WatchContext';
import { formatExpiry } from '@/lib/sentinel/watchModel';
import { buildWatchRequest, validateWatchPair } from '@/lib/sentinel/watchState';
import { StrikeCombobox } from './StrikeCombobox';
import type { CreateWatchInput, UserStrategy, WatchSession } from '@/lib/sentinel/strategyApi';
import { ChevronDownIcon } from '@/components/shell/icons';

/**
 * Apply a saved strategy to something: market → expiry → CE/PE → strike →
 * "Start watching".
 *
 * The pickers are the existing live Dhan bridge, not a new data path — the
 * same expiry list and option chain the charts read. The one addition is that
 * the expiry is CHOSEN here rather than resolved to the nearest, because a
 * watch may deliberately be on a later series.
 *
 * A symbol with no options market is not a dead end: the underlying itself can
 * be watched, which is what `strike`/`optionType`/`expiry` being nullable in
 * the API is for.
 *
 * ── THIS IS THE SOURCE OF TRUTH FOR THE WHOLE WORKSPACE ────────────────────
 *
 * Every control here writes the canonical `WatchSelection`
 * (`lib/sentinel/WatchContext.tsx`) rather than local state, so choosing a
 * market, expiry, side or strike moves the three charts, `/observe`, the
 * Strategy Feed and the toolbar readout together. It previously held its own
 * private copy of all four behind its own `MarketSelector`, which is why this
 * section and the (now removed) toolbar controls could sit on different markets
 * at the same time.
 *
 * `chain` and `expiries` are read from the same context: they are ONE poll for
 * the page. Do not re-add a local `useOptionChainStrikes` here — three
 * concurrent 4s polls of a bridge that serialises option calls behind a 3.1s
 * floor is what this replaced.
 *
 * ── THREE INSTRUMENTS, ONE ROW ─────────────────────────────────────────────
 *
 * Until 2026-08-18 this form had ONE strike dropdown and the CE/PE toggle
 * decided which leg it edited — so the toggle silently decided which single leg
 * reached the engine. Both legs have been configured and sent since then.
 *
 * What changed on 2026-08-29 is the SHAPE, and the shape was making a claim
 * about the architecture that was not true. The two legs lived in large cards
 * under a heading called "Option pair under observation", below the market
 * dropdown, which read as "pick your contracts; the index is a setting". The
 * index is not a setting. It is the market instrument — the series the engine
 * takes its directional context from (`app/watch/direction.py`) — and the two
 * contracts are the tradable expressions of its move.
 *
 * So the three are now one row of three identical dropdowns:
 *
 *     WATCH  [ NIFTY Nifty 50 ▾ ]  [ 24200 CE ▾ ]  [ 24200 PE ▾ ]
 *
 * and "Start watching" starts watching all three. Nothing was removed to get
 * there: the ladders are still separate, the tokens are still resolved and
 * checked per leg, the per-leg problems are still named per leg, and the
 * underlying-only escape hatch is still here.
 *
 * ── WHAT THE TOGGLE MEANS, AND WHAT IT CANNOT DO ───────────────────────────
 *
 * FOCUS: which leg the strategy's rules are evaluated against, and which one
 * the workspace emphasises. It creates and destroys nothing, it cannot lose a
 * strike, and it cannot take a contract out of the watch — the request carries
 * both legs whichever way it is set, and `router.py::_validate_pair` refuses a
 * half-configured pair outright.
 *
 * It is also NOT an input to market direction. The index decides that, and it
 * decides it identically whichever side the operator has in focus.
 *
 * ⚠️ Note what this form still deliberately does NOT do: it does not rank the
 * two legs, order them by attractiveness, or score strikes against each other.
 * Which leg is ALIGNED with the index's move is arithmetic on the index and is
 * stated by the engine in the past tense; which strike is the better trade is a
 * recommendation however it is worded, and per Rule 2 nothing here produces
 * one.
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
  const {
    selection,
    expiries,
    chain,
    legs,
    ladders,
    setMarket,
    setExpiry,
    setSide,
    setCallStrike,
    setPutStrike,
    setUnderlying,
  } = useSentinelWatch();

  const { symbol, expiry, focusedSide, underlyingOnly } = selection;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasOptions = expiries.status === 'ready';

  // Clearing the market/expiry/strike on a market change, defaulting the
  // nearest expiry, forcing the underlying on a CONFIRMED 'none' and defaulting
  // the ATM strike all moved into the provider — they are facts about the
  // canonical selection, not about this form, and the charts need them applied
  // whether or not this form is on screen. The 2026-08-17 rule survives the
  // move intact: only a confirmed absence of options forces the underlying, an
  // unreadable list never does.
  //
  // What stays local is this form's own transient state: the submit error.
  useEffect(() => {
    setError(null);
  }, [symbol]);

  // ── WHAT COUNTS AS "WATCHING THE UNDERLYING" ──────────────────────────────
  //
  // This was `underlyingOnly || !hasOptions`, and `hasOptions` is false for
  // 'loading' and 'unreadable' as well as 'none'. So while the expiry list was
  // still in flight — or had failed — the form considered itself to be watching
  // the underlying and enabled "Start watching". A click in that window created a
  // watch on the index instead of the option the user was choosing, with nothing
  // on screen having said so.
  //
  // Only a CONFIRMED 'none', or the user explicitly ticking the box, means the
  // underlying. Loading and unreadable are simply not-ready.
  const watchingUnderlying = underlyingOnly || expiries.status === 'none';

  /**
   * Everything blocking the watch, per leg, recomputed on every render.
   *
   * `Date.now()` is read here rather than held in state on purpose: the chain's
   * staleness has to be judged at the moment of the click, and a memoised
   * timestamp would let a form that was valid thirty seconds ago stay valid.
   * The cost is one comparison per render.
   */
  const problems = validateWatchPair(
    { ...selection, underlyingOnly: watchingUnderlying },
    ladders,
    Date.now(),
    new Date().toISOString().slice(0, 10),
  );
  const problemFor = (side: 'CE' | 'PE') => problems.filter((p) => p.side === side);
  const pairProblems = problems.filter((p) => p.side === null);

  const ready = strategy !== null && problems.length === 0;

  /**
   * The timeframe the engine will read, taken from the strategy's own parsed
   * rules — not a control on this form. Mirrors `_timeframe_of` in
   * `services/sentinel-py/app/watch/poller.py`, including its 15m default, so
   * the value sent is the value the sweep would have chosen anyway rather than
   * a second opinion the two services could drift apart on.
   */
  const timeframe = strategy?.rules?.timeframe || '15m';

  const handleStart = async () => {
    if (!strategy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      /**
       * ONE builder, from the canonical selection. The form does not assemble
       * a payload of its own — that is how the old single-`strike` body came to
       * disagree with the pair the charts were drawing.
       */
      const created = await onStart(
        buildWatchRequest({ ...selection, underlyingOnly: watchingUnderlying }, strategy.id, timeframe),
      );
      onStarted?.(created);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * The two strike dropdowns are live only when there is a real ladder behind
   * them. `chain.ce`/`chain.pe` are passed straight through — never merged,
   * never a single array with a side flag — so a control handed the call
   * ladder has nothing to select a put from.
   */
  const chainLive = chain.status === 'live';
  const legsDisabled = watchingUnderlying || !hasOptions || expiry === null || !chainLive;

  return (
    <div className="space-y-3">
      {/*
        ── THE WATCH ROW: market, call, put ──────────────────────────────────

        Three dropdowns of the same kind, in one line, because they are three
        instruments of one watch rather than a market plus its settings. The
        index is first because it is the market — the series direction is read
        from — and the two contracts follow it.
      */}
      <div className="flex flex-wrap items-start gap-2">
        <span className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-faint">Watch</span>
        <MarketSelector value={symbol} onChange={setMarket} />
        {!watchingUnderlying && expiries.status !== 'unreadable' && (
          <>
            <div className="min-w-[168px] flex-1">
              <StrikeCombobox
                side="CE"
                rows={chainLive ? chain.ce : []}
                atmIndex={chain.atmIndex}
                value={selection.callStrike}
                onChange={setCallStrike}
                disabled={legsDisabled}
                instrumentStatus={legs.ce.status}
                instrument={selection.callInstrument}
                focused={focusedSide === 'CE'}
              />
            </div>
            <div className="min-w-[168px] flex-1">
              <StrikeCombobox
                side="PE"
                rows={chainLive ? chain.pe : []}
                atmIndex={chain.atmIndex}
                value={selection.putStrike}
                onChange={setPutStrike}
                disabled={legsDisabled}
                instrumentStatus={legs.pe.status}
                instrument={selection.putInstrument}
                focused={focusedSide === 'PE'}
              />
            </div>
          </>
        )}
      </div>

      {/*
        What "Start watching" will actually do, said outright. The old layout
        left it to be inferred from two cards under a heading, and the thing
        most worth inferring — that the index is the directional instrument and
        the contracts are read against it — was not on the screen at all.
      */}
      {!watchingUnderlying && expiries.status !== 'unreadable' && (
        <p className="text-[11px] leading-relaxed text-muted">
          All three are watched together. <span className="font-semibold text-text">{symbol}</span> is the market
          instrument — the series the engine reads direction from — and the CE and PE contracts are the tradable legs
          read against it.
          {chain.status === 'live' && chain.spot != null && (
            <span className="text-faint"> Spot {chain.spot.toLocaleString('en-IN')}.</span>
          )}
        </p>
      )}

      {expiries.status === 'loading' && <p className="text-[11px] text-faint">checking expiries…</p>}

      {expiries.status === 'unreadable' ? (
        // NOT "this symbol has no option chain". The list could not be read, and
        // saying otherwise is what produced the self-contradicting message in the
        // 2026-08-17 screenshots — "NIFTY has no live option chain… Indices like
        // NIFTY … have one" — while the actual fault was a refused credential on
        // the market-data bridge. See `useExpiries`' ExpiryStatus docstring.
        <p
          role="status"
          className="rounded-lg border border-warning bg-warning-bg px-3 py-2 text-[11.5px] leading-relaxed text-warning"
        >
          The option chain for {symbol} could not be read, so its expiries and strikes are unavailable right now.{' '}
          {expiries.unreadableReason} This is a feed fault, not a statement about {symbol}.
          <label className="mt-2 flex items-center gap-2 text-warning">
            <input
              type="checkbox"
              checked={underlyingOnly}
              onChange={(e) => setUnderlying(e.target.checked)}
              className="h-3.5 w-3.5 accent-teal"
            />
            Watch {symbol} itself instead of an option
          </label>
        </p>
      ) : expiries.status === 'none' ? (
        <p className="rounded-lg border border-border bg-bg px-3 py-2 text-[11.5px] leading-relaxed text-muted">
          {symbol} has no live option chain, so this watch will follow the underlying itself. Indices like NIFTY,
          BANKNIFTY, FINNIFTY and SENSEX have one.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Expiry" hint="applies to both contracts">
              <Select
                value={expiry ?? ''}
                // No second strike reset here: `selectExpiry` already drops
                // BOTH legs and both their tokens, because the 24200 of one
                // series is a different contract from the 24200 of the next.
                // One rule, one place.
                onChange={(v) => setExpiry(v || null)}
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

            <Field label="Side in focus" hint="both legs stay watched">
              <div
                className="flex rounded-lg border border-border bg-bg p-0.5"
                role="group"
                aria-label="Side in focus"
              >
                {(['CE', 'PE'] as const).map((side) => (
                  <button
                    key={side}
                    type="button"
                    aria-pressed={focusedSide === side}
                    disabled={underlyingOnly}
                    onClick={() => setSide(side)}
                    className={cn(
                      'flex-1 rounded-md py-1.5 text-[12px] font-bold transition-colors duration-micro disabled:opacity-50',
                      focusedSide === side
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

          {/*
            Why the strike dropdowns are inert, when they are. Each state is its
            own sentence: "the chain is loading" and "there is no chain" have
            different fixes, and one combined "unavailable" would hide which.
          */}
          {!watchingUnderlying && expiry === null ? (
            <p className="text-[11.5px] text-muted">Choose an expiry to load the {symbol} strike ladders.</p>
          ) : !watchingUnderlying && chain.status === 'loading' ? (
            <p className="text-[11.5px] text-muted">Loading the {formatExpiry(expiry)} chain…</p>
          ) : !watchingUnderlying && chain.status === 'unavailable' ? (
            <p className="text-[11.5px] text-muted">
              No live chain for {symbol} {formatExpiry(expiry)} right now.
            </p>
          ) : null}

          {watchingUnderlying && (
            <p className="rounded-lg border border-border bg-bg px-2.5 py-2 text-[12px] text-muted">
              Watching {symbol} itself — no option legs are part of this watch.
            </p>
          )}

          {/*
            Why each leg is blocking, named per leg. A single "invalid
            selection" would leave the operator to work out which of the two
            is at fault and in what way.
          */}
          {!watchingUnderlying && problems.length > 0 && (
            <ul className="space-y-1">
              {[...pairProblems, ...problemFor('CE'), ...problemFor('PE')].map((p) => (
                <li key={`${p.code}:${p.side ?? 'pair'}`} className="text-[11px] leading-snug text-warning">
                  {p.side ? `${p.side}: ` : ''}
                  {p.message}
                </li>
              ))}
            </ul>
          )}

          {hasOptions && (
            <label className="flex items-center gap-2 text-[11.5px] text-muted">
              <input
                type="checkbox"
                checked={underlyingOnly}
                onChange={(e) => setUnderlying(e.target.checked)}
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
