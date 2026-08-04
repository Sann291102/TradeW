'use client';

import { useEffect, useState } from 'react';
import { Card, EmptyState, Badge, Button, Skeleton } from '@tradew/ui';
import { BellIcon } from '@/components/shell/icons';
import { NOTIFICATION_CATEGORY_TONE } from '@/lib/store/workspaceStore';
import { fetchNotifications, markNotificationRead, markAllNotificationsRead, type NotificationItem } from '@/lib/notifications';

/**
 * Full /notifications page — fetches from the real API (services/api /notifications/*).
 * The top-bar NotificationCenter drawer still reads from workspaceStore (seeded mock)
 * for now; that drawer is a preview and will be synced in a later milestone when
 * services/notification fanout is live (N8N-WORKFLOWS.md).
 */
export function NotificationsClient() {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchNotifications(100);
      setNotifications(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const unread = notifications.filter((n) => !n.read).length;

  async function handleMarkRead(id: string) {
    try {
      await markNotificationRead(id);
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    } catch {
      // optimistic UI — if it fails, the next load will sync
    }
  }

  async function handleMarkAllRead() {
    if (unread === 0) return;
    try {
      await markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch {
      // optimistic UI — if it fails, the next load will sync
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-[720px] space-y-4 p-4">
        <Card title="Notifications">
          <div className="space-y-3 py-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-[720px] space-y-4 p-4">
        <Card title="Notifications">
          <div className="text-center py-8 text-red-400">{error}</div>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[720px] space-y-4 p-4">
      <Card
        title="Notifications"
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={handleMarkAllRead}
            disabled={unread === 0}
          >
            Mark all read
          </Button>
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
                  onClick={() => handleMarkRead(n.id)}
                  className="flex w-full items-start gap-3 py-3 text-left transition-colors duration-micro hover:bg-hover"
                >
                  <Badge
                    tone={NOTIFICATION_CATEGORY_TONE[n.category]}
                    className="mt-0.5 shrink-0 px-1.5 py-0 text-[9px]"
                  >
                    {n.category.toUpperCase()}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-text">
                      {!n.read && (
                        <span aria-hidden className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-teal" />
                      )}
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