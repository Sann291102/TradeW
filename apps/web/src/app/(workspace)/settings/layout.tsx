import type { ReactNode } from 'react';
import { SettingsNav } from '@/components/settings/SettingsNav';

export const metadata = { title: 'Settings — TradeW' };

/**
 * The Settings centre's shell.
 *
 * Settings used to be one page holding an account form and the Sentinel price
 * list. It is now a parent area: this layout supplies the section rail, and
 * each concern is its own route so it can be linked, bookmarked and reasoned
 * about separately.
 *
 * The rail collapses to a horizontal chip scroller under `lg` (see
 * SettingsNav) — on a phone the sidebar is already a drawer, and a second
 * vertical nav inside the content would leave no room for the forms.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1200px] p-4">
      <header className="mb-4">
        <h1 className="text-2xl font-extrabold text-text">Settings</h1>
        <p className="mt-0.5 text-sm text-muted">
          Manage your account, preferences and application settings.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-2 lg:self-start">
          <SettingsNav />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
