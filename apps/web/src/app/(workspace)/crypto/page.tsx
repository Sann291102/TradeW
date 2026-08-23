import { redirect } from 'next/navigation';

/**
 * Crypto is a venue on the Markets workspace, not a page of its own.
 *
 * It used to render `CryptoClient` here, reached from a dedicated sidebar
 * entry. Crypto is a market venue in exactly the way Indices and Commodities
 * are, so it moved into /markets under the ₹/$ currency switch (see
 * `components/markets/ExternalBoards.tsx`).
 *
 * This route is kept and redirects rather than being deleted: it is a public
 * URL that has been linked and bookmarked, the TradeW assistant's route list
 * still contains it, and repo Rule 1 is never-delete. `CryptoClient.tsx` next
 * to this file is likewise untouched and still renders correctly if mounted —
 * it is simply no longer what this route serves.
 */
export default function CryptoPage() {
  redirect('/markets?cat=crypto');
}
