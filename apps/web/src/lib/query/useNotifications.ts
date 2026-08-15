'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from '@/lib/notifications';
import { qk } from './keys';

/**
 * The notification list, fetched once and shared by the bell and the page.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * `NotificationSync` (headless, mounted in AppFrame) polled `?limit=50` every
 * 30s to feed the top-bar bell and the drawer. `/notifications` separately
 * fetched `?limit=100` into its own component state. Two requests, and worse,
 * two sources of truth: marking a notification read ON the page patched only
 * that page's local array, so the bell's unread badge kept counting it until
 * the next 30-second poll happened to come round.
 *
 * One key at the larger limit fixes both halves. The bell slices what it
 * needs; the mutations below invalidate the shared entry, so a read marked
 * anywhere is read everywhere on the next tick rather than eventually.
 */
export const NOTIFICATIONS_LIMIT = 100;
export const NOTIFICATIONS_POLL_MS = 30_000;

export function useNotifications(enabled: boolean) {
  return useQuery({
    queryKey: qk.notifications.list(NOTIFICATIONS_LIMIT),
    queryFn: () => fetchNotifications(NOTIFICATIONS_LIMIT),
    enabled,
    staleTime: NOTIFICATIONS_POLL_MS,
    refetchInterval: enabled ? NOTIFICATIONS_POLL_MS : (false as const),
  });
}

/**
 * Mark one notification read, optimistically.
 *
 * The row greys out on click rather than after the round-trip, because the
 * server's answer to "mark this read" is never interesting enough to make the
 * user wait for it. On failure the snapshot is rolled back and the invalidate
 * in `onSettled` restores whatever the server actually thinks — so a failed
 * mutation self-corrects instead of leaving the UI quietly lying.
 */
export function useMarkNotificationRead() {
  const client = useQueryClient();
  const key = qk.notifications.list(NOTIFICATIONS_LIMIT);

  return useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onMutate: async (id: string) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<NotificationItem[]>(key);
      client.setQueryData<NotificationItem[]>(key, (rows) =>
        rows?.map((n) => (n.id === id ? { ...n, read: true } : n)),
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.notifications.all });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const client = useQueryClient();
  const key = qk.notifications.list(NOTIFICATIONS_LIMIT);

  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<NotificationItem[]>(key);
      client.setQueryData<NotificationItem[]>(key, (rows) =>
        rows?.map((n) => ({ ...n, read: true })),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.notifications.all });
    },
  });
}
