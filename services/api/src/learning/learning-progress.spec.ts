import { describe, expect, it } from 'vitest';
import { LearningProgressService } from './learning-progress.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Progress persistence + streak/percentage math.
 *
 * Backed by a stub PrismaService that emulates the UserPreference upsert/find
 * on an in-memory map — no database, deterministic. Verifies the exact
 * behaviours the platform depends on: completion is idempotent, quiz scores
 * persist, per-course percentages are computed from live totals, and the daily
 * streak rolls forward / resets correctly.
 */

function stubPrisma(): { prisma: PrismaService; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const key = (userId: string, k: string) => `${userId}::${k}`;
  const prisma = {
    userPreference: {
      async findUnique({ where }: { where: { userId_key: { userId: string; key: string } } }) {
        const v = store.get(key(where.userId_key.userId, where.userId_key.key));
        return v === undefined ? null : { value: v };
      },
      async upsert({ where, update, create }: { where: { userId_key: { userId: string; key: string } }; update: { value: unknown }; create: { value: unknown } }) {
        const k = key(where.userId_key.userId, where.userId_key.key);
        store.set(k, store.has(k) ? update.value : create.value);
        return { value: store.get(k) };
      },
    },
  } as unknown as PrismaService;
  return { prisma, store };
}

describe('LearningProgressService', () => {
  it('starts empty for a new user', async () => {
    const { prisma } = stubPrisma();
    const svc = new LearningProgressService(prisma);
    const p = await svc.raw('u1');
    expect(p.completedLessons).toEqual([]);
    expect(p.streak.count).toBe(0);
  });

  it('completeLesson is idempotent', async () => {
    const { prisma } = stubPrisma();
    const svc = new LearningProgressService(prisma);
    await svc.completeLesson('u1', 'price-action::breakout');
    await svc.completeLesson('u1', 'price-action::breakout');
    const p = await svc.raw('u1');
    expect(p.completedLessons).toEqual(['price-action::breakout']);
  });

  it('records quiz scores', async () => {
    const { prisma } = stubPrisma();
    const svc = new LearningProgressService(prisma);
    await svc.recordQuiz('u1', 'price-action::breakout', 2, 3);
    const p = await svc.raw('u1');
    expect(p.quizScores['price-action::breakout'].score).toBe(2);
    expect(p.quizScores['price-action::breakout'].total).toBe(3);
  });

  it('computes per-course and overall percentages from live totals', async () => {
    const { prisma } = stubPrisma();
    const svc = new LearningProgressService(prisma);
    await svc.completeLesson('u1', 'price-action::breakout');
    await svc.completeLesson('u1', 'price-action::false-breakout');
    await svc.completeLesson('u1', 'psychology::fomo');

    const summary = await svc.summary('u1', { 'price-action': 4, psychology: 2 });
    expect(summary.courses['price-action']).toEqual({ completed: 2, total: 4, pct: 50 });
    expect(summary.courses['psychology']).toEqual({ completed: 1, total: 2, pct: 50 });
    // overall = 3 completed / 6 total
    expect(summary.overallPct).toBe(50);
  });

  it('continueLearning points at the most recent activity course', async () => {
    const { prisma } = stubPrisma();
    const svc = new LearningProgressService(prisma);
    await svc.completeLesson('u1', 'trading-basics::liquidity');
    await svc.recordQuiz('u1', 'psychology::fomo', 3, 3);
    const summary = await svc.summary('u1', { 'trading-basics': 4, psychology: 2 });
    expect(summary.continueLearning?.courseId).toBe('psychology');
  });

  it('streak starts at 1 on first activity', async () => {
    const { prisma } = stubPrisma();
    const svc = new LearningProgressService(prisma);
    const p = await svc.completeLesson('u1', 'x::y');
    expect(p.streak.count).toBe(1);
  });

  it('streak stays the same on repeated same-day activity', async () => {
    const { prisma } = stubPrisma();
    const svc = new LearningProgressService(prisma);
    await svc.completeLesson('u1', 'x::a');
    const p = await svc.completeLesson('u1', 'x::b');
    expect(p.streak.count).toBe(1);
  });

  it('streak increments across a consecutive day and resets after a gap', async () => {
    const { prisma, store } = stubPrisma();
    const svc = new LearningProgressService(prisma);
    await svc.completeLesson('u1', 'x::a');

    // Rewrite the stored lastDayKey to yesterday, then act again → +1.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    mutateStreak(store, 'u1', yesterday);
    let p = await svc.completeLesson('u1', 'x::b');
    expect(p.streak.count).toBe(2);

    // Rewrite lastDayKey to 5 days ago → next activity resets to 1.
    const gap = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    mutateStreak(store, 'u1', gap);
    p = await svc.completeLesson('u1', 'x::c');
    expect(p.streak.count).toBe(1);
  });
});

function mutateStreak(store: Map<string, unknown>, userId: string, lastDayKey: string): void {
  const k = `${userId}::learning.progress`;
  const cur = store.get(k) as { streak: { count: number; lastDayKey: string } };
  cur.streak.lastDayKey = lastDayKey;
  store.set(k, cur);
}
