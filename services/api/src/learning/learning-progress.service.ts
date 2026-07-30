import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Per-user learning progress, persisted in the existing `UserPreference`
 * table under the key `learning.progress`.
 *
 * No migration is needed — UserPreference is a generic (userId, key, Json)
 * store with a unique (userId, key) constraint, which is exactly the shape of
 * per-user progress. This reuses infrastructure rather than adding a table for
 * a single JSON blob per user.
 *
 * Progress percentages are computed on read from the completed-lesson set plus
 * the live per-course lesson totals (supplied by the caller from the generated
 * courses), so a course that grows in the knowledge base recomputes correctly
 * without any stored count going stale.
 */
export interface StoredProgress {
  /** lessonIds the user has marked complete */
  completedLessons: string[];
  /** lessonId → last quiz result */
  quizScores: Record<string, { score: number; total: number; at: string }>;
  lastActivityAt: string | null;
  streak: { count: number; lastDayKey: string | null };
}

const PROGRESS_KEY = 'learning.progress';

const EMPTY: StoredProgress = { completedLessons: [], quizScores: {}, lastActivityAt: null, streak: { count: 0, lastDayKey: null } };

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class LearningProgressService {
  constructor(private readonly prisma: PrismaService) {}

  async raw(userId: string): Promise<StoredProgress> {
    const row = await this.prisma.userPreference.findUnique({
      where: { userId_key: { userId, key: PROGRESS_KEY } },
    });
    if (!row) return { ...EMPTY, streak: { ...EMPTY.streak } };
    return this.normalise(row.value);
  }

  /**
   * Full progress view, with per-course percentages computed against the live
   * lesson totals the caller passes in (courseId → lessonCount).
   */
  async summary(
    userId: string,
    courseTotals: Record<string, number>,
  ): Promise<{
    completedLessons: string[];
    quizScores: StoredProgress['quizScores'];
    lastActivityAt: string | null;
    streak: number;
    overallPct: number;
    courses: Record<string, { completed: number; total: number; pct: number }>;
    continueLearning: { lessonId: string; courseId: string } | null;
  }> {
    const p = await this.raw(userId);
    const completedSet = new Set(p.completedLessons);

    const courses: Record<string, { completed: number; total: number; pct: number }> = {};
    let totalLessons = 0;
    let totalCompleted = 0;
    for (const [courseId, total] of Object.entries(courseTotals)) {
      const completed = p.completedLessons.filter((id) => id.startsWith(`${courseId}::`)).length;
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      courses[courseId] = { completed, total, pct };
      totalLessons += total;
      totalCompleted += Math.min(completed, total);
    }
    const overallPct = totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0;

    // Continue-learning: the most recent quiz/lesson activity's course, first
    // incomplete lesson within it. Best-effort — the frontend can override.
    const continueLearning = this.pickContinue(p, completedSet);

    return {
      completedLessons: p.completedLessons,
      quizScores: p.quizScores,
      lastActivityAt: p.lastActivityAt,
      streak: p.streak.count,
      overallPct,
      courses,
      continueLearning,
    };
  }

  async completeLesson(userId: string, lessonId: string): Promise<StoredProgress> {
    const p = await this.raw(userId);
    if (!p.completedLessons.includes(lessonId)) p.completedLessons.push(lessonId);
    this.touch(p);
    return this.save(userId, p);
  }

  async recordQuiz(userId: string, lessonId: string, score: number, total: number): Promise<StoredProgress> {
    const p = await this.raw(userId);
    p.quizScores[lessonId] = { score: clampInt(score), total: clampInt(total), at: new Date().toISOString() };
    this.touch(p);
    return this.save(userId, p);
  }

  // ------------------------------------------------------------------- internals

  private pickContinue(p: StoredProgress, completed: Set<string>): { lessonId: string; courseId: string } | null {
    // Most recent quiz gives the active course; otherwise the last completed lesson.
    const quizEntries = Object.entries(p.quizScores).sort((a, b) => b[1].at.localeCompare(a[1].at));
    const anchor = quizEntries[0]?.[0] ?? p.completedLessons[p.completedLessons.length - 1];
    if (!anchor) return null;
    const courseId = anchor.split('::')[0];
    if (!courseId) return null;
    return { lessonId: anchor, courseId };
  }

  /** Update last-activity and roll the daily streak forward. */
  private touch(p: StoredProgress): void {
    const now = new Date();
    const today = dayKey(now);
    const last = p.streak.lastDayKey;
    if (last === today) {
      // same day — no streak change
    } else if (last && isYesterday(last, today)) {
      p.streak.count += 1;
    } else {
      p.streak.count = 1;
    }
    p.streak.lastDayKey = today;
    p.lastActivityAt = now.toISOString();
  }

  private async save(userId: string, p: StoredProgress): Promise<StoredProgress> {
    await this.prisma.userPreference.upsert({
      where: { userId_key: { userId, key: PROGRESS_KEY } },
      update: { value: p as unknown as object },
      create: { userId, key: PROGRESS_KEY, value: p as unknown as object },
    });
    return p;
  }

  private normalise(value: unknown): StoredProgress {
    const v = (value ?? {}) as Partial<StoredProgress>;
    return {
      completedLessons: Array.isArray(v.completedLessons) ? v.completedLessons.filter((x) => typeof x === 'string') : [],
      quizScores: typeof v.quizScores === 'object' && v.quizScores ? v.quizScores : {},
      lastActivityAt: typeof v.lastActivityAt === 'string' ? v.lastActivityAt : null,
      streak: {
        count: typeof v.streak?.count === 'number' ? v.streak.count : 0,
        lastDayKey: typeof v.streak?.lastDayKey === 'string' ? v.streak.lastDayKey : null,
      },
    };
  }
}

function isYesterday(prevKey: string, todayKey: string): boolean {
  const prev = new Date(`${prevKey}T00:00:00Z`).getTime();
  const today = new Date(`${todayKey}T00:00:00Z`).getTime();
  return today - prev === 86_400_000;
}

function clampInt(n: number): number {
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
