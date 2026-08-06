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
    <nav aria-label="Portfolio sections" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card p-1.5 border border-border/80">
      <div className="flex items-center gap-1 overflow-x-auto">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(s.id)}
            aria-current={active === s.id ? 'page' : undefined}
            className={cn(
              'shrink-0 rounded-md px-3.5 py-1.5 text-xs font-bold transition-colors duration-micro',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              active === s.id ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 pr-1">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-border2 bg-bg px-2.5 py-1.5 text-xs font-semibold text-text hover:bg-hover transition-colors"
        >
          <span className="text-faint">📥</span>
          <span>Download Report</span>
        </button>
      </div>
    </nav>
  );
}
