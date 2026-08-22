import type { ReactNode } from 'react';
import { Card } from '@tradew/ui';

/** Page header for one Settings subsection. Keeps every section's title,
 *  description and body spacing identical without each page re-deciding. */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <header>
        {/* h2, not h1: the Settings layout owns the page's single h1. */}
        <h2 className="text-xl font-bold text-text">{title}</h2>
        <p className="mt-0.5 max-w-2xl text-sm text-muted">{description}</p>
      </header>
      {children}
    </div>
  );
}

/** A titled group of `SettingRow`s. */
export function SettingsGroup({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card title={title} subtitle={subtitle} actions={actions} className={className}>
      {children}
    </Card>
  );
}
