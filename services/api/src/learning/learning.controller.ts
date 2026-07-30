import { Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { LearningApiService } from './learning.service';
import { LearningProgressService } from './learning-progress.service';

type AuthedRequest = { user: { sub: string; email?: string } };

interface CourseLite {
  id: string;
  name: string;
  free: boolean;
  lessonCount: number;
  tier: string;
  summary: string;
  lessons: { id: string; title: string; conceptId: string; order: number }[];
}

/**
 * Public Learning Platform endpoints (authenticated). Backward compatible —
 * this is a NEW `/learning` surface on services/api; existing routes are
 * untouched.
 *
 * Only AuthGuard is applied at the class level (every learner is signed in).
 * Per-course entitlement is decided inside each handler via LearningApiService,
 * because the free course must stay open while the rest is gated — a single
 * @RequiresCapability could not express "one course free, the rest premium".
 */
@UseGuards(AuthGuard)
@Controller('learning')
export class LearningController {
  constructor(
    private readonly learning: LearningApiService,
    private readonly progress: LearningProgressService,
  ) {}

  /** Course catalogue annotated with per-user lock state, admin flag and progress. */
  @Get('courses')
  async courses(@Req() req: AuthedRequest) {
    const userId = req.user.sub;
    const email = req.user.email;
    const [{ courses }, isAdmin, hasPro] = await Promise.all([
      this.learning.listCourses() as Promise<{ courses: CourseLite[] }>,
      this.learning.isAdmin(userId, email),
      this.learning.hasPro(userId),
    ]);

    const totals: Record<string, number> = {};
    for (const c of courses) totals[c.id] = c.lessonCount;
    const summary = await this.progress.summary(userId, totals);

    const annotated = courses.map((c) => {
      const allowed = isAdmin || c.free || hasPro;
      return {
        ...c,
        locked: !allowed,
        accessReason: isAdmin ? 'admin' : c.free ? 'free' : hasPro ? 'pro' : 'requires_pro',
        progress: summary.courses[c.id] ?? { completed: 0, total: c.lessonCount, pct: 0 },
      };
    });

    return {
      isAdmin,
      hasPro,
      courses: annotated,
      progress: {
        overallPct: summary.overallPct,
        streak: summary.streak,
        lastActivityAt: summary.lastActivityAt,
        continueLearning: summary.continueLearning,
      },
    };
  }

  /** A course path — or the locked/upgrade payload when the user lacks access. */
  @Get('courses/:id')
  async course(@Req() req: AuthedRequest, @Param('id') id: string) {
    const result = (await this.learning.getCourse(id)) as { found: boolean; course?: CourseLite };
    if (!result.found || !result.course) return { found: false };
    const access = await this.learning.access(req.user.sub, req.user.email, result.course);
    if (!access.allowed) return { found: true, ...this.learning.lockedPayload(), course: { id: result.course.id, name: result.course.name } };
    return { found: true, locked: false, accessReason: access.reason, course: result.course };
  }

  @Get('courses/:id/flashcards')
  async courseFlashcards(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.enforce(req, id);
    return this.learning.getCourseFlashcards(id);
  }

  @Get('lessons/:lessonId')
  async lesson(@Req() req: AuthedRequest, @Param('lessonId') lessonId: string) {
    await this.enforce(req, courseIdOf(lessonId));
    return this.learning.getLesson(lessonId);
  }

  @Get('lessons/:lessonId/quiz')
  async quiz(@Req() req: AuthedRequest, @Param('lessonId') lessonId: string) {
    await this.enforce(req, courseIdOf(lessonId));
    return this.learning.getQuiz(lessonId);
  }

  @Get('lessons/:lessonId/flashcards')
  async flashcards(@Req() req: AuthedRequest, @Param('lessonId') lessonId: string) {
    await this.enforce(req, courseIdOf(lessonId));
    return this.learning.getFlashcards(lessonId);
  }

  @Get('lessons/:lessonId/practice')
  async practice(@Req() req: AuthedRequest, @Param('lessonId') lessonId: string) {
    await this.enforce(req, courseIdOf(lessonId));
    return this.learning.getPractice(lessonId);
  }

  @Post('teacher')
  async teacher(@Req() req: AuthedRequest, @Body() body: { lessonId: string; question: string }) {
    await this.enforce(req, courseIdOf(body.lessonId));
    return this.learning.askTeacher(body.lessonId, body.question ?? '');
  }

  // --------------------------------------------------------------- progress

  @Get('progress')
  async getProgress(@Req() req: AuthedRequest) {
    const { courses } = (await this.learning.listCourses()) as { courses: CourseLite[] };
    const totals: Record<string, number> = {};
    for (const c of courses) totals[c.id] = c.lessonCount;
    return this.progress.summary(req.user.sub, totals);
  }

  @Post('progress/lesson-complete')
  async completeLesson(@Req() req: AuthedRequest, @Body() body: { lessonId: string }) {
    await this.enforce(req, courseIdOf(body.lessonId));
    await this.progress.completeLesson(req.user.sub, body.lessonId);
    return { ok: true };
  }

  @Post('progress/quiz')
  async recordQuiz(@Req() req: AuthedRequest, @Body() body: { lessonId: string; score: number; total: number }) {
    await this.enforce(req, courseIdOf(body.lessonId));
    await this.progress.recordQuiz(req.user.sub, body.lessonId, body.score, body.total);
    return { ok: true };
  }

  // ------------------------------------------------------------------ admin

  @Post('admin/refresh')
  async adminRefresh(@Req() req: AuthedRequest) {
    await this.requireAdmin(req);
    return this.learning.refreshKnowledge();
  }

  @Get('admin/stats')
  async adminStats(@Req() req: AuthedRequest) {
    await this.requireAdmin(req);
    return this.learning.platformStats();
  }

  /** Admin "Regenerate Lesson": clear the generation cache, then re-fetch. */
  @Post('admin/regenerate')
  async adminRegenerate(@Req() req: AuthedRequest, @Body() body: { lessonId: string }) {
    await this.requireAdmin(req);
    await this.learning.refreshKnowledge();
    return this.learning.getLesson(body.lessonId);
  }

  // --------------------------------------------------------------- internals

  /** Throws Forbidden (with the upgrade payload) when the user cannot access the course. */
  private async enforce(req: AuthedRequest, courseId: string): Promise<void> {
    const result = (await this.learning.getCourse(courseId)) as { found: boolean; course?: { id: string; free: boolean } };
    if (!result.found || !result.course) throw new ForbiddenException({ message: 'Unknown course', locked: true });
    const access = await this.learning.access(req.user.sub, req.user.email, result.course);
    if (!access.allowed) throw new ForbiddenException(this.learning.lockedPayload());
  }

  private async requireAdmin(req: AuthedRequest): Promise<void> {
    if (!(await this.learning.isAdmin(req.user.sub, req.user.email))) {
      throw new ForbiddenException({ message: 'Administrator access required', locked: true });
    }
  }
}

/** `courseId::conceptId` → `courseId`. */
function courseIdOf(lessonId: string): string {
  const idx = (lessonId ?? '').indexOf('::');
  return idx === -1 ? (lessonId ?? '') : lessonId.slice(0, idx);
}
