import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationCategory } from '@prisma/client';

// schema.prisma defines Notification.category as the `NotificationCategory`
// Prisma enum; re-export it as the API-facing type so the allowed values stay
// in one place.
export type NotificationCategoryType = NotificationCategory;

export interface NotificationItem {
  id: string;
  category: NotificationCategoryType;
  title: string;
  body: string;
  time: string;
  read: boolean;
  /**
   * The producer's own structured payload, passed through untouched.
   *
   * Sentinel writes the alert tier here (`wait_and_watch` / `side_in_focus` /
   * `in_trade`) along with the watch it came from, and the notification bell
   * styles by that tier — without it every Sentinel alert renders identically
   * and "a condition is forming" looks the same as "your position reached the
   * level you projected".
   *
   * What may go in it is constrained at the WRITE side, not here: sentinel-py's
   * compliance guard rejects entry/stop/target keys outright
   * (app/notify/compliance.py), because a notification arrives stripped of the
   * page that explains it.
   */
  metadata: unknown;
}

@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, limit = 50): Promise<NotificationItem[]> {
    const notifications = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return notifications.map((n) => ({
      id: n.id,
      category: n.category,
      title: n.title,
      body: n.body,
      time: this.formatTime(n.createdAt),
      read: n.read,
      metadata: n.metadata ?? null,
    }));
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, read: false },
    });
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
  }

  async create(userId: string, input: {
    category: NotificationCategoryType;
    title: string;
    body: string;
  }): Promise<NotificationItem> {
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        category: input.category,
        title: input.title,
        body: input.body,
      },
    });

    return {
      id: notification.id,
      category: notification.category,
      title: notification.title,
      body: notification.body,
      time: this.formatTime(notification.createdAt),
      read: false,
      metadata: notification.metadata ?? null,
    };
  }

  private formatTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
}