// Design tokens first (defines the CSS vars), then app globals that consume them.
import '@tradew/ui/styles.css';
import './globals.css';
import { QueryProvider } from '@/components/providers/QueryProvider';

export const metadata = {
  title: 'TradeW — AI Trading Operating System',
  description: 'Institutional AI trading workspace. Observations only — never investment advice.',
};

// Runs before paint, before React hydrates — reads the persisted theme choice
// (Milestone 3 Theme Engine) straight from localStorage and applies it to
// <html> so there's no dark→light (or vice versa) flash on load. Static
// string, no interpolated data, so inlining it is safe (the standard
// next-themes-style no-FOUC pattern). Falls back to 'dark' (this app's
// default) if nothing is stored yet or JSON parsing fails for any reason.
const THEME_INIT_SCRIPT = `(function(){try{var r=localStorage.getItem('tradew-workspace-v1');var t='dark';if(r){var p=JSON.parse(r);if(p&&p.state&&p.state.theme)t=p.state.theme;}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Dark-first default (Genesis brief) via the static attribute below; the
  // inline script above overrides it pre-paint if a different theme was
  // persisted. suppressHydrationWarning on <html> is required for this exact
  // pattern — React would otherwise warn that the attribute it rendered
  // ('dark') doesn't match what the script may have already set in the DOM.
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      {/* No AppFrame here. The workspace shell lives in `(workspace)/layout.tsx`
          so that which routes get chrome is decided by the route tree rather
          than by a pathname compared at render time — see that file for the
          bug this prevents.

          QueryProvider IS here, and has to be: it owns the cache that has to
          outlive every client-side navigation. Mounted any deeper it would be
          remounted by the navigations it exists to survive. It wraps
          EVERYTHING, workspace and bare routes alike, so there is exactly one
          cache per tab. */}
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
