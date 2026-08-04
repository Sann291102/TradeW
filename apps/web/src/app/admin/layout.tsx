import type { Metadata } from 'next';
import './admin.css';
import { AdminFrame } from './AdminFrame';

/**
 * The admin portal's own layout.
 *
 * `/admin` is listed in `STANDALONE_ROUTES`, so the root `AppFrame` renders
 * these routes bare and this layout supplies all of the chrome. The portal has
 * no Sidebar into the product, no Ticker, no FloatingAI and no discipline
 * panel — it is a different application that happens to share a deployment.
 *
 * `noindex, nofollow, noarchive` is belt-and-braces. The real protection is
 * server-side (`AdminGuard` rejects every request without both factors), and a
 * meta tag protects nothing on its own — but there is no reason for this
 * surface to appear in a search index if a crawler ever reaches the HTML.
 */
export const metadata: Metadata = {
  title: 'TradeW Admin',
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminFrame>{children}</AdminFrame>;
}
