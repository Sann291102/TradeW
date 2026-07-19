'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Badge, panelSlide } from '@tradew/ui';
import { useWorkspaceStore, NOTIFICATION_CATEGORY_TONE } from '@/lib/store/workspaceStore';
import { CloseIcon, InboxIcon } from './icons';

/**
 * Notification Center (Milestone 3 §10) — the architecture for Trade/Sentinel/
 * Learning/Research/Portfolio/Broker/Announcement notifications. No backend
 * yet: reads the same store-seeded list the bell badge and `/notifications`
 * page use (one source, not three copies of mock data).
 */
export function NotificationCenter() {
  const open = useWorkspaceStore((s) => s.notificationCenterOpen);
  const setOpen = useWorkspaceStore((s) => s.setNotificationCenterOpen);
  const notifications = useWorkspaceStore((s) => s.notifications);
  const markRead = useWorkspaceStore((s) => s.markNotificationRead);
  const markAllRead = useWorkspaceStore((s) => s.markAllNotificationsRead);
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            aria-label="Close notifications"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[90] bg-black/40"
          />
          <motion.aside
            role="dialog"
            aria-label="Notifications"
            variants={panelSlide}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="fixed bottom-0 right-0 top-14 z-[95] flex w-full max-w-sm flex-col overflow-hidden border-l border-border bg-card shadow-card"
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
              <InboxIcon className="h-4 w-4 text-teal" />
              <h2 className="text-sm font-bold text-text">Notifications</h2>
              {unread > 0 && (
                <Badge tone="negative" className="px-1.5 py-0 text-[9px]">
                  {unread} new
                </Badge>
              )}
              <button
                type="button"
                onClick={markAllRead}
                disabled={unread === 0}
                className="ml-auto text-[11px] font-semibold text-teal hover:underline disabled:pointer-events-none disabled:text-faint disabled:no-underline"
              >
                Mark all read
              </button>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="rounded-lg p-1 text-muted hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </header>

            <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
              {notifications.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => markRead(n.id)}
                    className="flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors duration-micro hover:bg-hover"
                  >
                    <div className="flex w-full items-center gap-2">
                      <Badge tone={NOTIFICATION_CATEGORY_TONE[n.category]} className="px-1.5 py-0 text-[9px]">
                        {n.category.toUpperCase()}
                      </Badge>
                      {!n.read && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-teal" />}
                      <span className="ml-auto text-[10px] text-faint">{n.time}</span>
                    </div>
                    <div className="text-xs font-semibold text-text">{n.title}</div>
                    <div className="text-[11px] text-muted">{n.body}</div>
                  </button>
                </li>
              ))}
            </ul>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
