import { api } from './api';

export interface NotificationItem {
  id: string;
  category: 'trade' | 'sentinel' | 'learning' | 'research' | 'portfolio' | 'broker' | 'announcement';
  title: string;
  body: string;
  time: string;
  read: boolean;
}

export async function fetchNotifications(limit = 50): Promise<NotificationItem[]> {
  return api(`/notifications?limit=${limit}`);
}

export async function fetchUnreadCount(): Promise<{ count: number }> {
  return api('/notifications/unread-count');
}

export async function markNotificationRead(id: string): Promise<void> {
  await api(`/notifications/${id}/read`, { method: 'PATCH' });
}

export async function markAllNotificationsRead(): Promise<void> {
  await api('/notifications/read-all', { method: 'PATCH' });
}