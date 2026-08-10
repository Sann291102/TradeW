import { AppFrame } from '@/components/shell/AppFrame';

/**
 * The workspace shell.
 *
 * AppFrame used to live in the ROOT layout and strip its own chrome by testing
 * `usePathname()` against a list of bare routes. That worked until the rendered
 * page and the router's pathname disagreed — which happens whenever Next
 * re-fetches an RSC payload for the current route and middleware redirects it.
 * The observed failure: signed out on `/profile`, the auth gate redirected the
 * payload to `/`, Next patched the LANDING PAGE into the tree while pathname
 * still read `/profile`, and AppFrame duly wrapped the marketing page in
 * workspace chrome — sidebar, ticker and all.
 *
 * A route group fixes that by construction. Layout is now a property of where
 * a file sits in the tree, not of a string compared at render time, so the two
 * cannot desync. `(workspace)` does not appear in any URL.
 *
 * Routes deliberately left OUTSIDE this group, and therefore chrome-free:
 *   /                 the landing page — the whole point of the fix
 *   /login /signup    redirects into /#auth
 *   /reset            reached from an email link by someone signed out; a
 *                     sidebar full of gated links is wrong for them
 *   /auth/callback    a transient OAuth landing strip
 *   /admin            renders its own AdminFrame (see nav-config
 *                     STANDALONE_ROUTES for why it must not get trader chrome)
 */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <AppFrame>{children}</AppFrame>;
}
