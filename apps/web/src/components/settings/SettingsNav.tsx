'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@tradew/ui';
import { SETTINGS_NAV } from './settings-nav';
import { DownloadIcon, TrashIcon } from '../shell/icons';

/**
 * The Settings rail.
 *
 * Responsive shape, since Settings has to be usable on a phone: below `lg` it
 * is a horizontal scroller of compact chips above the content; from `lg` up it
 * is the vertical list with hints from the reference design. One component
 * either way, so the two cannot drift.
 */
export function SettingsNav() {
  const pathname = usePathname();
  // Longest match wins so `/settings/legal/privacy-policy` highlights Legal
  // rather than lighting up nothing.
  const activeHref = SETTINGS_NAV.map((i) => i.href)
    .filter((href) => pathname === href || pathname.startsWith(href + '/'))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <div className="space-y-3">
      <nav aria-label="Settings sections" className="rounded-card border border-border bg-card p-1.5 shadow-card">
        <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
          {SETTINGS_NAV.map((item) => {
            const Icon = item.icon;
            const active = item.href === activeHref;
            return (
              <li key={item.href} className="shrink-0 lg:shrink">
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-3 py-2 transition-colors duration-micro',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    active ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
                  )}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block whitespace-nowrap text-xs font-bold lg:whitespace-normal">
                      {item.label}
                    </span>
                    {/* Hints would double the height of the mobile scroller for
                        no gain, so they appear only in the vertical rail. */}
                    <span className="hidden text-[11px] font-normal text-faint lg:block">{item.hint}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="hidden rounded-card border border-border bg-card p-3 shadow-card lg:block">
        <div className="mb-2 text-xs font-bold text-text">Quick actions</div>
        <ul className="space-y-0.5">
          <li>
            <Link
              href="/settings/privacy#data-export"
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-semibold text-muted transition-colors duration-micro hover:bg-hover hover:text-text"
            >
              <DownloadIcon className="h-4 w-4" aria-hidden="true" />
              Export data
            </Link>
          </li>
          <li>
            <Link
              href="/reports"
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-semibold text-muted transition-colors duration-micro hover:bg-hover hover:text-text"
            >
              <DownloadIcon className="h-4 w-4" aria-hidden="true" />
              Download reports
            </Link>
          </li>
          <li>
            <Link
              href="/settings/privacy#delete-account"
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-semibold text-down transition-colors duration-micro hover:bg-down-bg"
            >
              <TrashIcon className="h-4 w-4" aria-hidden="true" />
              Delete account
            </Link>
          </li>
        </ul>
      </div>
    </div>
  );
}
