'use client';

import { cn } from '@tradew/ui';

export type PortfolioSection = 'overview' | 'holdings' | 'positions' | 'orders' | 'trade-history' | 'performance';

const SECTIONS: Array<{ id: PortfolioSection; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'holdings', label: 'Holdings' },
  { id: 'positions', label: 'Positions' },
  { id: 'orders', label: 'Orders' },
  { id: 'trade-history', label: 'Trade History' },
  { id: 'performance', label: 'Performance' },
];

/**
 * In-page left rail for the Portfolio workspace's six sections — deliberately
 * NOT a change to the shared app sidebar (components/shell/Sidebar.tsx),
 * which is a flat list with no nested-submenu support today. Restructuring
 * shared shell nav to match the reference screenshot's look would touch
 * every other page for a Portfolio-only need; this stays scoped to the
 * Portfolio route instead.
 */
export function PortfolioSubNav({ active, onChange }: { active: PortfolioSection; onChange: (s: PortfolioSection) => void }) {
  return (
    <nav aria-label="Portfolio sections" className="flex gap-1 overflow-x-auto lg:w-44 lg:shrink-0 lg:flex-col lg:overflow-visible">
      {SECTIONS.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onChange(s.id)}
          aria-current={active === s.id ? 'page' : undefined}
          className={cn(
            'shrink-0 rounded-lg px-3 py-2 text-left text-sm font-semibold transition-colors duration-micro',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
            active === s.id ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
          )}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}
