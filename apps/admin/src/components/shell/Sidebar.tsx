'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SCAFFOLDED_NAV, WORKING_NAV } from './nav-config';
import { SignOutButton } from './SignOutButton';
import { ViewAsTraderButton } from './ViewAsTrader';

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="border-b border-border px-4 py-4">
        <p className="text-[10px] font-medium uppercase tracking-wide text-faint">TradeW</p>
        <p className="text-[14px] font-bold text-text">Operator Console</p>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {/* The wired, working surfaces. */}
        {WORKING_NAV.map((item) => (
          <NavLink key={item.href} href={item.href} label={item.label} active={pathname === item.href} />
        ))}

        {/* Planned modules — scaffolded only. Labelled so a placeholder is never
            mistaken for a shipped feature. */}
        <p className="px-2.5 pb-1 pt-4 text-[9.5px] font-semibold uppercase tracking-wide text-faint">Planned</p>
        {SCAFFOLDED_NAV.map((item) => (
          <NavLink key={item.href} href={item.href} label={item.label} active={pathname === item.href} planned />
        ))}
      </nav>

      <div className="space-y-2 border-t border-border p-3">
        <ViewAsTraderButton />
        <SignOutButton />
      </div>
    </aside>
  );
}

function NavLink({ href, label, active, planned }: { href: string; label: string; active: boolean; planned?: boolean }) {
  return (
    <Link
      href={href}
      className={`flex items-center justify-between rounded px-2.5 py-1.5 text-[12.5px] transition-colors ${
        active ? 'bg-accent/15 font-semibold text-text' : 'text-muted hover:bg-accent/5 hover:text-text'
      }`}
    >
      <span>{label}</span>
      {/* An honest marker that the destination is a "Not built yet" placeholder,
          so discoverability does not imply the module is functional. */}
      {planned && <span className="ml-2 shrink-0 rounded bg-border/60 px-1 py-px text-[8.5px] uppercase tracking-wide text-faint">Soon</span>}
    </Link>
  );
}
