import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, Card, buttonClasses, cn } from '@tradew/ui';

export interface NotBuiltYetProps {
  title: string;
  /** One sentence on what this area is for, in the product's own words. */
  intent: string;
  /**
   * The honest status line. Say what does NOT exist, plainly — this component
   * is the alternative to seeding a page with plausible-looking data, and it
   * only works if it is specific.
   */
  status: ReactNode;
  /** What the area will cover once there is something behind it. */
  planned: string[];
  /** Real, working places to go instead. Never links to another empty shell. */
  insteadTitle?: string;
  instead?: Array<{ href: string; label: string; hint: string }>;
}

/**
 * The shell for a navigable product area that has no implementation yet.
 *
 * TradeW's nav now names areas the repository does not implement — Community
 * has no backend, and there is no backtesting engine anywhere in it. There
 * were two honest options: leave them out of the nav, or put them in and say
 * so. This is the second, and the entire point of it is the `status` line:
 * a page that renders sample posts, a fake equity curve or a seeded report
 * catalogue would look finished and teach a user something untrue about what
 * their account can do.
 *
 * If you are about to add mock data to a page that renders this, don't —
 * implement the feature, or leave the shell alone.
 */
export function NotBuiltYet({ title, intent, status, planned, insteadTitle = 'What works today', instead }: NotBuiltYetProps) {
  return (
    <div className="mx-auto max-w-[900px] space-y-4 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold text-text">{title}</h1>
        <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
          NOT BUILT YET
        </Badge>
      </header>
      <p className="max-w-2xl text-sm text-muted">{intent}</p>

      <Card className="border-amber bg-amber-bg">
        <div className="text-sm font-semibold text-text">Status</div>
        <div className="mt-1 text-xs leading-relaxed text-muted">{status}</div>
      </Card>

      <Card title="What this area will cover">
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {planned.map((item) => (
            <li key={item} className="flex items-start gap-2 text-xs text-muted">
              <span aria-hidden="true" className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-border2" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </Card>

      {instead && instead.length > 0 && (
        <Card title={insteadTitle}>
          <ul className="grid gap-2 sm:grid-cols-2">
            {instead.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={cn(
                    'flex flex-col gap-0.5 rounded-lg border border-border p-3',
                    'transition-colors duration-micro hover:border-teal hover:bg-hover',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                  )}
                >
                  <span className="text-xs font-bold text-text">{link.label}</span>
                  <span className="text-[11px] text-muted">{link.hint}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="text-[11px] text-faint">
        Nothing on this page is sample data — there is no data here to sample. When this area is
        built it will read from the same account and the same services the rest of TradeW does.
      </p>
      <div>
        <Link href="/dashboard" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
          Back to Home
        </Link>
      </div>
    </div>
  );
}
