import { SiteFooter } from '@/components/footer/SiteFooter';

/**
 * The public legal surface.
 *
 * Bare, like the landing page: no workspace chrome. `/legal/*` is reachable
 * signed out — it is added to `PUBLIC_PATHS` in middleware.ts, because a legal
 * page behind an auth wall is not a legal page — and a signed-out reader has no
 * sidebar to render.
 *
 * It owns its own scroll container for the same reason LandingPage does:
 * globals.css pins `body { overflow: hidden }` for the workspace shell, so a
 * route that does not use that shell has to provide the scroller itself or the
 * page simply cannot be scrolled.
 *
 * The footer is repeated here rather than lifted into the root layout. The root
 * layout wraps the workspace too, which is a fixed-height application shell with
 * its own dock and scroll model; a marketing footer inside it would either be
 * unreachable or would break that layout's contract.
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-screen overflow-y-auto overflow-x-hidden bg-bg text-text">
      <main>{children}</main>
      <SiteFooter />
    </div>
  );
}
