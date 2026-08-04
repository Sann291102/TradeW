import '@tradew/ui/styles.css';
import './globals.css';

export const metadata = {
  title: 'TradeW Admin — Operator Console',
  description: 'Internal ops/support/compliance console for the SentinelIntelligence engine and platform services.',
  // Never indexed — an internal operator console has no reason to appear in
  // search results, and accidentally leaking its existence is a cost with no
  // corresponding benefit.
  robots: { index: false, follow: false },
};

// Same no-FOUC pattern as apps/web's root layout, dark-first default.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('tradew-admin-theme')||'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
