'use client';

import { Card, EmptyState, Badge } from '@tradew/ui';
import { BellIcon } from '@/components/shell/icons';
import { useWorkspaceStore, NOTIFICATION_CATEGORY_TONE } from '@/lib/store/workspaceStore';

/**
 * Reads the SAME store-seeded list the top-bar bell badge and the
 * NotificationCenter drawer use (Milestone 3 §10: one notification
 * architecture, not three copies of mock data). Real alerts (Sentinel
 * fanout, order fills) wire via services/notification later
 * (N8N-WORKFLOWS.md) — this page/store already has the right shape for that.
 *
 * Split from page.tsx because a Client Component (needed for the store hook)
 * can't export `metadata` — page.tsx stays a Server Component for that.
 */
export function NotificationsClient() {
  const notifications = useWorkspaceStore((s) => s.notifications);
  const markRead = useWorkspaceStore((s) => s.markNotificationRead);
  const markAllRead = useWorkspaceStore((s) => s.markAllNotificationsRead);
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="mx-auto max-w-[720px] space-y-4 p-4">
      <Card
        title="Notifications"
        actions={
          <button
            type="button"
            onClick={markAllRead}
            disabled={unread === 0}
            className="text-[11px] font-semibold text-teal hover:underline disabled:pointer-events-none disabled:text-faint disabled:no-underline"
          >
            Mark all read
          </button>
        }
      >
        {notifications.length === 0 ? (
          <EmptyState icon={<BellIcon className="h-6 w-6" />} title="You're all caught up" />
        ) : (
          <ul className="divide-y divide-border">
            {notifications.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => markRead(n.id)}
                  className="flex w-full items-start gap-3 py-3 text-left transition-colors duration-micro hover:bg-hover"
                >
                  <Badge tone={NOTIFICATION_CATEGORY_TONE[n.category]} className="mt-0.5 shrink-0 px-1.5 py-0 text-[9px]">
                    {n.category.toUpperCase()}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-text">
                      {!n.read && <span aria-hidden className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-teal" />}
                      {n.title}
                    </p>
                    <p className="text-xs text-muted">{n.body}</p>
                    <span className="text-[11px] text-faint">{n.time}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
