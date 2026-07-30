import { BadGatewayException, Injectable } from '@nestjs/common';
import { EntitlementsService } from '../entitlements/entitlements.service';

/**
 * services/api side of the Learning Platform — the only caller of the internal
 * Sentinel learning-generation endpoints.
 *
 * Two jobs:
 *   1. Proxy the (user-independent) generated teaching material from Sentinel.
 *   2. Decide, per user, which courses are unlocked — the entitlement layer.
 *      Sentinel never sees the user's plan; access is decided here against the
 *      centralized EntitlementsService, exactly like every other premium
 *      surface.
 *
 * Access rules:
 *   • Admins unlock everything (env allowlist of emails, or the `learning_admin`
 *     entitlement override — no new role column needed).
 *   • The single free course (Trading Basics) is open to everyone.
 *   • Every other course requires the Pro capability (default `sentinel`).
 */
@Injectable()
export class LearningApiService {
  constructor(private readonly entitlements: EntitlementsService) {}

  private get baseUrl(): string {
    return (process.env.SENTINEL_SERVICE_URL ?? 'http://localhost:4010').replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-service-token': process.env.SENTINEL_SERVICE_TOKEN ?? '' };
  }

  /** Capability that unlocks premium learning. Configurable; defaults to Sentinel access. */
  private get proCapability(): string {
    return process.env.LEARNING_PRO_CAPABILITY || 'sentinel';
  }

  private get adminEmails(): string[] {
    return (process.env.LEARNING_ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  // ------------------------------------------------------------- admin + access

  /** Whether this user is a learning administrator (unlocks all + admin tools). */
  async isAdmin(userId: string, email?: string | null): Promise<boolean> {
    if (email && this.adminEmails.includes(email.toLowerCase())) return true;
    try {
      const decision = await this.entitlements.check(userId, 'learning_admin');
      return decision.allowed;
    } catch {
      return false;
    }
  }

  /** Whether the user has the premium learning capability. */
  async hasPro(userId: string): Promise<boolean> {
    try {
      const decision = await this.entitlements.check(userId, this.proCapability);
      return decision.allowed;
    } catch {
      return false;
    }
  }

  /**
   * Resolve access to one course for a user. `free` courses are always
   * allowed; admins and Pro users get everything; otherwise it is locked.
   */
  async access(
    userId: string,
    email: string | null | undefined,
    course: { id: string; free: boolean },
  ): Promise<{ allowed: boolean; reason: 'admin' | 'free' | 'pro' | 'requires_pro' }> {
    if (await this.isAdmin(userId, email)) return { allowed: true, reason: 'admin' };
    if (course.free) return { allowed: true, reason: 'free' };
    if (await this.hasPro(userId)) return { allowed: true, reason: 'pro' };
    return { allowed: false, reason: 'requires_pro' };
  }

  /** The upgrade card payload shown when a locked course is opened. */
  lockedPayload() {
    return {
      locked: true,
      title: 'Requires Sentinel Pro',
      unlocks: [
        'AI Teacher',
        'Interactive Lessons',
        'Quizzes',
        'Flashcards',
        'Strategy Library',
        'Practical Exercises',
        'Live Market Learning',
      ],
      upgradeHref: '/settings',
    };
  }

  // ----------------------------------------------------------- Sentinel proxy

  listCourses() {
    return this.get('/learning/courses');
  }
  getCourse(id: string) {
    return this.get(`/learning/courses/${encodeURIComponent(id)}`);
  }
  getLesson(lessonId: string) {
    return this.get(`/learning/lessons/${encodeURIComponent(lessonId)}`);
  }
  getQuiz(lessonId: string) {
    return this.get(`/learning/lessons/${encodeURIComponent(lessonId)}/quiz`);
  }
  getFlashcards(lessonId: string) {
    return this.get(`/learning/lessons/${encodeURIComponent(lessonId)}/flashcards`);
  }
  getCourseFlashcards(courseId: string) {
    return this.get(`/learning/courses/${encodeURIComponent(courseId)}/flashcards`);
  }
  getPractice(lessonId: string) {
    return this.get(`/learning/lessons/${encodeURIComponent(lessonId)}/practice`);
  }
  askTeacher(lessonId: string, question: string) {
    return this.post('/learning/teacher', { lessonId, question });
  }
  refreshKnowledge() {
    return this.post('/learning/refresh', {});
  }
  platformStats() {
    return this.get('/learning/platform/stats');
  }

  private async get(path: string) {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers }).catch((err) => {
      throw new BadGatewayException(`Sentinel learning service unreachable: ${err.message}`);
    });
    if (!res.ok) throw new BadGatewayException(`Sentinel learning service error: ${res.status}`);
    return res.json();
  }

  private async post(path: string, body: unknown) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    }).catch((err) => {
      throw new BadGatewayException(`Sentinel learning service unreachable: ${err.message}`);
    });
    if (!res.ok) throw new BadGatewayException(`Sentinel learning service error: ${res.status}`);
    return res.json();
  }
}
