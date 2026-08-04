'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ADMIN_NAV } from './nav-config';
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
        <NavLink href="/" label="Dashboard" active={pathname === '/'} />
        {ADMIN_NAV.map((item) => (
          <NavLink key={item.href} href={item.href} label={item.label} active={pathname === item.href} />
        ))}
      </nav>

      <div className="space-y-2 border-t border-border p-3">
        <ViewAsTraderButton />
        <SignOutButton />
      </div>
    </aside>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`block rounded px-2.5 py-1.5 text-[12.5px] transition-colors ${
        active ? 'bg-accent/15 font-semibold text-text' : 'text-muted hover:bg-accent/5 hover:text-text'
      }`}
    >
      {label}
    </Link>
  );
}
