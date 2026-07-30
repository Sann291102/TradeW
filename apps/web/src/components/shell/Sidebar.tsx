'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { cn, Badge } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { useSessionStore } from '@/lib/store/sessionStore';
import { initials } from '@/lib/format';
import { NAV_ITEMS, type NavItem } from './nav-config';
import { ChevronIcon } from './icons';

function NavLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        title={collapsed ? item.label : undefined}
        className={cn(
          'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold',
          'transition-colors duration-micro ease-standard',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
          active ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
        )}
      >
        {/* active indicator rail */}
        <span
          aria-hidden="true"
          className={cn(
            'absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-teal transition-opacity duration-micro',
            active ? 'opacity-100' : 'opacity-0',
          )}
        />
        <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
        {!collapsed && <span className="truncate">{item.label}</span>}
        {!collapsed && item.premium && (
          <Badge tone="warning" className="ml-auto px-1.5 py-0 text-[9px]">
            PRO
          </Badge>
        )}
        {!collapsed && item.comingSoon && (
          <Badge tone="neutral" className="ml-auto px-1.5 py-0 text-[9px]">
            SOON
          </Badge>
        )}
      </Link>
    </li>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const collapsed = useWorkspaceStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar);
  const mobileOpen = useWorkspaceStore((s) => s.mobileNavOpen);
  const setMobileNavOpen = useWorkspaceStore((s) => s.setMobileNavOpen);
  const onNavigate = () => setMobileNavOpen(false);
  const width = collapsed ? 72 : 240;

  const sessionStatus = useSessionStore((s) => s.status);
  const sessionUser = useSessionStore((s) => s.user);

  const primary = NAV_ITEMS.filter((i) => i.group === 'primary');
  const secondary = NAV_ITEMS.filter((i) => i.group === 'secondary');
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  return (
    <motion.aside
      aria-label="Primary navigation"
      initial={false}
      animate={{ width }}
      transition={reduce ? { duration: 0 } : { duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      className={cn(
        'z-40 flex h-full shrink-0 flex-col border-r border-border bg-card',
        // desktop: static rail; mobile: fixed drawer
        'max-lg:fixed max-lg:inset-y-0 max-lg:left-0',
        mobileOpen ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full',
        'max-lg:!w-[240px] max-lg:shadow-card max-lg:transition-transform max-lg:duration-panel',
      )}
      style={{ width }}
    >
      {/* brand — clicking the wordmark always returns to the Market Workspace landing page */}
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <Link href="/dashboard" className="text-lg font-extrabold text-navy transition-opacity hover:opacity-80">
          Trade<span className="text-teal">W</span>
        </Link>
        {!collapsed && (
          <Badge tone="warning" className="px-1.5 py-0 text-[9px]">
            PAPER
          </Badge>
        )}
      </div>

      {/* nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <ul className="space-y-0.5">
          {primary.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </ul>
        <div className="my-2 border-t border-border" />
        <ul className="space-y-0.5">
          {secondary.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </ul>
      </nav>

      {/* user + collapse toggle — real session (Milestone 4, Step 1), not a static placeholder */}
      <div className="shrink-0 border-t border-border p-2">
        {sessionStatus === 'authenticated' && sessionUser ? (
          <Link
            href="/profile"
            className={cn(
              'flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors duration-micro hover:bg-hover',
              collapsed && 'justify-center',
            )}
            title={sessionUser.email}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal text-xs font-bold text-white">
              {initials(sessionUser.email)}
            </span>
            {!collapsed && (
              <div className="min-w-0">
                <div className="truncate text-xs font-bold text-text">{sessionUser.email}</div>
                <div className="truncate text-[10px] text-faint">Paper trading account</div>
              </div>
            )}
          </Link>
        ) : sessionStatus === 'loading' || sessionStatus === 'idle' ? (
          <div className={cn('flex items-center gap-2 px-2 py-1.5', collapsed && 'justify-center')}>
            <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-border2" />
            {!collapsed && <span className="h-3 w-20 animate-pulse rounded bg-border2" />}
          </div>
        ) : (
          <Link
            href="/login"
            className={cn(
              'flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors duration-micro hover:bg-hover',
              collapsed && 'justify-center',
            )}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border2 text-xs font-bold text-faint">
              ?
            </span>
            {!collapsed && (
              <div className="min-w-0">
                <div className="truncate text-xs font-bold text-text">Guest</div>
                <div className="truncate text-[10px] text-teal">Sign in →</div>
              </div>
            )}
          </Link>
        )}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          className={cn(
            'mt-1 hidden w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-muted lg:flex',
            'transition-colors duration-micro hover:bg-hover hover:text-text',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
            collapsed && 'justify-center',
          )}
        >
          <ChevronIcon className={cn('h-4 w-4 transition-transform duration-panel', !collapsed && 'rotate-180')} aria-hidden="true" />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </motion.aside>
  );
}
