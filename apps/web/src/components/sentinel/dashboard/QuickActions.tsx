'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Quick Actions — shortcuts into the other Sentinel/workspace surfaces. These
 * are real navigation links into existing routes, not dead buttons.
 */
const ACTIONS: { label: string; href: string; icon: ReactNode; tone: string }[] = [
  { label: 'Add Journal Entry', href: '/discipline', tone: 'bg-teal-bg text-teal', icon: <JournalIcon /> },
  { label: 'View Strategies', href: '/learning/strategies', tone: 'bg-up-bg text-up', icon: <StratIcon /> },
  { label: 'Learning Hub', href: '/learning', tone: 'bg-amber-bg text-amber', icon: <LearnIcon /> },
  { label: 'Market Close Review', href: '/sentinel?view=close', tone: 'bg-down-bg text-down', icon: <ReviewIcon /> },
];

export function QuickActions() {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <h2 className="mb-3 text-[13px] font-bold text-text">Quick Actions</h2>
      <div className="grid grid-cols-2 gap-2.5">
        {ACTIONS.map((a) => (
          <Link
            key={a.label}
            href={a.href}
            className="flex items-center gap-2.5 rounded-xl border border-border bg-bg p-3 transition-colors hover:bg-hover"
          >
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${a.tone}`}>{a.icon}</span>
            <span className="text-[12px] font-semibold text-text">{a.label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

const ic = { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
function JournalIcon() { return (<svg {...ic}><path d="M5 3h7l3 3v11H5V3Z" /><path d="M11 3v4h4M7.5 11h5M7.5 14h5" /></svg>); }
function StratIcon() { return (<svg {...ic}><rect x="3" y="3" width="14" height="14" rx="2" /><path d="M6.5 12l2.5-2.5 2 2 3-3.5" /></svg>); }
function LearnIcon() { return (<svg {...ic}><path d="M10 3 2.5 6.5 10 10l7.5-3.5L10 3Z" /><path d="M5 8.5v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4" /></svg>); }
function ReviewIcon() { return (<svg {...ic}><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 1.5" /></svg>); }
