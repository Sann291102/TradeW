'use client';

/**
 * Opens the exact trader-facing Sentinel workspace apps/web ships, in a new
 * tab, with the operator's own session in apps/web (separate sign-in — this
 * button does not smuggle the admin token into the trader app; the two apps
 * have entirely different auth boundaries by design).
 *
 * Deliberately a link, not a re-implementation. An admin console that grew
 * its own copy of the 3-panel chart/annotations UI would drift from what
 * apps/web actually renders the moment either one changed, and the whole
 * point of "view as trader" is reproducing what a trader reported — not an
 * admin's best guess at it.
 */
export function ViewAsTraderButton() {
  const webUrl = process.env.NEXT_PUBLIC_TRADEW_WEB_URL || 'http://localhost:3000';

  return (
    <a
      href={`${webUrl}/sentinel`}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-full rounded border border-accent/40 px-2.5 py-1.5 text-center text-[11.5px] font-medium text-accent transition-colors hover:bg-accent/10"
    >
      View as Trader ↗
    </a>
  );
}
