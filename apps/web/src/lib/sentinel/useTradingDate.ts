'use client';

import { useEffect, useState } from 'react';
import { tradingDateIso } from '@tradew/types';

/**
 * How often the IST calendar date is re-read. A minute is far finer than the
 * thing being watched (a date boundary) and costs one string comparison per
 * tick, which is cheaper than the alternative — re-reading the clock during
 * render, which would make every consumer's output depend on when React
 * happened to re-render it.
 */
const TICK_MS = 60_000;

/**
 * The current IST trading date (`YYYY-MM-DD`), as reactive state.
 *
 * ── WHY A HOOK AND NOT `tradingDateIso()` AT THE CALL SITE ─────────────────
 *
 * "Has this expiry expired?" is a question whose answer changes on its own,
 * with no user action and no network response to hang a re-render off. Read
 * inline during render, the workspace only notices a rollover if something
 * ELSE happens to re-render it — so a page left open overnight kept offering
 * yesterday's contract until the trader reloaded, which is exactly what the
 * 2026-08-19 report asked to stop needing.
 *
 * Making the date a state value turns the rollover into a render, which flows
 * through `useExpiries` -> `resolveActiveExpiry` -> the canonical selection ->
 * the chain query -> the charts, with no refresh and no extra API traffic:
 * this hook talks to nothing but the clock.
 *
 * ── WHY IT ALMOST NEVER RENDERS ────────────────────────────────────────────
 *
 * `setDate` is called with the same string on all but one tick a day, and React
 * bails out of a re-render when a `useState` setter is given a value equal to
 * the current one. So the steady-state cost is a timer and a comparison — the
 * component re-renders once per IST midnight, which is the entire point.
 */
export function useTradingDate(): string {
  const [date, setDate] = useState(() => tradingDateIso());

  useEffect(() => {
    const sync = () => setDate(tradingDateIso());
    // Re-read on return to the tab as well as on the timer: background tabs get
    // their intervals throttled hard (and a sleeping machine runs none at all),
    // so a trader who reopens the laptop at 09:00 must not wait up to a minute
    // to be told the date changed while it was shut.
    const onVisible = () => {
      if (!document.hidden) sync();
    };
    const timer = setInterval(sync, TICK_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', sync);
    // The mount-time value came from the lazy initialiser, but the component may
    // have been server-rendered minutes ago; settle it once on the client.
    sync();
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', sync);
    };
  }, []);

  return date;
}
