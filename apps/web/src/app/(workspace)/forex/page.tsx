import { redirect } from 'next/navigation';

/**
 * Forex is a venue on the Markets workspace, not a page of its own — see the
 * note in the sibling `crypto/page.tsx` for the reasoning and for why this
 * route redirects instead of being removed.
 *
 * The board itself is unchanged: real interbank spot from Twelve Data, still
 * read-only. It is now a tab on /markets under the $ side of the currency
 * switch, and `ForexClient.tsx` next to this file is untouched.
 */
export default function ForexPage() {
  redirect('/markets?cat=forex');
}
