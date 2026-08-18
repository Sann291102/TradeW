'use client';

import { Card, EmptyState, Badge, Button, Skeleton } from '@tradew/ui';
import { BellIcon } from '@/components/shell/icons';
import { NOTIFICATION_CATEGORY_TONE } from '@/lib/store/workspaceStore';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '@/lib/query/useNotifications';
import { alertRMultiple, alertTier } from '@/lib/sentinel/alertTier';
import { formatRMultiple } from '@/lib/sentinel/watchModel';

/**
 * Full /notifications page — fetches from the real API (services/api
 * /notifications/*). The top-bar NotificationCenter drawer renders the same
 * rows from the workspace store, which `NotificationSync` keeps in step with
 * the same endpoint, so the two are one list shown twice rather than two
 * sources. Both style Sentinel alerts through `lib/sentinel/alertTier.ts`.
 *
 * As of the caching pass this shares the CACHE ENTRY as well as the endpoint.
 * It used to fetch `?limit=100` into local state while NotificationSync
 * fetched `?limit=50` into the store — two requests, and a read marked here
 * left the bell's badge stale for up to 30 seconds because nothing told it.
 * Both now read one key, and the mutations invalidate it.
 */
export function NotificationsClient() {
  const { data, isPending, isError, error, refetch } = useNotifications(true);
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const notifications = data ?? [];
  const unread = notifications.filter((n) => !n.read).length;

  function handleMarkRead(id: string) {
    markRead.mutate(id);
  }

  function handleMarkAllRead() {
    if (unread === 0) return;
    markAllRead.mutate();
  }

  // Only a first load with nothing cached shows skeletons. Returning to the
  // page reads the cache and paints immediately, refreshing behind the rows.
  if (isPending) {
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

  // Only fatal when the retry policy has already exhausted its attempts AND
  // there is nothing cached to fall back on.
  if (isError && !data) {
    return (
      <div className="mx-auto max-w-[720px] space-y-4 p-4">
        <Card title="Notifications">
          <div className="text-center py-8 text-red-400">
            {error instanceof Error ? error.message : 'Failed to load notifications'}
          </div>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
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
            {notifications.map((n) => {
              // Same mapping as the top-bar drawer, from the same module — the
              // two surfaces must never disagree about what an alert is.
              const tier = alertTier(n);
              const r = tier ? alertRMultiple(n) : null;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => handleMarkRead(n.id)}
                    className="flex w-full items-start gap-3 py-3 text-left transition-colors duration-micro hover:bg-hover"
                  >
                    <Badge
                      tone={tier ? tier.tone : NOTIFICATION_CATEGORY_TONE[n.category]}
                      className="mt-0.5 shrink-0 px-1.5 py-0 text-[9px]"
                    >
                      {tier ? tier.label.toUpperCase() : n.category.toUpperCase()}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-text">
                        {!n.read && (
                          <span aria-hidden className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-teal" />
                        )}
                        {n.title}
                        {r !== null && (
                          <span className="ml-2 font-mono text-[11px] font-bold text-muted">{formatRMultiple(r)}</span>
                        )}
                      </p>
                      <p className="text-xs text-muted">{n.body}</p>
                      <span className="text-[11px] text-faint">{n.time}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}