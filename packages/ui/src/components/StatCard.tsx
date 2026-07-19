import { type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  value: ReactNode;
  /** Optional delta string (e.g. "+1.24%"). Tone auto-derived from sign unless `deltaTone` is set. */
  delta?: string;
  /** Force the delta color; otherwise inferred from a leading +/- in `delta`. */
  deltaTone?: 'up' | 'down' | 'neutral';
  icon?: ReactNode;
}

function inferTone(delta?: string): 'up' | 'down' | 'neutral' {
  if (!delta) return 'neutral';
  if (delta.trim().startsWith('-') || delta.trim().startsWith('▼')) return 'down';
  if (delta.trim().startsWith('+') || delta.trim().startsWith('▲')) return 'up';
  return 'neutral';
}

const toneClass: Record<'up' | 'down' | 'neutral', string> = {
  up: 'text-up',
  down: 'text-down',
  neutral: 'text-muted',
};

/**
 * StatCard — icon + label + large value + colored delta (DESIGN-SYSTEM.md §4).
 * The value renders in the mono/tabular face so digit columns align, per the
 * trading-terminal typography rule. Delta color is market-direction only.
 */
export function StatCard({ label, value, delta, deltaTone, icon, className, ...props }: StatCardProps) {
  const tone = deltaTone ?? inferTone(delta);
  return (
    <div
      className={cn(
        'bg-card border border-border rounded-card px-4 py-3 shadow-card',
        'flex flex-col gap-1',
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2 text-faint">
        {icon && <span className="shrink-0 text-teal">{icon}</span>}
        <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <div className="font-mono text-xl font-bold tabular-nums text-text">{value}</div>
      {delta != null && (
        <div className={cn('font-mono text-xs font-semibold tabular-nums', toneClass[tone])}>{delta}</div>
      )}
    </div>
  );
}
