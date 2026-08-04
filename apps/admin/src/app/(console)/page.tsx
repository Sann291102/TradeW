import Link from 'next/link';
import { ADMIN_NAV } from '@/components/shell/nav-config';

export default function DashboardPage() {
  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-lg font-bold text-text">Operator Console</h1>
        <p className="text-[12.5px] text-muted">
          SentinelIntelligence engine operations, knowledge management, and platform observability.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ADMIN_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent/40"
          >
            <p className="text-[13px] font-semibold text-text">{item.label}</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{item.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
