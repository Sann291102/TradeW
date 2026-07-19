import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/**
 * EmptyState — the canonical `.empty` treatment, promoted to a component so
 * every "no data yet" surface reads consistently. Not an error state; purely
 * "nothing here yet".
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 py-10 text-center text-muted',
        className,
      )}
    >
      {icon && <div className="text-faint">{icon}</div>}
      <div className="text-sm font-semibold text-text">{title}</div>
      {description && <div className="max-w-sm text-xs text-muted">{description}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
