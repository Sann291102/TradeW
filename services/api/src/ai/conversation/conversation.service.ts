import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type AiConversation, type AiInputMode, type AiMessage } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PersonaService } from '../persona/persona.service';
import { nextRollAt, tradingDayDate, tradingDayFor } from './trading-day';

export interface AppendMessageInput {
  role: 'user' | 'assistant';
  content: string;
  inputMode?: AiInputMode;
  intent?: string | null;
  actions?: unknown;
  complianceVerdict?: unknown;
  provenance?: unknown;
}

/**
 * Persistent conversations with the trading-day lifecycle
 * (`AI-CONVERSATION-LIFECYCLE.md`).
 *
 * ## The roll is lazy
 *
 * There is no scheduled job. The day's thread is archived the first time the
 * user touches the assistant after 02:30 IST, which is both simpler and more
 * robust than a cron: nothing to miss if the process was down at 02:30, no
 * clock-skew window, no work done for users who aren't there. §9 of the doc
 * left this open; lazy is the choice, and the reason is here rather than in a
 * commit message.
 *
 * ## Concurrency
 *
 * `@@unique([userId, tradingDay])` is the correctness guarantee. Two requests
 * racing on the first message of the day both try to create; one wins, the
 * loser catches P2002 and reads the winner's row. The alternative — checking
 * then creating — has a window in which a user gets two threads for one day
 * and the UI silently shows half their conversation.
 */
@Injectable()
export class ConversationService {
  private readonly log = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly persona: PersonaService,
  ) {}

  /**
   * The user's thread for the current trading day, creating it if needed and
   * archiving a stale one on the way past.
   */
  async active(userId: string, now: Date = new Date()): Promise<AiConversation> {
    const day = tradingDayDate(now);

    const existing = await this.prisma.aiConversation.findUnique({
      where: { userId_tradingDay: { userId, tradingDay: day } },
    });
    if (existing) {
      // Re-activate defensively: a thread for today should not be archived,
      // but if it somehow is, resuming beats stranding the user's history.
      if (existing.status === 'archived') {
        return this.prisma.aiConversation.update({
          where: { id: existing.id },
          data: { status: 'active', archivedAt: null },
        });
      }
      return existing;
    }

    await this.archiveStale(userId, day, now);

    const personaName = await this.persona.nameFor(userId);
    try {
      return await this.prisma.aiConversation.create({
        data: { userId, tradingDay: day, personaName, status: 'active' },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Lost the race. The winner's row is the right one.
        const won = await this.prisma.aiConversation.findUnique({
          where: { userId_tradingDay: { userId, tradingDay: day } },
        });
        if (won) return won;
      }
      throw err;
    }
  }

  /**
   * Archive any active thread from an earlier trading day.
   *
   * Archive, never delete (`TRADEW-OS.md` §2.7): the row stays readable and
   * searchable, it just stops accepting writes.
   */
  private async archiveStale(userId: string, today: Date, now: Date): Promise<void> {
    const { count } = await this.prisma.aiConversation.updateMany({
      where: { userId, status: 'active', tradingDay: { lt: today } },
      data: { status: 'archived', archivedAt: now },
    });
    if (count > 0) {
      this.log.log(`rolled ${count} conversation(s) for user ${userId} into ${tradingDayFor(now)}`);
    }
  }

  /** Append a turn to the active thread and stamp `lastMessageAt`. */
  async append(
    userId: string,
    input: AppendMessageInput,
    now: Date = new Date(),
  ): Promise<AiMessage> {
    const conversation = await this.active(userId, now);
    const [message] = await this.prisma.$transaction([
      this.prisma.aiMessage.create({
        data: {
          conversationId: conversation.id,
          role: input.role,
          content: input.content,
          inputMode: input.inputMode ?? 'text',
          intent: input.intent ?? null,
          actions: (input.actions ?? undefined) as Prisma.InputJsonValue | undefined,
          complianceVerdict: (input.complianceVerdict ?? undefined) as Prisma.InputJsonValue | undefined,
          provenance: (input.provenance ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      }),
      this.prisma.aiConversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: now },
      }),
    ]);
    return message;
  }

  /**
   * The active thread with its most recent messages, for restore.
   *
   * Returns `null` when the user has not spoken today — the thread is created
   * lazily on first message, so a user who hasn't should generate no row
   * (`AI-CONVERSATION-LIFECYCLE.md` §2).
   */
  async restore(
    userId: string,
    limit = 50,
    now: Date = new Date(),
  ): Promise<{ conversation: AiConversation; messages: AiMessage[]; rollsAt: Date } | null> {
    const day = tradingDayDate(now);
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { userId_tradingDay: { userId, tradingDay: day } },
    });
    if (!conversation) {
      await this.archiveStale(userId, day, now);
      return null;
    }

    const messages = await this.prisma.aiMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return { conversation, messages: messages.reverse(), rollsAt: nextRollAt(now) };
  }

  /** Recent context for the model: the last N turns of the active thread. */
  async recentTurns(userId: string, limit = 12, now: Date = new Date()) {
    const restored = await this.restore(userId, limit, now);
    return restored?.messages ?? [];
  }

  /** Archived threads, newest first — the history view. */
  async history(userId: string, take = 30, skip = 0) {
    return this.prisma.aiConversation.findMany({
      where: { userId, status: 'archived' },
      orderBy: { tradingDay: 'desc' },
      take,
      skip,
      select: {
        id: true,
        tradingDay: true,
        personaName: true,
        startedAt: true,
        lastMessageAt: true,
        archivedAt: true,
        _count: { select: { messages: true } },
      },
    });
  }

  /**
   * Messages of one thread the caller owns.
   *
   * `userId` is part of the WHERE, not checked afterwards — an
   * ownership check that happens after the read is a check that can be
   * forgotten, and this is the query that would leak another user's
   * conversation.
   */
  async messagesOf(userId: string, conversationId: string, take = 200, skip = 0) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!conversation) return null;

    return this.prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take,
      skip,
    });
  }
}
