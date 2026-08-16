'use client';

import type { SentinelUnavailable } from '@/lib/sentinel/faults';

/**
 * The inline "Sentinel reconnecting…" strip.
 *
 * ── WHAT THIS REPLACED ─────────────────────────────────────────────────────
 *
 * A full-page card reading "Sentinel service not connected" that took the
 * whole workspace with it: no observation, no strategy composer, no saved
 * strategies, no watches. It rendered for the most common failure Sentinel
 * has — a 429 from the per-IP rate limiter on a fresh navigation — and it was
 * permanent, because nothing behind it ever retried. The state it described
 * had usually already ended by the time the user finished reading it.
 *
 * A transient fault gets a strip instead. Everything the user was doing stays
 * on screen and stays interactive; a retry is already running behind this;
 * when it lands, the strip disappears on its own. No reload is involved at any
 * point, which is the entire behavioural change.
 *
 * The full card still exists in `SentinelWorkspace` and is still correct — for
 * the cases where there is genuinely nothing to show, or where the fault is a
 * decision (not signed in, not entitled) that no amount of retrying will
 * change.
 */
export function SentinelConnectionBanner({
  fault,
  updatedAt,
}: {
  fault: SentinelUnavailable;
  /** When the data still on screen was received, for the staleness note. */
  updatedAt?: number | null;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-amber bg-amber-bg px-3.5 py-2.5"
    >
      <Spinner />
      <span className="text-[12.5px] font-semibold text-amber">Sentinel reconnecting…</span>
      <span className="text-[11.5px] text-muted">{reason(fault)}</span>
      {typeof updatedAt === 'number' && updatedAt > 0 && (
        <span className="ml-auto text-[11px] text-faint">
          Showing the last reading, from {agoLabel(updatedAt)}
        </span>
      )}
    </div>
  );
}

/**
 * Names the fault without alarming anyone about it. Rate limiting in
 * particular is worth saying out loud: it is the one case where the honest
 * answer is "you asked too fast", and it resolves by itself.
 */
function reason(fault: SentinelUnavailable): string {
  switch (fault.kind) {
    case 'api-unreachable':
      return 'The TradeW API is not answering. Retrying automatically.';
    case 'service-error':
      return fault.status === 429
        ? 'Rate limited — backing off and retrying automatically.'
        : `Sentinel answered HTTP ${fault.status}. Retrying automatically.`;
    // Neither of these reaches the banner (both are terminal by construction —
    // see the transient/terminal split in useSentinel). Handled anyway so the
    // switch stays exhaustive if that ever changes.
    case 'unauthenticated':
      return 'Your session needs to be re-established.';
    case 'entitlement-required':
      return 'This account is not currently entitled to Sentinel.';
  }
}

/** Relative age in the coarsest unit that is still true. */
function agoLabel(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'moments ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-amber"
    />
  );
}
